import { execSync } from "node:child_process";
import type { AgentConfig, ToolResult } from "../types.js";

const OUTPUT_LIMIT = 50 * 1024; // 50KB
const DEFAULT_TIMEOUT = 30_000; // 30s

export function executeBash(input: Record<string, unknown>, config: AgentConfig): ToolResult {
  const command = input.command;
  if (typeof command !== "string" || !command.trim()) {
    return { output: "Error: command is required", isError: true };
  }

  const timeout = typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT;

  try {
    const raw = execSync(command, {
      cwd: config.cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "buffer",
    });

    let output = raw.toString("utf8");
    if (output.length > OUTPUT_LIMIT) {
      output = `${output.slice(0, OUTPUT_LIMIT)}\n... (truncated — output exceeded 50KB)`;
    }

    return { output: output || "(no output)", isError: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer;
      stderr?: Buffer;
      status?: number;
    };

    const stdout = e.stdout?.toString("utf8") ?? "";
    const stderr = e.stderr?.toString("utf8") ?? "";
    const combined = [stdout, stderr].filter(Boolean).join("\n");
    const output = combined || e.message;

    return {
      output:
        output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n... (truncated)` : output,
      isError: true,
    };
  }
}
