#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type AppConfig, loadConfig } from "./config.js";
import { SshClient } from "./ssh.js";
import {
  checkDbActivity,
  containerInspect,
  containerLogs,
  containerProcesses,
  containerStats,
  dockerComposeStatus,
  execCommand,
  listContainers,
  type ToolText,
} from "./docker.js";
import {
  caddyConfig,
  hostCheckPort,
  hostExec,
  hostJournal,
  hostListeningPorts,
  hostProcesses,
  hostReadFile,
  hostStats,
  hostSystemdStatus,
  nginxConfig,
} from "./host.js";

function errorResult(e: unknown): ToolText {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function main() {
  const cfg = loadConfig();
  const ssh = new SshClient(cfg.ssh);

  const server = new McpServer({
    name: "host-mcp",
    version: "0.2.0",
  });

  if (cfg.dockerEnabled) registerDockerTools(server, ssh, cfg);
  registerHostTools(server, ssh, cfg);
  if (cfg.nginxEnabled) registerNginxTools(server, ssh, cfg);
  if (cfg.caddyEnabled) registerCaddyTools(server, ssh, cfg);

  const enabled: string[] = [];
  if (cfg.dockerEnabled) enabled.push("docker");
  enabled.push("host");
  if (cfg.nginxEnabled) enabled.push("nginx");
  if (cfg.caddyEnabled) enabled.push("caddy");
  console.error(
    `[host-mcp] ready, tool groups: ${enabled.join(", ")}`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await ssh.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function registerDockerTools(
  server: McpServer,
  ssh: SshClient,
  cfg: AppConfig,
) {
  const defaultsHint = cfg.defaultContainers.length
    ? ` Default containers: ${cfg.defaultContainers.join(", ")}.`
    : "";

  server.registerTool(
    "list_containers",
    {
      title: "List Docker containers",
      description:
        "List Docker containers on the remote host (running and stopped by default) with id, name, image, status, uptime, and ports." +
        defaultsHint,
      inputSchema: {
        all: z
          .boolean()
          .optional()
          .describe(
            "Include stopped containers. Default true. Set false to list only running.",
          ),
        filter: z
          .array(z.string())
          .optional()
          .describe(
            "Optional docker ps --filter values, e.g. ['status=running','name=worker'].",
          ),
      },
    },
    async (args) => {
      try {
        return await listContainers(ssh, cfg, args ?? {});
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "container_logs",
    {
      title: "Recent container logs",
      description:
        "Fetch recent stdout+stderr from a container. Use `tail` to cap lines (default 200) and `since` for a duration (e.g. '10m', '2h') or a timestamp.",
      inputSchema: {
        container: z.string().describe("Container name or id."),
        tail: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("Lines from the tail. Default 200, max 5000."),
        since: z
          .string()
          .optional()
          .describe(
            "Duration like '10m', '2h', or an RFC3339 timestamp. Filters older lines.",
          ),
        timestamps: z
          .boolean()
          .optional()
          .describe("Prefix each line with the docker-recorded timestamp."),
      },
    },
    async (args) => {
      try {
        return await containerLogs(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "container_processes",
    {
      title: "Processes inside container",
      description:
        "Run `docker top` against a container to see the processes running inside it.",
      inputSchema: {
        container: z.string().describe("Container name or id."),
      },
    },
    async (args) => {
      try {
        return await containerProcesses(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "container_stats",
    {
      title: "Container CPU / memory / IO snapshot",
      description:
        "Single-shot `docker stats` snapshot (CPU%, memory, network IO, block IO, pids).",
      inputSchema: {
        container: z.string().describe("Container name or id."),
      },
    },
    async (args) => {
      try {
        return await containerStats(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "container_inspect",
    {
      title: "Full container inspect",
      description:
        "Return `docker inspect` for a container. Secret-looking env values (PASSWORD/SECRET/TOKEN/KEY/...) are redacted before returning.",
      inputSchema: {
        container: z.string().describe("Container name or id."),
      },
    },
    async (args) => {
      try {
        return await containerInspect(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "exec_command",
    {
      title: "Run a read-only command inside a container",
      description:
        "Run a single allowlisted command inside a container via `docker exec`. " +
        "Only a fixed read-only set is permitted (ls, cat, ps, df, env, grep, find, curl, ...). " +
        "The first arg is the binary; remaining args are passed safely-quoted. " +
        "No shells, pipes, redirects, or command chaining.",
      inputSchema: {
        container: z.string().describe("Container name or id."),
        command: z
          .string()
          .describe(
            "Command to run, a single token (e.g. 'ls', 'cat'). Must be on the allowlist.",
          ),
        args: z
          .array(z.string())
          .optional()
          .describe("Positional arguments. Shell metacharacters are rejected."),
        workdir: z
          .string()
          .optional()
          .describe(
            "Absolute path to use as working directory inside the container.",
          ),
      },
    },
    async (args) => {
      try {
        return await execCommand(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "docker_compose_status",
    {
      title: "docker compose ps for a project",
      description:
        "Run `docker compose ps --format json` inside a project directory. " +
        "Pass `cwd` (absolute path) and optionally `project`. " +
        "Falls back to DEFAULT_COMPOSE_DIR / DEFAULT_COMPOSE_PROJECT when omitted.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe(
            "Absolute path to the compose project directory. Defaults to DEFAULT_COMPOSE_DIR.",
          ),
        project: z
          .string()
          .optional()
          .describe(
            "Override the compose project name (-p). Defaults to DEFAULT_COMPOSE_PROJECT or directory name.",
          ),
      },
    },
    async (args) => {
      try {
        return await dockerComposeStatus(ssh, cfg, args ?? {});
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "check_db_activity",
    {
      title: "MongoDB recent-activity probe",
      description:
        "Run mongosh inside the configured Mongo container and report, per collection: " +
        "estimated document count, count of docs with createdAt or updatedAt in the last N minutes, " +
        "and the ObjectId-derived timestamp of the most recent insert. " +
        "Useful as a quick 'is the app writing?' health check.",
      inputSchema: {
        container: z
          .string()
          .optional()
          .describe("Container that has mongosh. Defaults to MONGO_CONTAINER."),
        uri: z
          .string()
          .optional()
          .describe(
            "Mongo connection URI as resolved from inside the container. Defaults to MONGO_URI.",
          ),
        db: z
          .string()
          .optional()
          .describe("Database name. Defaults to MONGO_DB."),
        collections: z
          .array(z.string())
          .optional()
          .describe("Collections to probe. Defaults to MONGO_COLLECTIONS."),
        sinceMinutes: z
          .number()
          .int()
          .min(1)
          .max(60 * 24 * 7)
          .optional()
          .describe(
            "Look-back window in minutes for createdAt/updatedAt counts. Default 60.",
          ),
      },
    },
    async (args) => {
      try {
        return await checkDbActivity(ssh, cfg, args ?? {});
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

function registerHostTools(
  server: McpServer,
  ssh: SshClient,
  cfg: AppConfig,
) {
  server.registerTool(
    "host_stats",
    {
      title: "Host CPU / memory / disk / OS snapshot",
      description:
        "One-shot snapshot of the remote host: `uname -a`, `uptime`, load average, CPU count, `free -h` (or `vm_stat` on macOS), `df -h`, and `/etc/os-release`. Does not require Docker.",
      inputSchema: {},
    },
    async () => {
      try {
        return await hostStats(ssh, cfg);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "host_processes",
    {
      title: "Top processes on the host",
      description:
        "Top processes on the remote host, sorted by CPU (default) or memory. Returns pid, user, %cpu, %mem, vsz, rss, etime, command.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Number of processes to return. Default 20, max 200."),
        sortBy: z
          .enum(["cpu", "memory"])
          .optional()
          .describe("Sort key. Default 'cpu'."),
      },
    },
    async (args) => {
      try {
        return await hostProcesses(ssh, cfg, args ?? {});
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "host_listening_ports",
    {
      title: "Listening sockets on the host",
      description:
        "`ss -tln` (or `netstat -ln` fallback) — listening sockets on the host. Filter by protocol with `proto`.",
      inputSchema: {
        proto: z
          .enum(["tcp", "udp", "both"])
          .optional()
          .describe("Protocol filter. Default 'tcp'."),
      },
    },
    async (args) => {
      try {
        return await hostListeningPorts(ssh, cfg, args ?? {});
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "host_systemd_status",
    {
      title: "systemctl status for a unit",
      description:
        "`systemctl status <unit> --no-pager` for a single systemd unit (e.g. 'nginx.service', 'cron.timer'). Unit name is validated.",
      inputSchema: {
        unit: z
          .string()
          .describe("Systemd unit name, e.g. 'nginx.service' or 'cron.timer'."),
        lines: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe("Trailing log lines to include. Default 20."),
      },
    },
    async (args) => {
      try {
        return await hostSystemdStatus(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "host_journal",
    {
      title: "journalctl tail",
      description:
        "Recent entries from `journalctl`. Optionally filter by `unit`, `since` (duration or timestamp), and `priority` (syslog severity 0..7).",
      inputSchema: {
        unit: z
          .string()
          .optional()
          .describe("Restrict to a single systemd unit."),
        lines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("Lines from the tail. Default 200."),
        since: z
          .string()
          .optional()
          .describe(
            "Duration like '10m', '2h', or a timestamp like '2025-01-01 12:00:00'.",
          ),
        priority: z
          .number()
          .int()
          .min(0)
          .max(7)
          .optional()
          .describe("Syslog severity ceiling (0=emerg..7=debug)."),
      },
    },
    async (args) => {
      try {
        return await hostJournal(ssh, cfg, args ?? {});
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "host_exec",
    {
      title: "Run a read-only command on the host",
      description:
        "Run a single allowlisted command on the remote host (not inside a container). " +
        "Same allowlist and metacharacter rules as `exec_command`. " +
        "Extend via EXEC_EXTRA_ALLOWED.",
      inputSchema: {
        command: z
          .string()
          .describe(
            "Command to run, a single token (e.g. 'ls', 'cat'). Must be on the allowlist.",
          ),
        args: z
          .array(z.string())
          .optional()
          .describe("Positional arguments. Shell metacharacters are rejected."),
        workdir: z
          .string()
          .optional()
          .describe("Absolute path to use as working directory."),
      },
    },
    async (args) => {
      try {
        return await hostExec(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "host_check_port",
    {
      title: "Check TCP port reachability",
      description:
        "Probe one or more TCP ports for reachability. Defaults to host '127.0.0.1' (does the local service listen?); pass `host` for an outbound connectivity check from the remote. Uses `nc -z` when available, falls back to bash /dev/tcp. Returns one {port,status} entry per port (status = open / closed).",
      inputSchema: {
        ports: z
          .array(z.number().int().min(1).max(65535))
          .min(1)
          .max(50)
          .describe("TCP ports to probe. Max 50 per call."),
        host: z
          .string()
          .optional()
          .describe(
            "Target hostname or IPv4. Defaults to '127.0.0.1' (probe the remote itself).",
          ),
        timeoutSec: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("Per-port connect timeout in seconds. Default 3."),
      },
    },
    async (args) => {
      try {
        return await hostCheckPort(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "host_read_file",
    {
      title: "Read a file from the host",
      description:
        "Read up to `READ_FILE_MAX_BYTES` (default 1 MiB) from a file on the remote host. " +
        "The path must lie under one of `READ_FILE_ALLOWED_PREFIXES`; with no prefixes configured the tool is disabled.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to read. Must lie under READ_FILE_ALLOWED_PREFIXES.",
          ),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Cap the read at this many bytes. Defaults to READ_FILE_MAX_BYTES and cannot exceed it.",
          ),
      },
    },
    async (args) => {
      try {
        return await hostReadFile(ssh, cfg, args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

function registerNginxTools(
  server: McpServer,
  ssh: SshClient,
  cfg: AppConfig,
) {
  server.registerTool(
    "nginx_config",
    {
      title: "nginx -T (dump + validate config)",
      description:
        "Run `nginx -T` on the remote host. Dumps the effective configuration AND validates it; failures are returned as the tool error. Set NGINX_BIN to e.g. 'sudo nginx' if the SSH user lacks privileges.",
      inputSchema: {},
    },
    async () => {
      try {
        return await nginxConfig(ssh, cfg, {});
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

function registerCaddyTools(
  server: McpServer,
  ssh: SshClient,
  cfg: AppConfig,
) {
  server.registerTool(
    "caddy_config",
    {
      title: "Caddy running config (via admin API)",
      description:
        "GET /config/ from Caddy's admin API (default http://localhost:2019). Returns the full active configuration as JSON. Override with CADDY_ADMIN_URL.",
      inputSchema: {},
    },
    async () => {
      try {
        return await caddyConfig(ssh, cfg, {});
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

main().catch((err) => {
  // stdout is reserved for JSON-RPC frames, so fatals go to stderr.
  console.error("[host-mcp] fatal:", err);
  process.exit(1);
});
