import { Client, type ClientChannel } from "ssh2";
import type { SshConfig } from "./config.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

const MAX_OUTPUT_BYTES = 1_000_000;
const TRUNCATED_STDOUT = "\n…[output truncated by host-mcp]\n";
const TRUNCATED_STDERR = "\n…[stderr truncated by host-mcp]\n";

export class SshClient {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly cfg: SshConfig) {}

  private async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const client = new Client();
      const cleanup = () => {
        client.removeListener("ready", onReady);
        client.removeListener("error", onError);
      };
      const onReady = () => {
        cleanup();
        this.client = client;
        const drop = () => {
          this.client = null;
        };
        client.on("error", drop);
        client.on("close", drop);
        client.on("end", drop);
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        try {
          client.end();
        } catch {
          /* noop */
        }
        reject(err);
      };

      client.once("ready", onReady);
      client.once("error", onError);

      client.connect({
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        privateKey: this.cfg.privateKey,
        passphrase: this.cfg.passphrase,
        password: this.cfg.password,
        readyTimeout: 15_000,
        keepaliveInterval: 30_000,
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async exec(
    command: string,
    opts: { timeoutMs?: number; pty?: boolean } = {},
  ): Promise<ExecResult> {
    await this.connect();
    const client = this.client;
    if (!client) {
      throw new Error("SSH client not connected");
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 30_000;
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (err: Error | null, value?: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve(value!);
      };

      client.exec(
        command,
        opts.pty ? { pty: true } : {},
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            finish(err);
            return;
          }

          let stdout = "";
          let stderr = "";
          let stdoutBytes = 0;
          let stderrBytes = 0;
          let exitCode: number | null = null;
          let exitSignal: string | null = null;

          timer = setTimeout(() => {
            try {
              stream.signal("KILL");
              stream.close();
            } catch {
              /* noop */
            }
            finish(
              new Error(`Command timed out after ${timeoutMs}ms: ${command}`),
            );
          }, timeoutMs);

          stream.on("data", (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes <= MAX_OUTPUT_BYTES) {
              stdout += chunk.toString("utf8");
            } else if (!stdout.endsWith(TRUNCATED_STDOUT)) {
              stdout += TRUNCATED_STDOUT;
            }
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= MAX_OUTPUT_BYTES) {
              stderr += chunk.toString("utf8");
            } else if (!stderr.endsWith(TRUNCATED_STDERR)) {
              stderr += TRUNCATED_STDERR;
            }
          });

          stream.on("exit", (code: number | null, signal?: string) => {
            exitCode = code ?? null;
            exitSignal = signal ?? null;
          });

          stream.on("close", () => {
            finish(null, {
              stdout,
              stderr,
              code: exitCode,
              signal: exitSignal,
            });
          });

          stream.on("error", (e: Error) => finish(e));
        },
      );
    });
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        this.client.end();
      } catch {
        /* noop */
      }
      this.client = null;
    }
  }
}
