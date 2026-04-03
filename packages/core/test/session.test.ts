import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import type { AgentConfig } from "../src/types.js";

const CONFIG: AgentConfig = {
  baseUrl: "http://localhost:11434/v1",
  model: "test-model",
  apiKey: "",
  maxIterations: 6,
  maxTokensBeforeCompact: 8000,
  permissionMode: "workspace-write",
  cwd: "/tmp",
  fewShotExamples: false,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `loccode-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Session.new", () => {
  it("generates an id starting with 'session_'", () => {
    const session = Session.new(CONFIG);
    expect(session.id).toMatch(/^session_/);
  });

  it("starts with no messages", () => {
    const session = Session.new(CONFIG);
    expect(session.messages).toHaveLength(0);
  });

  it("stores model and baseUrl from config", () => {
    const session = Session.new(CONFIG);
    expect(session.config.model).toBe("test-model");
    expect(session.config.baseUrl).toBe("http://localhost:11434/v1");
  });
});

describe("Session.appendUser", () => {
  it("adds a user message with text block", () => {
    const session = Session.new(CONFIG);
    session.appendUser("hello");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[0].blocks[0]).toEqual({ type: "text", text: "hello" });
  });
});

describe("Session.appendAssistant", () => {
  it("adds an assistant message with given blocks", () => {
    const session = Session.new(CONFIG);
    session.appendAssistant([{ type: "text", text: "I'll help." }]);
    expect(session.messages[0].role).toBe("assistant");
    expect(session.messages[0].blocks[0]).toEqual({ type: "text", text: "I'll help." });
  });

  it("supports tool_use blocks", () => {
    const session = Session.new(CONFIG);
    session.appendAssistant([
      { type: "tool_use", id: "call_0", name: "bash", input: '{"command":"ls"}' },
    ]);
    const block = session.messages[0].blocks[0];
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      expect(block.name).toBe("bash");
      expect(block.id).toBe("call_0");
    }
  });
});

describe("Session.appendToolResult", () => {
  it("adds a tool message with tool_result block", () => {
    const session = Session.new(CONFIG);
    session.appendToolResult("call_0", "bash", { output: "hello", isError: false });
    expect(session.messages[0].role).toBe("tool");
    const block = session.messages[0].blocks[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.toolUseId).toBe("call_0");
      expect(block.toolName).toBe("bash");
      expect(block.output).toBe("hello");
      expect(block.isError).toBe(false);
    }
  });
});

describe("Session.prependSystemContext", () => {
  it("inserts a system message before user messages", () => {
    const session = Session.new(CONFIG);
    session.appendUser("hello");
    session.prependSystemContext("Memory context");
    expect(session.messages[0].role).toBe("system");
    expect(session.messages[1].role).toBe("user");
  });

  it("inserts after existing system messages", () => {
    const session = Session.new(CONFIG);
    session.messages.unshift({ role: "system", blocks: [{ type: "text", text: "existing" }] });
    session.prependSystemContext("new context");
    expect(session.messages[0].role).toBe("system");
    expect(session.messages[1].role).toBe("system");
  });
});

describe("Session.getRecentToolCalls", () => {
  it("returns the last N tool_use blocks", () => {
    const session = Session.new(CONFIG);
    session.appendAssistant([
      { type: "tool_use", id: "a", name: "bash", input: '{"command":"ls"}' },
    ]);
    session.appendAssistant([
      { type: "tool_use", id: "b", name: "read_file", input: '{"path":"a.ts"}' },
    ]);
    session.appendAssistant([
      { type: "tool_use", id: "c", name: "bash", input: '{"command":"pwd"}' },
    ]);
    const recent = session.getRecentToolCalls(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].name).toBe("read_file");
    expect(recent[1].name).toBe("bash");
  });

  it("returns all if fewer than N exist", () => {
    const session = Session.new(CONFIG);
    session.appendAssistant([{ type: "tool_use", id: "a", name: "bash", input: "{}" }]);
    expect(session.getRecentToolCalls(10)).toHaveLength(1);
  });
});

describe("Session.getRecentToolResults", () => {
  it("returns the last N tool_result blocks", () => {
    const session = Session.new(CONFIG);
    session.appendToolResult("a", "bash", { output: "out1", isError: false });
    session.appendToolResult("b", "bash", { output: "out2", isError: true });
    const recent = session.getRecentToolResults(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].output).toBe("out2");
    expect(recent[0].isError).toBe(true);
  });
});

describe("Session.getLastTurnMessages", () => {
  it("returns messages from the last user message onward", () => {
    const session = Session.new(CONFIG);
    session.appendUser("first");
    session.appendAssistant([{ type: "text", text: "response" }]);
    session.appendUser("second");
    session.appendAssistant([{ type: "text", text: "response2" }]);
    const turn = session.getLastTurnMessages();
    expect(turn[0].role).toBe("user");
    const block = turn[0].blocks[0];
    expect(block.type === "text" && block.text).toBe("second");
  });

  it("returns empty array when no messages", () => {
    const session = Session.new(CONFIG);
    expect(session.getLastTurnMessages()).toHaveLength(0);
  });
});

describe("Session save/load round-trip", () => {
  it("saves to JSON and loads back correctly", () => {
    const session = Session.new(CONFIG);
    session.appendUser("test message");
    session.appendAssistant([{ type: "text", text: "response" }]);

    const savedPath = session.save(tmpDir);
    const raw = JSON.parse(readFileSync(savedPath, "utf8")) as {
      version: number;
      id: string;
      messages: unknown[];
    };
    expect(raw.version).toBe(1);
    expect(raw.id).toBe(session.id);

    const loaded = Session.load(savedPath);
    expect(loaded.id).toBe(session.id);
    expect(loaded.config.model).toBe(CONFIG.model);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].role).toBe("user");
    expect(loaded.messages[1].role).toBe("assistant");
  });

  it("save returns the file path", () => {
    const session = Session.new(CONFIG);
    const path = session.save(tmpDir);
    expect(path).toContain(session.id);
    expect(path).toMatch(/\.json$/);
  });

  it("creates the directory if it doesn't exist", () => {
    const session = Session.new(CONFIG);
    const nestedDir = join(tmpDir, "a", "b", "c");
    expect(() => session.save(nestedDir)).not.toThrow();
  });
});
