import { spawn } from "node:child_process";
import {
  MAX_OUTPUT_BYTES,
  TRUNCATED_STDERR,
  TRUNCATED_STDOUT,
  type CommandRunner,
  type ExecOpts,
  type ExecResult,
} from "./runner.js";

export class LocalRunner implements CommandRunner {
  async exec(command: string, opts: ExecOpts = {}): Promise<ExecResult> {
    // sh -c preserves the same shell semantics SshClient relies on
    // (`&&`, single-quote quoting, pipes via shell, etc.)
    return new Promise<ExecResult>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const child = spawn("sh", ["-c", command], { stdio: "pipe" });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
        settle(
          new Error(`Command timed out after ${timeoutMs}ms: ${command}`),
        );
      }, timeoutMs);

      const settle = (err: Error | null, value?: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value!);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_OUTPUT_BYTES) {
          stdout += chunk.toString("utf8");
        } else if (!stdout.endsWith(TRUNCATED_STDOUT)) {
          stdout += TRUNCATED_STDOUT;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_OUTPUT_BYTES) {
          stderr += chunk.toString("utf8");
        } else if (!stderr.endsWith(TRUNCATED_STDERR)) {
          stderr += TRUNCATED_STDERR;
        }
      });

      child.on("error", (e) => settle(e));
      child.on("close", (code, signal) => {
        settle(null, { stdout, stderr, code, signal: signal ?? null });
      });
    });
  }

  async close(): Promise<void> {
    // nothing to clean up
  }
}
