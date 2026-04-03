import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig, ToolResult } from "../types.js";

export function executeEditFile(input: Record<string, unknown>, config: AgentConfig): ToolResult {
  const path = input.path;
  const oldString = input.old_string;
  const newString = input.new_string;
  const replaceAll = input.replace_all === true;

  if (typeof path !== "string" || !path.trim()) {
    return { output: "Error: path is required", isError: true };
  }
  if (typeof oldString !== "string") {
    return { output: "Error: old_string is required", isError: true };
  }
  if (typeof newString !== "string") {
    return { output: "Error: new_string is required", isError: true };
  }

  const fullPath = resolve(config.cwd, path);

  let content: string;
  try {
    content = readFileSync(fullPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { output: `Error: file not found: ${fullPath}`, isError: true };
    }
    return { output: `Error reading file: ${e.message}`, isError: true };
  }

  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    return {
      output: `Error: old_string not found in ${fullPath}\n\nProvide an exact match of text that exists in the file.`,
      isError: true,
    };
  }

  if (occurrences > 1 && !replaceAll) {
    return {
      output: `Error: old_string found ${occurrences} times in ${fullPath} — use replace_all:true or provide more surrounding context to make it unique.`,
      isError: true,
    };
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  try {
    writeFileSync(fullPath, updated, "utf8");
    return {
      output: `Replaced ${occurrences} occurrence${occurrences !== 1 ? "s" : ""} in ${fullPath}`,
      isError: false,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { output: `Error writing file: ${e.message}`, isError: true };
  }
}
