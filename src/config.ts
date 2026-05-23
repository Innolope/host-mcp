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

export interface AppConfig {
  ssh: SshConfig;
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

export function loadConfig(): AppConfig {
  const keyPath = optional("SSH_KEY_PATH");
  const password = optional("SSH_PASSWORD");

  if (!keyPath && !password) {
    throw new Error(
      "Either SSH_KEY_PATH or SSH_PASSWORD must be set in the environment.",
    );
  }

  const privateKey = keyPath ? readFileSync(keyPath) : undefined;

  const ssh: SshConfig = {
    host: required("SSH_HOST"),
    port: Number(optional("SSH_PORT", "22")),
    username: required("SSH_USER"),
    privateKey,
    passphrase: optional("SSH_KEY_PASSPHRASE") || undefined,
    password: password || undefined,
  };

  const maxBytes = Number(optional("READ_FILE_MAX_BYTES", "1048576"));

  return {
    ssh,
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
