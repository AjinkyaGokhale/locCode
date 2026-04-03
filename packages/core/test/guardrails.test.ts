import { describe, expect, it } from "vitest";
import { checkGuardrails } from "../src/guardrails.js";
import { Session } from "../src/session.js";
import type { AgentConfig } from "../src/types.js";

const CONFIG: AgentConfig = {
  baseUrl: "http://localhost:11434/v1",
  model: "test",
  apiKey: "",
  maxIterations: 6,
  maxTokensBeforeCompact: 8000,
  permissionMode: "workspace-write",
  cwd: "/tmp",
  fewShotExamples: false,
};

function makeSession(): Session {
  return Session.new(CONFIG);
}

function addToolCall(session: Session, name: string, input: string, result = "ok"): void {
  session.appendUser("test");
  session.appendAssistant([{ type: "tool_use", id: `id_${Math.random()}`, name, input }]);
  session.appendToolResult(`id_${Math.random()}`, name, { output: result, isError: false });
}

function addErrorToolCall(session: Session, name: string, input: string): void {
  const id = `id_${Math.random()}`;
  session.appendUser("test");
  session.appendAssistant([{ type: "tool_use", id, name, input }]);
  session.appendToolResult(id, name, { output: "error", isError: true });
}

describe("checkGuardrails", () => {
  it("returns shouldStop=false for a normal session", () => {
    const session = makeSession();
    addToolCall(session, "read_file", '{"path":"a.ts"}');
    addToolCall(session, "grep_search", '{"pattern":"foo"}');
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(false);
  });

  it("detects 3 consecutive identical tool calls", () => {
    const session = makeSession();
    const input = '{"command":"ls"}';
    addToolCall(session, "bash", input);
    addToolCall(session, "bash", input);
    addToolCall(session, "bash", input);
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/identical/);
  });

  it("does not trigger on 2 identical calls", () => {
    const session = makeSession();
    const input = '{"command":"ls"}';
    addToolCall(session, "bash", input);
    addToolCall(session, "bash", input);
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(false);
  });

  it("does not trigger on 3 calls with same name but different inputs", () => {
    const session = makeSession();
    addToolCall(session, "bash", '{"command":"ls"}');
    addToolCall(session, "bash", '{"command":"pwd"}');
    addToolCall(session, "bash", '{"command":"echo hi"}');
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(false);
  });

  it("detects same file read 3 times", () => {
    const session = makeSession();
    const input = '{"path":"src/main.ts"}';
    addToolCall(session, "read_file", input);
    addToolCall(session, "read_file", input);
    addToolCall(session, "read_file", input);
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/read/i);
  });

  it("detects 4 consecutive errors", () => {
    const session = makeSession();
    addErrorToolCall(session, "bash", '{"command":"fail1"}');
    addErrorToolCall(session, "bash", '{"command":"fail2"}');
    addErrorToolCall(session, "bash", '{"command":"fail3"}');
    addErrorToolCall(session, "bash", '{"command":"fail4"}');
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/failed/i);
  });

  it("does not trigger on 3 consecutive errors", () => {
    const session = makeSession();
    addErrorToolCall(session, "bash", '{"command":"fail1"}');
    addErrorToolCall(session, "bash", '{"command":"fail2"}');
    addErrorToolCall(session, "bash", '{"command":"fail3"}');
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(false);
  });

  it("detects bash command exceeding 2000 characters", () => {
    const session = makeSession();
    const longCmd = "x".repeat(2001);
    addToolCall(session, "bash", JSON.stringify({ command: longCmd }));
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/2000/);
  });

  it("does not trigger when the full bash input JSON is exactly 2000 characters", () => {
    const session = makeSession();
    // {"command":"..."}  overhead = 14 chars ({"command":"} + "})
    // → command value length = 2000 - 14 = 1986
    const cmd = "x".repeat(1986);
    const input = JSON.stringify({ command: cmd }); // length = 2000
    expect(input.length).toBe(2000);
    addToolCall(session, "bash", input);
    const result = checkGuardrails(session, CONFIG);
    expect(result.shouldStop).toBe(false);
  });
});
