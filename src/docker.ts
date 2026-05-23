import type { AppConfig } from "./config.js";
import type { SshClient } from "./ssh.js";
import { fail, formatExecError, ok, type ToolText } from "./result.js";
import {
  assertAbsolutePath,
  assertComposeProject,
  assertContainerName,
  assertMongoIdent,
  planExecCommand,
  shellQuote,
} from "./security.js";

export type { ToolText } from "./result.js";

const SECRET_KEY_RE =
  /(PASS(WORD)?|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH|SESSION)/i;

function dockerCmd(cfg: AppConfig, ...args: string[]): string {
  return [cfg.dockerBin, ...args.map(shellQuote)].join(" ");
}

function redactEnvLine(line: string): string {
  const eq = line.indexOf("=");
  if (eq < 0) return line;
  const k = line.slice(0, eq);
  if (SECRET_KEY_RE.test(k)) return `${k}=***redacted***`;
  return line;
}

export async function listContainers(
  ssh: SshClient,
  cfg: AppConfig,
  args: { all?: boolean; filter?: string[] },
): Promise<ToolText> {
  const all = args.all !== false;
  const fmt =
    "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.RunningFor}}\\t{{.Ports}}";

  const filterArgs: string[] = [];
  for (const f of args.filter ?? []) {
    if (typeof f !== "string" || /[\n\r\0]/.test(f)) {
      return fail("Invalid filter value.");
    }
    filterArgs.push("--filter", f);
  }

  const cmd = [
    cfg.dockerBin,
    "ps",
    all ? "-a" : "",
    "--no-trunc",
    ...filterArgs.map(shellQuote),
    "--format",
    shellQuote(fmt),
  ]
    .filter(Boolean)
    .join(" ");

  const r = await ssh.exec(cmd, { timeoutMs: 30_000 });
  if (r.code !== 0) return fail(formatExecError("docker ps", r));

  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return ok("No containers found.");

  const rows = lines.map((line) => {
    const [id, names, image, status, runningFor, ports] = line.split("\t");
    return {
      id: id?.slice(0, 12) ?? "",
      names: names ?? "",
      image: image ?? "",
      status: status ?? "",
      runningFor: runningFor ?? "",
      ports: ports ?? "",
    };
  });

  return ok(JSON.stringify({ count: rows.length, containers: rows }, null, 2));
}

export async function containerLogs(
  ssh: SshClient,
  cfg: AppConfig,
  args: {
    container: string;
    tail?: number;
    since?: string;
    timestamps?: boolean;
  },
): Promise<ToolText> {
  const name = assertContainerName(args.container);
  const tail = Math.min(Math.max(args.tail ?? 200, 1), 5000);
  const parts = [cfg.dockerBin, "logs", "--tail", String(tail)];
  if (args.timestamps) parts.push("--timestamps");
  if (args.since) {
    if (!/^[\w:.+-]{1,40}$/.test(args.since)) {
      return fail("Invalid 'since' value.");
    }
    parts.push("--since", shellQuote(args.since));
  }
  parts.push(shellQuote(name));

  const r = await ssh.exec(parts.join(" "), { timeoutMs: 60_000 });

  const body = [
    r.stdout.trim() ? r.stdout : "",
    r.stderr.trim() ? `\n--- stderr ---\n${r.stderr}` : "",
  ]
    .join("")
    .trim();

  if (r.code !== 0 && !body) return fail(formatExecError("docker logs", r));
  return ok(body || "(no log output)");
}

export async function containerProcesses(
  ssh: SshClient,
  cfg: AppConfig,
  args: { container: string },
): Promise<ToolText> {
  const name = assertContainerName(args.container);
  const r = await ssh.exec(dockerCmd(cfg, "top", name), { timeoutMs: 20_000 });
  if (r.code !== 0) return fail(formatExecError("docker top", r));
  return ok(r.stdout.trim() || "(no processes)");
}

export async function containerStats(
  ssh: SshClient,
  cfg: AppConfig,
  args: { container: string },
): Promise<ToolText> {
  const name = assertContainerName(args.container);
  const fmt =
    "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}\\t{{.PIDs}}";
  const cmd = [
    cfg.dockerBin,
    "stats",
    "--no-stream",
    "--format",
    shellQuote(fmt),
    shellQuote(name),
  ].join(" ");
  const r = await ssh.exec(cmd, { timeoutMs: 20_000 });
  if (r.code !== 0) return fail(formatExecError("docker stats", r));

  const line = r.stdout.trim();
  if (!line) return ok("(no stats)");
  const [container, cpu, mem, memPct, net, block, pids] = line.split("\t");
  return ok(
    JSON.stringify(
      {
        container,
        cpu_percent: cpu,
        memory: mem,
        memory_percent: memPct,
        network_io: net,
        block_io: block,
        pids,
      },
      null,
      2,
    ),
  );
}

export async function containerInspect(
  ssh: SshClient,
  cfg: AppConfig,
  args: { container: string },
): Promise<ToolText> {
  const name = assertContainerName(args.container);
  const r = await ssh.exec(dockerCmd(cfg, "inspect", name), {
    timeoutMs: 20_000,
  });
  if (r.code !== 0) return fail(formatExecError("docker inspect", r));

  try {
    const parsed = JSON.parse(r.stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!first) return ok("(no inspect data)");

    if (first?.Config?.Env && Array.isArray(first.Config.Env)) {
      first.Config.Env = first.Config.Env.map(redactEnvLine);
    }

    return ok(JSON.stringify(first, null, 2));
  } catch {
    return ok(r.stdout);
  }
}

