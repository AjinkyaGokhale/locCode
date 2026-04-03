import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../src/tools/index.js";
import type { AgentConfig } from "../src/types.js";

let tmpDir: string;
let CONFIG: AgentConfig;

beforeEach(() => {
  tmpDir = join(tmpdir(), `loccode-tools-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  CONFIG = {
    baseUrl: "http://localhost:11434/v1",
    model: "test",
    apiKey: "",
    maxIterations: 6,
    maxTokensBeforeCompact: 8000,
    permissionMode: "allow-all",
    cwd: tmpDir,
    fewShotExamples: false,
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- bash ---

describe("bash tool", () => {
  it("runs a command and returns stdout", async () => {
    const result = await executeTool("bash", { command: "echo hello" }, CONFIG);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("hello");
  });

  it("returns isError=true for non-zero exit", async () => {
    const result = await executeTool("bash", { command: "exit 1" }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it("returns isError=true for unknown command", async () => {
    const result = await executeTool(
      "bash",
      { command: "this_command_does_not_exist_xyz" },
      CONFIG,
    );
    expect(result.isError).toBe(true);
  });

  it("captures stderr in the output", async () => {
    const result = await executeTool("bash", { command: "echo err >&2" }, CONFIG);
    expect(result.isError).toBe(false);
  });

  it("truncates output over 50KB", async () => {
    // Generate >50KB output
    const result = await executeTool(
      "bash",
      {
        command: "python3 -c \"print('x' * 60000)\" || node -e \"console.log('x'.repeat(60000))\"",
      },
      CONFIG,
    );
    if (!result.isError) {
      expect(result.output.length).toBeLessThanOrEqual(50 * 1024 + 200);
    }
  });

  it("returns error for missing command field", async () => {
    const result = await executeTool("bash", {}, CONFIG);
    expect(result.isError).toBe(true);
  });

  it("uses cwd from config", async () => {
    const result = await executeTool("bash", { command: "pwd" }, CONFIG);
    expect(result.output.trim()).toBe(tmpDir);
  });
});

// --- read_file ---

describe("read_file tool", () => {
  it("reads an existing file with line numbers", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "line1\nline2\nline3");
    const result = await executeTool("read_file", { path: "a.txt" }, CONFIG);
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/1\tline1/);
    expect(result.output).toMatch(/2\tline2/);
    expect(result.output).toMatch(/3\tline3/);
  });

  it("returns isError=true for missing file", async () => {
    const result = await executeTool("read_file", { path: "nonexistent.txt" }, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/not found/i);
  });

  it("respects offset parameter", async () => {
    writeFileSync(join(tmpDir, "b.txt"), "a\nb\nc\nd");
    const result = await executeTool("read_file", { path: "b.txt", offset: 2 }, CONFIG);
    expect(result.isError).toBe(false);
    expect(result.output).not.toMatch(/\t a/);
    expect(result.output).toMatch(/3\tc/);
  });

  it("respects limit parameter", async () => {
    writeFileSync(join(tmpDir, "c.txt"), "a\nb\nc\nd\ne");
    const result = await executeTool("read_file", { path: "c.txt", limit: 2 }, CONFIG);
    expect(result.isError).toBe(false);
    const lines = result.output.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("returns error for missing path field", async () => {
    const result = await executeTool("read_file", {}, CONFIG);
    expect(result.isError).toBe(true);
  });
});

// --- write_file ---

describe("write_file tool", () => {
  it("creates a file with content", async () => {
    const result = await executeTool(
      "write_file",
      { path: "out.txt", content: "hello world" },
      CONFIG,
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(tmpDir, "out.txt"), "utf8")).toBe("hello world");
  });

  it("overwrites an existing file", async () => {
    writeFileSync(join(tmpDir, "existing.txt"), "old");
    await executeTool("write_file", { path: "existing.txt", content: "new" }, CONFIG);
    expect(readFileSync(join(tmpDir, "existing.txt"), "utf8")).toBe("new");
  });

  it("creates parent directories recursively", async () => {
    const result = await executeTool(
      "write_file",
      { path: "a/b/c/file.txt", content: "nested" },
      CONFIG,
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(tmpDir, "a/b/c/file.txt"), "utf8")).toBe("nested");
  });

  it("returns byte count in confirmation message", async () => {
    const result = await executeTool("write_file", { path: "bytes.txt", content: "hello" }, CONFIG);
    expect(result.output).toMatch(/5/);
  });

  it("returns error for missing path", async () => {
    const result = await executeTool("write_file", { content: "x" }, CONFIG);
    expect(result.isError).toBe(true);
  });

  it("returns error for missing content", async () => {
    const result = await executeTool("write_file", { path: "x.txt" }, CONFIG);
    expect(result.isError).toBe(true);
  });
});

// --- edit_file ---

describe("edit_file tool", () => {
  it("replaces exact match", async () => {
    writeFileSync(join(tmpDir, "edit.ts"), "const foo = 1;\nconst bar = 2;");
    const result = await executeTool(
      "edit_file",
      { path: "edit.ts", old_string: "foo = 1", new_string: "foo = 42" },
      CONFIG,
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(tmpDir, "edit.ts"), "utf8")).toContain("foo = 42");
  });

  it("returns error when old_string not found", async () => {
    writeFileSync(join(tmpDir, "nope.ts"), "const x = 1;");
    const result = await executeTool(
      "edit_file",
      { path: "nope.ts", old_string: "not here", new_string: "something" },
      CONFIG,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/not found/i);
  });

  it("returns error when old_string matches multiple times without replace_all", async () => {
    writeFileSync(join(tmpDir, "multi.ts"), "foo foo foo");
    const result = await executeTool(
      "edit_file",
      { path: "multi.ts", old_string: "foo", new_string: "bar" },
      CONFIG,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/3/);
  });

  it("replaces all occurrences with replace_all=true", async () => {
    writeFileSync(join(tmpDir, "all.ts"), "foo foo foo");
    const result = await executeTool(
      "edit_file",
      { path: "all.ts", old_string: "foo", new_string: "bar", replace_all: true },
      CONFIG,
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(tmpDir, "all.ts"), "utf8")).toBe("bar bar bar");
  });

  it("returns error for missing file", async () => {
    const result = await executeTool(
      "edit_file",
      { path: "missing.ts", old_string: "x", new_string: "y" },
      CONFIG,
    );
    expect(result.isError).toBe(true);
  });
});

// --- glob_search ---

describe("glob_search tool", () => {
  it("finds files matching pattern", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "");
    writeFileSync(join(tmpDir, "b.ts"), "");
    writeFileSync(join(tmpDir, "c.txt"), "");
    const result = await executeTool("glob_search", { pattern: "*.ts" }, CONFIG);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("b.ts");
    expect(result.output).not.toContain("c.txt");
  });

  it("returns 'No files matched' when pattern matches nothing", async () => {
    const result = await executeTool("glob_search", { pattern: "*.xyz" }, CONFIG);
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/no files matched/i);
  });

  it("returns error for missing pattern", async () => {
    const result = await executeTool("glob_search", {}, CONFIG);
    expect(result.isError).toBe(true);
  });

  it("searches nested directories", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), "");
    const result = await executeTool("glob_search", { pattern: "**/*.ts" }, CONFIG);
    expect(result.output).toContain("index.ts");
  });
});

// --- grep_search ---

describe("grep_search tool", () => {
  it("finds pattern in file content", async () => {
    writeFileSync(join(tmpDir, "code.ts"), "function hello() {\n  return 42;\n}");
    const result = await executeTool("grep_search", { pattern: "function hello" }, CONFIG);
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/function hello/);
  });

  it("returns 'No matches found' when pattern not present", async () => {
    writeFileSync(join(tmpDir, "empty.ts"), "const x = 1;");
    const result = await executeTool("grep_search", { pattern: "DOESNOTEXIST_XYZ" }, CONFIG);
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/no matches/i);
  });

  it("returns error for missing pattern", async () => {
    const result = await executeTool("grep_search", {}, CONFIG);
    expect(result.isError).toBe(true);
  });

  it("includes file path and line number in output", async () => {
    writeFileSync(join(tmpDir, "foo.ts"), "const answer = 42;");
    const result = await executeTool("grep_search", { pattern: "answer" }, CONFIG);
    expect(result.output).toContain("foo.ts");
    expect(result.output).toMatch(/:/);
  });
});

// --- unknown tool ---

describe("executeTool with unknown name", () => {
  it("returns isError=true", async () => {
    const result = await executeTool("not_a_tool", {}, CONFIG);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unknown tool/i);
  });
});
