import { describe, expect, it, vi } from "vitest";
import { compactSession, estimateTokens, shouldCompact } from "../src/compact.js";
import { Session } from "../src/session.js";
import type { AgentConfig, AgentEvent } from "../src/types.js";

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

function addTurn(session: Session, userText: string, assistantText: string): void {
  session.appendUser(userText);
  session.appendAssistant([{ type: "text", text: assistantText }]);
}

describe("estimateTokens", () => {
  it("returns 0 for empty session", () => {
    expect(estimateTokens(makeSession())).toBe(0);
  });

  it("estimates ~4 chars per token for text blocks", () => {
    const session = makeSession();
    session.appendUser("a".repeat(400)); // 100 tokens
    expect(estimateTokens(session)).toBe(100);
  });

  it("estimates tokens across multiple message types", () => {
    const session = makeSession();
    session.appendUser("a".repeat(40)); // 10 tokens
    session.appendAssistant([
      { type: "text", text: "b".repeat(40) }, // 10 tokens
      { type: "tool_use", id: "x", name: "bash", input: "c".repeat(36) }, // (4+36)/4 = 10 tokens
    ]);
    session.appendToolResult("x", "bash", { output: "d".repeat(36), isError: false }); // (4+36)/4 = 10
    expect(estimateTokens(session)).toBe(40);
  });
});

describe("shouldCompact", () => {
  it("returns false when message count ≤ 4", () => {
    const session = makeSession();
    addTurn(session, "a".repeat(4000), "b".repeat(4000));
    // 2 messages, even though tokens are high
    expect(shouldCompact(session, 100)).toBe(false);
  });

  it("returns false when tokens below threshold", () => {
    const session = makeSession();
    for (let i = 0; i < 5; i++) addTurn(session, "hi", "hello");
    expect(shouldCompact(session, 100_000)).toBe(false);
  });

  it("returns true when messages > 4 and tokens >= max", () => {
    const session = makeSession();
    for (let i = 0; i < 5; i++) addTurn(session, "a".repeat(100), "b".repeat(100));
    const tokens = estimateTokens(session);
    expect(shouldCompact(session, tokens)).toBe(true);
  });

  it("returns false when exactly 4 messages regardless of tokens", () => {
    const session = makeSession();
    addTurn(session, "a".repeat(10_000), "b".repeat(10_000));
    addTurn(session, "a".repeat(10_000), "b".repeat(10_000));
    expect(session.messages).toHaveLength(4);
    expect(shouldCompact(session, 1)).toBe(false);
  });
});

describe("compactSession", () => {
  function makeMockClient(summaryText = "- User asked for help\n- Showed files") {
    const chunk = {
      choices: [{ delta: { content: summaryText }, finish_reason: null }],
      usage: null,
    };
    return {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield chunk;
      }),
    };
  }

  it("does nothing when messages ≤ 4", async () => {
    const session = makeSession();
    addTurn(session, "hi", "hello");
    const client = makeMockClient();
    await compactSession(client, session, CONFIG);
    expect(session.messages).toHaveLength(2);
    expect(client.streamChat).not.toHaveBeenCalled();
  });

  it("reduces message count when > 4 messages", async () => {
    const session = makeSession();
    for (let i = 0; i < 6; i++) addTurn(session, `question ${i}`, `answer ${i}`);
    const before = session.messages.length; // 12
    const client = makeMockClient();
    await compactSession(client, session, CONFIG);
    expect(session.messages.length).toBeLessThan(before);
  });

  it("preserves last 4 messages verbatim after compaction", async () => {
    const session = makeSession();
    for (let i = 0; i < 5; i++) addTurn(session, `q${i}`, `a${i}`);
    // last 4 messages are turn 3 assistant, turn 4 user+assistant
    const last4 = session.messages.slice(-4);
    const client = makeMockClient();
    await compactSession(client, session, CONFIG);
    const preserved = session.messages.slice(-4);
    expect(preserved).toEqual(last4);
  });

  it("adds a system summary message after compaction", async () => {
    const session = makeSession();
    for (let i = 0; i < 5; i++) addTurn(session, `q${i}`, `a${i}`);
    const client = makeMockClient("- summary bullet");
    await compactSession(client, session, CONFIG);
    const summaryMsg = session.messages[0];
    expect(summaryMsg.role).toBe("system");
    const block = summaryMsg.blocks[0];
    expect(block.type === "text" && block.text).toMatch(/<summary>/);
  });

  it("calls the model with the old messages for summarization", async () => {
    const session = makeSession();
    for (let i = 0; i < 5; i++) addTurn(session, `q${i}`, `a${i}`);
    const client = makeMockClient();
    await compactSession(client, session, CONFIG);
    expect(client.streamChat).toHaveBeenCalledOnce();
  });
});
