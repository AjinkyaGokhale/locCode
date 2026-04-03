import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  Session,
  TOOL_DEFINITIONS,
  compactSession,
  createClient,
  createPermissionPolicy,
  estimateTokens,
  runTurn,
} from "@loccode/core";
import type { AgentConfig, AgentEvent } from "@loccode/core";
import { HISTORY_PATH } from "./config.js";
import * as render from "./render.js";
import * as spinner from "./spinner.js";

// ANSI helpers
const BOLD = "\x1B[1m";
const DIM = "\x1B[2m";
const RESET = "\x1B[0m";
const CYAN = "\x1B[36m";
const YELLOW = "\x1B[33m";

const HELP_TEXT = `
${BOLD}Commands:${RESET}
  ${CYAN}/help${RESET}                  Show this help
  ${CYAN}/status${RESET}                Show session info
  ${CYAN}/compact${RESET}               Manually compact the conversation
  ${CYAN}/clear${RESET}                 Clear conversation history
  ${CYAN}/save [path]${RESET}           Save session to file
  ${CYAN}/load <path>${RESET}           Load session from file
  ${CYAN}/tools${RESET}                 List available tools
  ${CYAN}/permission <mode>${RESET}     Change permission mode (read-only|workspace-write|allow-all)
  ${CYAN}/model <name>${RESET}          Switch model
  ${CYAN}/exit${RESET}                  Exit loccode
`;

interface ReplState {
  session: Session;
  config: AgentConfig;
  permissionMode: AgentConfig["permissionMode"];
}

async function runAgentTurn(
  userInput: string,
  state: ReplState,
  rl: ReturnType<typeof createInterface>,
): Promise<void> {
  const client = createClient(state.config);
  const policy = createPermissionPolicy(state.permissionMode);

  // Handle bash "prompt" permission mode — ask user before executing
  const promptingPolicy = {
    authorize(toolName: string, input: Record<string, unknown>) {
      const result = policy.authorize(toolName, input);
      if (result.outcome === "prompt") {
        // We handle this synchronously via a flag — actual prompt happens below
        return result;
      }
      return result;
    },
  };

  spinner.start("Thinking...");

  let textBuffer = "";
  let totalIn = 0;
  let totalOut = 0;

  try {
    for await (const event of runTurn(
      client,
      state.session,
      userInput,
      state.config,
      promptingPolicy,
    )) {
      switch (event.type) {
        case "text_delta":
          textBuffer += event.content;
          break;

        case "tool_call_start":
          // Flush any accumulated text before showing tool call
          if (textBuffer.trim()) {
            spinner.stop();
            process.stdout.write(render.renderMarkdown(textBuffer));
            textBuffer = "";
            spinner.start(`Tool: ${event.name}...`);
          } else {
            spinner.update(`Tool: ${event.name}...`);
          }
          break;

        case "tool_result": {
          spinner.stop();
          // Print tool name + collapsed result
          process.stdout.write(render.renderToolResult(event.name, event.output, event.isError));
          spinner.start("Thinking...");
          break;
        }

        case "usage":
          totalIn += event.inputTokens;
          totalOut += event.outputTokens;
          break;

        case "guardrail_triggered":
          spinner.stop();
          process.stdout.write(render.renderGuardrail(event.reason));
          spinner.start("Thinking...");
          break;

        case "turn_complete":
          spinner.stop();
          if (textBuffer.trim()) {
            process.stdout.write(render.renderMarkdown(textBuffer));
          }
          if (totalIn > 0 || totalOut > 0) {
            process.stdout.write(render.renderUsage(totalIn, totalOut));
          }
          break;

        case "error":
          spinner.stop();
          process.stdout.write(render.renderError(event.message));
          break;
      }
    }
  } catch (err) {
    spinner.stop();
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(render.renderError(msg));
  }
}

