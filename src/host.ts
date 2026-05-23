import type { AppConfig } from "./config.js";
import type { SshClient } from "./ssh.js";
import { fail, formatExecError, ok, type ToolText } from "./result.js";
import {
  assertAbsolutePath,
  assertHostname,
  assertPort,
  assertReadablePath,
  assertSystemdUnit,
  planExecCommand,
  shellQuote,
} from "./security.js";

const SECTION = (name: string) => `\n===== ${name} =====\n`;

export async function hostStats(
  ssh: SshClient,
  _cfg: AppConfig,
): Promise<ToolText> {
  // Run a fixed bundle of read-only commands in one SSH round-trip.
  // Each is forgiving (|| true / 2>/dev/null) so missing utilities don't
  // collapse the whole call.
  const script = [
    `echo "${SECTION("uname").trim()}"; uname -a 2>/dev/null || true`,
    `echo "${SECTION("uptime").trim()}"; uptime 2>/dev/null || true`,
    `echo "${SECTION("loadavg").trim()}"; cat /proc/loadavg 2>/dev/null || true`,
    `echo "${SECTION("cpu").trim()}"; nproc 2>/dev/null || true`,
    `echo "${SECTION("memory").trim()}"; free -h 2>/dev/null || vm_stat 2>/dev/null || true`,
    `echo "${SECTION("disk").trim()}"; df -h -x tmpfs -x devtmpfs 2>/dev/null || df -h 2>/dev/null || true`,
    `echo "${SECTION("os-release").trim()}"; cat /etc/os-release 2>/dev/null || true`,
  ].join("; ");

  const r = await ssh.exec(script, { timeoutMs: 20_000 });
  if (r.code !== 0 && !r.stdout.trim()) {
    return fail(formatExecError("host_stats", r));
  }
  return ok(r.stdout.trim() || "(no output)");
}

export async function hostProcesses(
  ssh: SshClient,
  _cfg: AppConfig,
  args: { limit?: number; sortBy?: "cpu" | "memory" },
): Promise<ToolText> {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
  const sortKey = args.sortBy === "memory" ? "pmem" : "pcpu";
  const cmd =
    `ps -eo pid,user,pcpu,pmem,vsz,rss,etime,cmd --sort=-${sortKey} 2>/dev/null | head -n ${limit + 1}`;

  const r = await ssh.exec(cmd, { timeoutMs: 15_000 });
  if (r.code !== 0) return fail(formatExecError("host_processes", r));
  return ok(r.stdout.trim() || "(no processes)");
}

export async function hostListeningPorts(
  ssh: SshClient,
  _cfg: AppConfig,
  args: { proto?: "tcp" | "udp" | "both" },
): Promise<ToolText> {
  const proto = args.proto ?? "tcp";
  const flag =
    proto === "tcp" ? "-tlnH" : proto === "udp" ? "-ulnH" : "-tulnH";
  // ss is preferred; fall back to netstat where ss is missing.
  const cmd = `ss ${flag} 2>/dev/null || netstat -ln 2>/dev/null`;
  const r = await ssh.exec(cmd, { timeoutMs: 15_000 });
  if (r.code !== 0 && !r.stdout.trim()) {
    return fail(formatExecError("host_listening_ports", r));
  }
  return ok(r.stdout.trim() || "(no listeners)");
}

export async function hostSystemdStatus(
  ssh: SshClient,
  _cfg: AppConfig,
  args: { unit: string; lines?: number },
): Promise<ToolText> {
  const unit = assertSystemdUnit(args.unit);
  const lines = Math.min(Math.max(args.lines ?? 20, 0), 500);
  const cmd = `systemctl status ${shellQuote(unit)} --no-pager --lines=${lines}`;
  const r = await ssh.exec(cmd, { timeoutMs: 15_000 });
  // systemctl returns non-zero for inactive/failed units; show output anyway.
  const body = r.stdout.trim() || r.stderr.trim();
  if (!body) return fail(formatExecError("host_systemd_status", r));
  return ok(body);
}

export async function hostJournal(
  ssh: SshClient,
  _cfg: AppConfig,
  args: {
    unit?: string;
    lines?: number;
    since?: string;
    priority?: number;
  },
): Promise<ToolText> {
  const lines = Math.min(Math.max(args.lines ?? 200, 1), 5000);
  const parts = [
    "journalctl",
    "--no-pager",
    "--output=short-iso",
    `-n ${lines}`,
  ];
  if (args.unit) parts.push("-u", shellQuote(assertSystemdUnit(args.unit)));
  if (args.since) {
    if (!/^[\w :.+-]{1,40}$/.test(args.since)) {
      return fail("Invalid 'since' value.");
    }
    parts.push("--since", shellQuote(args.since));
  }
  if (args.priority !== undefined) {
    if (
      !Number.isInteger(args.priority) ||
      args.priority < 0 ||
      args.priority > 7
    ) {
      return fail("priority must be an integer 0..7 (syslog severity).");
    }
    parts.push(`-p ${args.priority}`);
  }

  const r = await ssh.exec(parts.join(" "), { timeoutMs: 30_000 });
  if (r.code !== 0 && !r.stdout.trim()) {
    return fail(formatExecError("host_journal", r));
  }
  return ok(r.stdout.trim() || "(no journal entries)");
}

