export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const MONGO_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;
const SYSTEMD_UNIT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const ARG_BLOCK_RE = /[`$\\\n\r\0;|&><]/;

export function assertContainerName(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 253) {
    throw new Error("Invalid container identifier (empty or too long).");
  }
  if (!CONTAINER_RE.test(name)) {
    throw new Error(
      `Invalid container identifier: ${JSON.stringify(name)}. ` +
        "Must match [a-zA-Z0-9][a-zA-Z0-9_.-]*",
    );
  }
  return name;
}

export function assertComposeProject(name: string): string {
  return assertContainerName(name);
}

export function assertMongoIdent(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 120) {
    throw new Error("Invalid Mongo identifier (empty or too long).");
  }
  if (!MONGO_IDENT_RE.test(name)) {
    throw new Error(
      `Invalid Mongo identifier: ${JSON.stringify(name)}. ` +
        "Must match [a-zA-Z_][a-zA-Z0-9_.-]*",
    );
  }
  return name;
}

export function assertHostname(h: string): string {
  if (typeof h !== "string" || h.length === 0 || h.length > 253) {
    throw new Error("Invalid hostname (empty or too long).");
  }
  if (!HOSTNAME_RE.test(h)) {
    throw new Error(
      `Invalid hostname: ${JSON.stringify(h)}. ` +
        "Must be alphanumeric with dots/dashes (no spaces, no scheme, no port).",
    );
  }
  return h;
}

export function assertPort(p: number): number {
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`Invalid port: ${p}. Must be integer 1..65535.`);
  }
  return p;
}

export function assertSystemdUnit(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) {
    throw new Error("Invalid systemd unit name (empty or too long).");
  }
  if (!SYSTEMD_UNIT_RE.test(name)) {
    throw new Error(
      `Invalid systemd unit: ${JSON.stringify(name)}. ` +
        "Must match [a-zA-Z0-9][a-zA-Z0-9._@-]*",
    );
  }
  return name;
}

export function assertAbsolutePath(p: string): string {
  if (typeof p !== "string" || !p.startsWith("/")) {
    throw new Error("Path must be absolute.");
  }
  if (/[\n\r\0]/.test(p)) {
    throw new Error("Path contains illegal characters.");
  }
  return p;
}

export function assertReadablePath(
  p: string,
  allowedPrefixes: readonly string[],
): string {
  const path = assertAbsolutePath(p);
  if (path.includes("/..") || path.includes("../") || path.endsWith("/..")) {
    throw new Error("Path must not contain '..' segments.");
  }
  if (allowedPrefixes.length === 0) {
    throw new Error(
      "host_read_file is disabled. Set READ_FILE_ALLOWED_PREFIXES in the environment to enable.",
    );
  }
  const ok = allowedPrefixes.some(
    (prefix) => path === prefix || path.startsWith(prefix.replace(/\/$/, "") + "/"),
  );
  if (!ok) {
    throw new Error(
      `Path ${JSON.stringify(path)} is outside the allowed prefixes (${allowedPrefixes.join(", ")}).`,
    );
  }
  return path;
}

export const DEFAULT_EXEC_ALLOWLIST: ReadonlySet<string> = new Set([
  "ls",
  "pwd",
  "whoami",
  "id",
  "date",
  "uptime",
  "uname",
  "hostname",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "df",
  "du",
  "free",
  "ps",
  "top",
  "env",
  "printenv",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "which",
  "type",
  "echo",
  "ping",
  "curl",
  "wget",
  "nslookup",
  "dig",
  "netstat",
  "ss",
]);

export interface ExecPlan {
  bin: string;
  args: string[];
}

export function planExecCommand(
  input: { command: string; args?: string[] },
  extraAllowed: readonly string[] = [],
): ExecPlan {
  const bin = (input.command || "").trim();
  if (!bin) throw new Error("command is required");
  if (/[/\s]/.test(bin)) {
    throw new Error(
      "command must be a single token without slashes or spaces.",
    );
  }

  const allowed = new Set<string>([
    ...DEFAULT_EXEC_ALLOWLIST,
    ...extraAllowed,
  ]);
  if (!allowed.has(bin)) {
    throw new Error(
      `'${bin}' is not in the allowlist. ` +
        `Allowed: ${[...allowed].sort().join(", ")}. ` +
        "Add to EXEC_EXTRA_ALLOWED to extend.",
    );
  }

  const args = (input.args ?? []).map((a, i) => {
    if (typeof a !== "string") {
      throw new Error(`arg #${i} is not a string`);
    }
    if (ARG_BLOCK_RE.test(a)) {
      throw new Error(`arg #${i} contains disallowed metacharacters.`);
    }
    return a;
  });

  return { bin, args };
}