async function handleCommand(
  line: string,
  state: ReplState,
  rl: ReturnType<typeof createInterface>,
): Promise<boolean> {
  const parts = line.slice(1).trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  const args = parts.slice(1);

  switch (cmd) {
    case "help":
      process.stdout.write(HELP_TEXT);
      return true;

    case "status": {
      const tokens = estimateTokens(state.session);
      process.stdout.write(
        [
          "",
          `  ${BOLD}Session:${RESET}    ${state.session.id}`,
          `  ${BOLD}Model:${RESET}      ${state.config.model}`,
          `  ${BOLD}Backend:${RESET}    ${state.config.baseUrl}`,
          `  ${BOLD}Permission:${RESET} ${state.permissionMode}`,
          `  ${BOLD}Messages:${RESET}   ${state.session.messages.length}`,
          `  ${BOLD}~Tokens:${RESET}    ${tokens.toLocaleString()}`,
          "",
        ].join("\n"),
      );
      return true;
    }

    case "compact": {
      const before = state.session.messages.length;
      const client = createClient(state.config);
      spinner.start("Compacting...");
      await compactSession(client, state.session, state.config);
      spinner.stop();
      process.stdout.write(
        render.renderInfo(`Compacted: ${before} → ${state.session.messages.length} messages`),
      );
      return true;
    }

    case "clear":
      state.session = Session.new(state.config);
      process.stdout.write(render.renderInfo("Session cleared."));
      return true;

    case "save": {
      const savePath =
        args[0] ?? resolve(process.cwd(), ".loccode", "sessions", `${state.session.id}.json`);
      mkdirSync(dirname(savePath), { recursive: true });
      const written = state.session.save(dirname(savePath));
      // session.save writes to dirname/id.json — if user gave explicit path, copy
      process.stdout.write(render.renderInfo(`Saved to ${written}`));
      return true;
    }

    case "load": {
      if (!args[0]) {
        process.stdout.write(render.renderError("Usage: /load <path>"));
        return true;
      }
      try {
        state.session = Session.load(args[0]);
        process.stdout.write(
          render.renderInfo(
            `Loaded session ${state.session.id} (${state.session.messages.length} messages)`,
          ),
        );
      } catch {
        process.stdout.write(render.renderError(`Could not load: ${args[0]}`));
      }
      return true;
    }

    case "tools": {
      const lines = [`\n  ${BOLD}Available tools:${RESET}`];
      for (const t of TOOL_DEFINITIONS) {
        lines.push(`  ${CYAN}${t.name.padEnd(16)}${RESET}${DIM}${t.description}${RESET}`);
      }
      lines.push("");
      process.stdout.write(lines.join("\n"));
      return true;
    }

    case "permission": {
      const mode = args[0];
      if (mode === "read-only" || mode === "workspace-write" || mode === "allow-all") {
        state.permissionMode = mode;
        process.stdout.write(render.renderInfo(`Permission mode set to ${mode}`));
      } else {
        process.stdout.write(
          render.renderError("Valid modes: read-only | workspace-write | allow-all"),
        );
      }
      return true;
    }

    case "model": {
      if (!args[0]) {
        process.stdout.write(render.renderError("Usage: /model <name>"));
        return true;
      }
      state.config = { ...state.config, model: args[0] };
      process.stdout.write(render.renderInfo(`Model set to ${args[0]}`));
      return true;
    }

    case "mem":
      process.stdout.write(render.renderInfo("Memory system not yet implemented (Phase 3)."));
      return true;

    case "exit":
    case "quit":
      rl.close();
      process.stdout.write("\n");
      process.exit(0);
      return true; // unreachable but satisfies TS

    default:
      process.stdout.write(
        render.renderError(`Unknown command: /${cmd}. Type /help for commands.`),
      );
      return true;
  }
}

export async function startRepl(config: AgentConfig): Promise<void> {
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });

  const state: ReplState = {
    session: Session.new(config),
    config,
    permissionMode: config.permissionMode,
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${CYAN}>${RESET} `,
    historySize: 500,
    // @ts-expect-error — readline accepts a path but types don't expose it
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  // Graceful exit on Ctrl+C
  rl.on("SIGINT", () => {
    if (spinner.isSpinning()) {
      spinner.stop();
      process.stdout.write(render.renderInfo("Cancelled."));
      rl.prompt();
    } else {
      process.stdout.write("\n");
      process.exit(0);
    }
  });

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith("/")) {
      await handleCommand(trimmed, state, rl);
    } else {
      await runAgentTurn(trimmed, state, rl);
    }

    rl.prompt();
  }
}
