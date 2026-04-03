import { describe, expect, it } from "vitest";
import { recoverToolInput } from "../src/recovery.js";
import type { ToolDefinition } from "../src/types.js";

const TOOLS: ToolDefinition[] = [
  { name: "bash", description: "", inputSchema: {} },
  { name: "read_file", description: "", inputSchema: {} },
  { name: "write_file", description: "", inputSchema: {} },
  { name: "edit_file", description: "", inputSchema: {} },
  { name: "glob_search", description: "", inputSchema: {} },
  { name: "grep_search", description: "", inputSchema: {} },
];

describe("recoverToolInput", () => {
  it("step 1: returns valid JSON as-is", () => {
    const result = recoverToolInput('{"command": "ls"}', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("step 2: strips markdown code fences", () => {
    const result = recoverToolInput('```json\n{"command": "ls"}\n```', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("step 2: strips plain code fences", () => {
    const result = recoverToolInput('```\n{"command": "ls"}\n```', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("step 3+4: extracts JSON from text before/after", () => {
    const result = recoverToolInput('I will run ls. {"command": "ls"} Let me know.', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("step 4: removes trailing commas", () => {
    const result = recoverToolInput('{"command": "ls",}', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("step 4: converts single quotes to double quotes", () => {
    const result = recoverToolInput("{'command': 'ls'}", "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("step 4: adds quotes around unquoted keys", () => {
    const result = recoverToolInput('{command: "ls"}', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("step 4: strips line comments", () => {
    const result = recoverToolInput('{"command": "ls" // run ls\n}', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("step 5: closes truncated JSON", () => {
    const result = recoverToolInput('{"command": "ls"', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("field alias: cmd → command (bash)", () => {
    const result = recoverToolInput('{"cmd": "ls"}', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("field alias: exec → command (bash)", () => {
    const result = recoverToolInput('{"exec": "ls"}', "bash", TOOLS);
    expect(result).toEqual({ command: "ls" });
  });

  it("field alias: file → path (read_file)", () => {
    const result = recoverToolInput('{"file": "src/main.ts"}', "read_file", TOOLS);
    expect(result).toEqual({ path: "src/main.ts" });
  });

  it("field alias: text → content (write_file)", () => {
    const result = recoverToolInput('{"file": "out.txt", "text": "hello"}', "write_file", TOOLS);
    expect(result).toEqual({ path: "out.txt", content: "hello" });
  });

  it("field alias: find → old_string, replace → new_string (edit_file)", () => {
    const result = recoverToolInput(
      '{"file": "a.ts", "find": "foo", "replace": "bar"}',
      "edit_file",
      TOOLS,
    );
    expect(result).toEqual({ path: "a.ts", old_string: "foo", new_string: "bar" });
  });

  it("field alias: glob → pattern (glob_search)", () => {
    const result = recoverToolInput('{"glob": "src/**/*.ts"}', "glob_search", TOOLS);
    expect(result).toEqual({ pattern: "src/**/*.ts" });
  });

  it("field alias: regex → pattern (grep_search)", () => {
    const result = recoverToolInput('{"regex": "function\\\\s+main"}', "grep_search", TOOLS);
    expect(result).toEqual({ pattern: "function\\s+main" });
  });

  it("step 8: returns empty object for completely unrecoverable input", () => {
    const result = recoverToolInput("not json at all!!!", "bash", TOOLS);
    expect(result).toEqual({});
  });

  it("unknown tool: no field mapping, still recovers valid JSON", () => {
    const result = recoverToolInput('{"foo": "bar"}', "unknown_tool", TOOLS);
    expect(result).toEqual({ foo: "bar" });
  });
});