export async function execCommand(
  ssh: SshClient,
  cfg: AppConfig,
  args: {
    container: string;
    command: string;
    args?: string[];
    workdir?: string;
  },
): Promise<ToolText> {
  const name = assertContainerName(args.container);
  const plan = planExecCommand(
    { command: args.command, args: args.args },
    cfg.execExtraAllowed,
  );

  const parts = [cfg.dockerBin, "exec"];
  if (args.workdir) {
    parts.push("--workdir", shellQuote(assertAbsolutePath(args.workdir)));
  }
  parts.push(shellQuote(name), shellQuote(plan.bin));
  for (const a of plan.args) parts.push(shellQuote(a));

  const r = await ssh.exec(parts.join(" "), { timeoutMs: 60_000 });
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

export async function dockerComposeStatus(
  ssh: SshClient,
  cfg: AppConfig,
  args: { project?: string; cwd?: string },
): Promise<ToolText> {
  const cwd = args.cwd ?? cfg.defaultComposeDir;
  const project = args.project ?? cfg.defaultComposeProject;

  if (!cwd) {
    return fail(
      "docker_compose_status: pass `cwd` or set DEFAULT_COMPOSE_DIR.",
    );
  }
  const safeCwd = assertAbsolutePath(cwd);

  const composeArgs = ["compose"];
  if (project) composeArgs.push("-p", assertComposeProject(project));
  composeArgs.push("ps", "--format", "json");

  const cmd = `cd ${shellQuote(safeCwd)} && ${cfg.dockerBin} ${composeArgs
    .map(shellQuote)
    .join(" ")}`;

  const r = await ssh.exec(cmd, { timeoutMs: 30_000 });
  if (r.code !== 0) return fail(formatExecError("docker compose ps", r));

  const text = r.stdout.trim();
  if (!text) return ok("(no services)");

  // docker compose emits either a JSON array or NDJSON depending on version.
  try {
    const parsed = text.startsWith("[")
      ? JSON.parse(text)
      : text
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
    return ok(JSON.stringify(parsed, null, 2));
  } catch {
    return ok(text);
  }
}

export async function checkDbActivity(
  ssh: SshClient,
  cfg: AppConfig,
  args: {
    container?: string;
    uri?: string;
    db?: string;
    collections?: string[];
    sinceMinutes?: number;
  },
): Promise<ToolText> {
  const container = assertContainerName(args.container ?? cfg.mongoContainer);
  if (!container) {
    return fail(
      "check_db_activity: no mongo container configured (set MONGO_CONTAINER or pass `container`).",
    );
  }

  const uri = args.uri ?? cfg.mongoUri;
  const db = assertMongoIdent(args.db ?? cfg.mongoDb);
  if (!db) return fail("check_db_activity: db is required.");

  const collections = (args.collections ?? cfg.mongoCollections).map(
    assertMongoIdent,
  );
  if (collections.length === 0) {
    return fail(
      "check_db_activity: no collections specified and MONGO_COLLECTIONS is empty.",
    );
  }

  const sinceMinutes = Math.min(
    Math.max(args.sinceMinutes ?? 60, 1),
    24 * 60 * 7,
  );

  // Inject values as a single JSON literal so the embedded mongosh script does
  // no string-concat — keeps quoting safe.
  const payload = JSON.stringify({ db, collections, sinceMinutes });
  const script = `
    const cfg = ${payload};
    const since = new Date(Date.now() - cfg.sinceMinutes * 60 * 1000);
    const out = { db: cfg.db, sinceMinutes: cfg.sinceMinutes, since: since.toISOString(), collections: [] };
    const d = db.getSiblingDB(cfg.db);
    for (const name of cfg.collections) {
      try {
        const c = d.getCollection(name);
        const total = c.estimatedDocumentCount();
        const recentCreated = c.countDocuments({ createdAt: { $gte: since } }, { limit: 100000 });
        const recentUpdated = c.countDocuments({ updatedAt: { $gte: since } }, { limit: 100000 });
        const lastDoc = c.find().sort({ _id: -1 }).limit(1).toArray()[0];
        let lastTs = null;
        if (lastDoc && lastDoc._id && lastDoc._id.getTimestamp) {
          try { lastTs = lastDoc._id.getTimestamp().toISOString(); } catch (e) {}
        }
        out.collections.push({ name, estimated_count: total, recent_created: recentCreated, recent_updated: recentUpdated, last_insert_ts: lastTs });
      } catch (e) {
        out.collections.push({ name, error: String(e && e.message || e) });
      }
    }
    print(JSON.stringify(out));
  `.trim();

  const cmd = [
    cfg.dockerBin,
    "exec",
    "-i",
    shellQuote(container),
    "mongosh",
    "--quiet",
    shellQuote(uri),
    "--eval",
    shellQuote(script),
  ].join(" ");

  const r = await ssh.exec(cmd, { timeoutMs: 30_000 });
  if (r.code !== 0) return fail(formatExecError("mongosh", r));

  const lines = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        return ok(JSON.stringify(JSON.parse(line), null, 2));
      } catch {
        /* fall through */
      }
    }
  }
  return ok(r.stdout.trim() || "(no output)");
}
