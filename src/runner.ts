export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

export interface ExecOpts {
  timeoutMs?: number;
  pty?: boolean;
}

export interface CommandRunner {
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  close(): Promise<void>;
}

export const MAX_OUTPUT_BYTES = 1_000_000;
export const TRUNCATED_STDOUT = "\n…[output truncated by host-mcp]\n";
export const TRUNCATED_STDERR = "\n…[stderr truncated by host-mcp]\n";
