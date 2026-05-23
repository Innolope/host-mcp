import "dotenv/config";
import { readFileSync } from "node:fs";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function csv(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(s)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(s)) return false;
  throw new Error(
    `Invalid boolean for ${name}: ${JSON.stringify(v)}. Use true/false.`,
  );
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  privateKey?: Buffer;
  passphrase?: string;
  password?: string;
}

export interface HttpConfig {
  port: number;
  host: string;
  authToken: string;
  path: string;
}

export type TransportMode = "stdio" | "http";

export interface AppConfig {
  ssh: SshConfig | null;
  transport: TransportMode;
  http: HttpConfig | null;
  dockerEnabled: boolean;
  nginxEnabled: boolean;
  caddyEnabled: boolean;
  dockerBin: string;
  nginxBin: string;
  caddyAdminUrl: string;
  defaultComposeDir: string;
  defaultComposeProject: string;
  defaultContainers: string[];
  mongoContainer: string;
  mongoUri: string;
  mongoDb: string;
  mongoCollections: string[];
  execExtraAllowed: string[];
  readFileAllowedPrefixes: string[];
  readFileMaxBytes: number;
}

function loadSshConfig(): SshConfig | null {
  const sshHost = optional("SSH_HOST");
  if (!sshHost) return null;

  const keyPath = optional("SSH_KEY_PATH");
  const password = optional("SSH_PASSWORD");
  if (!keyPath && !password) {
    throw new Error(
      "SSH_HOST is set but neither SSH_KEY_PATH nor SSH_PASSWORD is. " +
        "Provide one, or unset SSH_HOST to use the local-exec backend.",
    );
  }

  return {
    host: sshHost,
    port: Number(optional("SSH_PORT", "22")),
    username: required("SSH_USER"),
    privateKey: keyPath ? readFileSync(keyPath) : undefined,
    passphrase: optional("SSH_KEY_PASSPHRASE") || undefined,
    password: password || undefined,
  };
}

function loadHttpConfig(mode: TransportMode): HttpConfig | null {
  if (mode !== "http") return null;
  const authToken = optional("MCP_AUTH_TOKEN");
  if (!authToken) {
    throw new Error(
      "TRANSPORT=http requires MCP_AUTH_TOKEN to be set. " +
        "Generate a long random string and treat it as a secret.",
    );
  }
  const portRaw = Number(optional("HTTP_PORT", "3030"));
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error(`Invalid HTTP_PORT: ${portRaw}`);
  }
  return {
    port: portRaw,
    host: optional("HTTP_HOST", "127.0.0.1"),
    authToken,
    path: optional("HTTP_PATH", "/mcp"),
  };
}

function loadTransport(): TransportMode {
  const v = optional("TRANSPORT", "stdio").toLowerCase();
  if (v === "stdio" || v === "http") return v;
  throw new Error(`Invalid TRANSPORT: ${JSON.stringify(v)}. Use stdio or http.`);
}

export function loadConfig(): AppConfig {
  const transport = loadTransport();
  const http = loadHttpConfig(transport);
  const ssh = loadSshConfig();
  const maxBytes = Number(optional("READ_FILE_MAX_BYTES", "1048576"));

  return {
    ssh,
    transport,
    http,
    dockerEnabled: bool("DOCKER_ENABLED", true),
    nginxEnabled: bool("NGINX_ENABLED", true),
    caddyEnabled: bool("CADDY_ENABLED", true),
    dockerBin: optional("DOCKER_BIN", "docker"),
    nginxBin: optional("NGINX_BIN", "nginx"),
    caddyAdminUrl: optional("CADDY_ADMIN_URL", "http://localhost:2019"),
    defaultComposeDir: optional("DEFAULT_COMPOSE_DIR", ""),
    defaultComposeProject: optional("DEFAULT_COMPOSE_PROJECT", ""),
    defaultContainers: csv("DEFAULT_CONTAINERS"),
    mongoContainer: optional("MONGO_CONTAINER", ""),
    mongoUri: optional("MONGO_URI", "mongodb://localhost:27017"),
    mongoDb: optional("MONGO_DB", ""),
    mongoCollections: csv("MONGO_COLLECTIONS"),
    execExtraAllowed: csv("EXEC_EXTRA_ALLOWED"),
    readFileAllowedPrefixes: csv("READ_FILE_ALLOWED_PREFIXES"),
    readFileMaxBytes:
      Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 1_048_576,
  };
}