export async function hostExec(
  ssh: SshClient,
  cfg: AppConfig,
  args: { command: string; args?: string[]; workdir?: string },
): Promise<ToolText> {
  const plan = planExecCommand(
    { command: args.command, args: args.args },
    cfg.execExtraAllowed,
  );

  const parts = [shellQuote(plan.bin), ...plan.args.map(shellQuote)];
  let cmd = parts.join(" ");
  if (args.workdir) {
    cmd = `cd ${shellQuote(assertAbsolutePath(args.workdir))} && ${cmd}`;
  }

  const r = await ssh.exec(cmd, { timeoutMs: 60_000 });
  const body = [
    r.stdout,
    r.stderr.trim() ? `\n--- stderr ---\n${r.stderr}` : "",
  ]
    .join("")
    .trim();

  const header = `exit ${r.code ?? "?"}${
    r.signal ? `, signal ${r.signal}` : ""
  }`;
  return r.code === 0
    ? ok(`${header}\n${body}`)
    : fail(`${header}\n${body || "(no output)"}`);
}

export async function hostReadFile(
  ssh: SshClient,
  cfg: AppConfig,
  args: { path: string; maxBytes?: number },
): Promise<ToolText> {
  const path = assertReadablePath(args.path, cfg.readFileAllowedPrefixes);
  const cap = Math.min(
    Math.max(args.maxBytes ?? cfg.readFileMaxBytes, 1),
    cfg.readFileMaxBytes,
  );
  const cmd = `head -c ${cap} ${shellQuote(path)}`;
  const r = await ssh.exec(cmd, { timeoutMs: 30_000 });
  if (r.code !== 0) return fail(formatExecError("host_read_file", r));
  return ok(r.stdout);
}

export async function nginxConfig(
  ssh: SshClient,
  cfg: AppConfig,
  _args: Record<string, never>,
): Promise<ToolText> {
  // nginx -T dumps the effective config AND validates it; merge both streams
  // since the validation summary lands on stderr.
  const cmd = `${cfg.nginxBin} -T 2>&1`;
  const r = await ssh.exec(cmd, { timeoutMs: 30_000 });
  if (r.code !== 0) return fail(formatExecError("nginx -T", r));
  return ok(r.stdout.trim() || "(empty config)");
}

export async function hostCheckPort(
  ssh: SshClient,
  _cfg: AppConfig,
  args: { ports: number[]; host?: string; timeoutSec?: number },
): Promise<ToolText> {
  if (!Array.isArray(args.ports) || args.ports.length === 0) {
    return fail("ports must be a non-empty array of integers.");
  }
  if (args.ports.length > 50) {
    return fail("Up to 50 ports per call.");
  }
  const ports = args.ports.map(assertPort);
  const host = args.host ? assertHostname(args.host) : "127.0.0.1";
  const timeoutSec = Math.min(Math.max(args.timeoutSec ?? 3, 1), 30);
  const portList = ports.join(" ");

  // Tries `nc -z` first (more universal), falls back to bash /dev/tcp.
  // Either branch prints `<port> open|closed` per probed port.
  const script = [
    `H=${shellQuote(host)}`,
    `T=${timeoutSec}`,
    `if command -v nc >/dev/null 2>&1; then USE_NC=1; else USE_NC=0; fi`,
    `for p in ${portList}; do`,
    `  if [ "$USE_NC" = "1" ]; then`,
    `    nc -z -w "$T" "$H" "$p" >/dev/null 2>&1 && echo "$p open" || echo "$p closed"`,
    `  else`,
    `    timeout "$T" bash -c "exec 3<>/dev/tcp/$H/$p" >/dev/null 2>&1 && echo "$p open" || echo "$p closed"`,
    `  fi`,
    `done`,
  ].join("\n");

  const r = await ssh.exec(script, {
    timeoutMs: (timeoutSec + 2) * 1000 * ports.length + 5_000,
  });
  if (r.code !== 0 && !r.stdout.trim()) {
    return fail(formatExecError("host_check_port", r));
  }

  const results = r.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [portStr, status] = line.trim().split(/\s+/);
      return { port: Number(portStr), status: status || "unknown" };
    });

  return ok(
    JSON.stringify({ host, timeout_sec: timeoutSec, results }, null, 2),
  );
}

export async function caddyConfig(
  ssh: SshClient,
  cfg: AppConfig,
  _args: Record<string, never>,
): Promise<ToolText> {
  const url = cfg.caddyAdminUrl.replace(/\/$/, "") + "/config/";
  // -w prints a sentinel line we can split off to recover the HTTP status,
  // independent of the body's structure.
  const cmd = `curl -s -m 10 -w "\\n___CADDY_HTTP_STATUS___:%{http_code}" ${shellQuote(url)}`;
  const r = await ssh.exec(cmd, { timeoutMs: 15_000 });
  if (r.code !== 0) return fail(formatExecError("curl caddy admin", r));

  const sentinel = r.stdout.match(/\n___CADDY_HTTP_STATUS___:(\d+)$/);
  const status = sentinel ? Number(sentinel[1]) : 0;
  const body = sentinel
    ? r.stdout.slice(0, r.stdout.length - sentinel[0].length)
    : r.stdout;

  if (status !== 200) {
    return fail(
      `Caddy admin API at ${url} returned HTTP ${status || "?"}.` +
        (body ? `\n\n${body.slice(0, 4000)}` : "") +
        "\n\nIs Caddy running and is its admin endpoint reachable? " +
        "Override with CADDY_ADMIN_URL if it lives elsewhere.",
    );
  }

  try {
    return ok(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    return ok(body);
  }
}
