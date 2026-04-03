import { describe, expect, it, vi } from "vitest";
import { runTurn } from "../src/agent.js";
import { createPermissionPolicy } from "../src/permissions.js";
import { Session } from "../src/session.js";
import type { AgentConfig, AgentEvent } from "../src/types.js";

const CONFIG: AgentConfig = {
  baseUrl: "http://localhost:11434/v1",
  model: "test",
  apiKey: "",
  maxIterations: 6,
  maxTokensBeforeCompact: 8000,
  permissionMode: "allow-all",
  cwd: process.cwd(),
  fewShotExamples: false,
};

function makeSession(): Session {
  return Session.new(CONFIG);
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function textChunk(content: string) {
  return {
    choices: [{ delta: { content, tool_calls: undefined }, finish_reason: null }],
    usage: null,
  };
}

function toolCallChunk(index: number, id: string, name: string, args: string) {
  return {
    choices: [
      {
        delta: {
          content: null,
          tool_calls: [{ index, id, function: { name, arguments: args } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  };
}

function usageChunk() {
  return { choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } };
}

// runTurn signature: (client, session, userInput, config, permissionPolicy)
const ALLOW_ALL = createPermissionPolicy("allow-all");
const READ_ONLY = createPermissionPolicy("read-only");

describe("runTurn — text-only response", () => {
  it("yields text_delta events and turn_complete", async () => {
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield textChunk("Hello ");
        yield textChunk("world");
        yield usageChunk();
      }),
    };

    const events = await collectEvents(
      runTurn(client as never, makeSession(), "hi", CONFIG, ALLOW_ALL),
    );

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(2);
    expect((deltas[0] as Extract<AgentEvent, { type: "text_delta" }>).content).toBe("Hello ");
    expect(events.at(-1)?.type).toBe("turn_complete");
  });

  it("appends user and assistant messages to session", async () => {
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield textChunk("response");
      }),
    };

    const session = makeSession();
    await collectEvents(runTurn(client as never, session, "hello", CONFIG, ALLOW_ALL));

    expect(session.messages[0].role).toBe("user");
    expect(session.messages[1].role).toBe("assistant");
  });

  it("yields usage event", async () => {
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield usageChunk();
      }),
    };
    const events = await collectEvents(
      runTurn(client as never, makeSession(), "hi", CONFIG, ALLOW_ALL),
    );
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    expect((usage as Extract<AgentEvent, { type: "usage" }>).inputTokens).toBe(100);
  });
});

describe("runTurn — single tool call", () => {
  it("yields tool_call_start, tool_result, and turn_complete", async () => {
    let n = 0;
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        n++;
        if (n === 1) yield toolCallChunk(0, "call_1", "bash", '{"command":"echo hi"}');
        else yield textChunk("Done.");
      }),
    };

    const events = await collectEvents(
      runTurn(client as never, makeSession(), "run echo", CONFIG, ALLOW_ALL),
    );

    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn_complete");
    expect(client.streamChat).toHaveBeenCalledTimes(2);
  });

  it("records tool messages in session", async () => {
    let n = 0;
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        n++;
        if (n === 1) yield toolCallChunk(0, "call_1", "bash", '{"command":"echo hi"}');
        else yield textChunk("Done.");
      }),
    };

    const session = makeSession();
    await collectEvents(runTurn(client as never, session, "run echo", CONFIG, ALLOW_ALL));

    expect(session.messages.map((m) => m.role)).toContain("tool");
  });

  it("tool_result output is non-empty", async () => {
    let n = 0;
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        n++;
        if (n === 1) yield toolCallChunk(0, "c1", "bash", '{"command":"echo hello"}');
        else yield textChunk("Done.");
      }),
    };

    const events = await collectEvents(
      runTurn(client as never, makeSession(), "run echo", CONFIG, ALLOW_ALL),
    );
    const tr = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(tr?.output).toContain("hello");
  });
});

describe("runTurn — permission deny", () => {
  it("denies write_file in read-only mode", async () => {
    let n = 0;
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        n++;
        if (n === 1) yield toolCallChunk(0, "c1", "write_file", '{"path":"x.txt","content":"hi"}');
        else yield textChunk("ok");
      }),
    };

    const events = await collectEvents(
      runTurn(client as never, makeSession(), "write a file", CONFIG, READ_ONLY),
    );

    const tr = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(tr?.isError).toBe(true);
    expect(tr?.output).toMatch(/denied/i);
  });
});

describe("runTurn — maxIterations", () => {
  it("stops after maxIterations when model always calls tools", async () => {
    const config = { ...CONFIG, maxIterations: 3 };
    let n = 0;
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        n++;
        yield toolCallChunk(0, `c${n}`, "bash", '{"command":"echo loop"}');
      }),
    };

    const events = await collectEvents(
      runTurn(client as never, makeSession(), "loop", config, ALLOW_ALL),
    );

    const complete = events.find(
      (e): e is Extract<AgentEvent, { type: "turn_complete" }> => e.type === "turn_complete",
    );
    expect(complete).toBeDefined();
    expect(complete?.iterations).toBeLessThanOrEqual(3);
  });
});

describe("runTurn — guardrail triggered", () => {
  it("stops when the same bash call repeats 3 times", async () => {
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        // Always returns the same tool call — triggers loop guardrail
        yield toolCallChunk(0, "c1", "bash", '{"command":"ls"}');
      }),
    };

    const events = await collectEvents(
      runTurn(client as never, makeSession(), "ls please", CONFIG, ALLOW_ALL),
    );

    expect(events.some((e) => e.type === "guardrail_triggered")).toBe(true);
  });
});

describe("runTurn — malformed tool input recovery", () => {
  it("recovers markdown-wrapped JSON and executes tool successfully", async () => {
    let n = 0;
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        n++;
        if (n === 1)
          yield toolCallChunk(0, "c1", "bash", '```json\n{"command":"echo recovered"}\n```');
        else yield textChunk("done");
      }),
    };

    const events = await collectEvents(
      runTurn(client as never, makeSession(), "run it", CONFIG, ALLOW_ALL),
    );

    const tr = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(tr?.isError).toBe(false);
    expect(tr?.output).toContain("recovered");
  });
});
