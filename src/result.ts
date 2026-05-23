import type { ExecResult } from "./ssh.js";

export interface ToolText {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(text: string): ToolText {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): ToolText {
  return { content: [{ type: "text", text }], isError: true };
}

export function formatExecError(label: string, result: ExecResult): string {
  const parts = [
    `${label} failed (exit ${result.code ?? "?"}${
      result.signal ? `, signal ${result.signal}` : ""
    }).`,
  ];
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
  return parts.join("\n\n");
}
