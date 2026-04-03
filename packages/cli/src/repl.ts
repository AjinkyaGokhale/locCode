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
import type { AgentConfig } from "@loccode/core";
import { HISTORY_PATH } from "./config.js";
import * as render from "./render.js";
import * as spinner from "./spinner.js";

interface ReplState {
  session: Session;
  config: AgentConfig;
  permissionMode: AgentConfig["permissionMode"];
}

// ─── Agent turn ───────────────────────────────────────────────────────────────
async function runAgentTurn(input: string, state: ReplState): Promise<void> {
  const client = createClient(state.config);
  const policy = createPermissionPolicy(state.permissionMode);

  spinner.start("thinking");

  let streaming = false; // are we currently inside an assistant box?
  let totalIn = 0;
  let totalOut = 0;
  const toolT = new Map<string, number>(); // tool id → start ms
  const writer = new render.BoxStreamWriter();

  try {
    for await (const ev of runTurn(client, state.session, input, state.config, policy)) {
      switch (ev.type) {
        case "text_delta": {
          if (!streaming) {
            spinner.stop();
            process.stdout.write(render.renderAssistantBoxStart());
            streaming = true;
          }
          writer.write(ev.content);
          break;
        }

        case "tool_call_start": {
          if (streaming) {
            writer.flush();
            process.stdout.write(render.renderAssistantBoxEnd(0, 0));
            streaming = false;
          } else {
            spinner.stop();
          }
          toolT.set(ev.id, Date.now());
          // Placeholder line — will be overwritten on tool_result
          process.stdout.write(
            `  ${render.ORANGE}⚡${render.R} ${render.CYAN}${ev.name}${render.R} ${render.DARK_GRAY}…${render.R}\n`,
          );
          spinner.start(ev.name);
          break;
        }

        case "tool_result": {
          spinner.stop();
          const elapsed = toolT.has(ev.id) ? Date.now() - toolT.get(ev.id)! : undefined;
          toolT.delete(ev.id);
          // Replace the placeholder "▸ name …" line
          process.stdout.write("\x1B[1A\x1B[2K");
          process.stdout.write(render.renderToolResult(ev.name, ev.output, ev.isError, elapsed));
          spinner.start("thinking");
          break;
        }

        case "usage":
          totalIn += ev.inputTokens;
          totalOut += ev.outputTokens;
          break;

        case "guardrail_triggered":
          if (streaming) {
            writer.flush();
            streaming = false;
          }
          spinner.stop();
          process.stdout.write(render.renderGuardrail(ev.reason));
          break;

        case "turn_complete":
          spinner.stop();
          if (streaming) {
            writer.flush();
            process.stdout.write(render.renderAssistantBoxEnd(totalIn, totalOut));
            streaming = false;
          } else if (totalIn > 0 || totalOut > 0) {
            process.stdout.write(render.renderUsage(totalIn, totalOut));
          }
          break;

        case "error":
          spinner.stop();
          if (streaming) {
            writer.flush();
            streaming = false;
          }
          process.stdout.write(render.renderError(ev.message));
          break;
      }
    }
  } catch (err) {
    spinner.stop();
    if (streaming) {
      writer.flush();
      streaming = false;
    }
    process.stdout.write(render.renderError(err instanceof Error ? err.message : String(err)));
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
async function handleCommand(
  line: string,
  state: ReplState,
  rl: ReturnType<typeof createInterface>,
): Promise<void> {
  const [rawCmd, ...args] = line.slice(1).trim().split(/\s+/);
  const cmd = rawCmd?.toLowerCase() ?? "";

  switch (cmd) {
    case "help":
      process.stdout.write(render.renderHelp());
      break;

    case "status":
      process.stdout.write(
        render.renderStatus({
          Session: state.session.id,
          Model: state.config.model,
          Server: state.config.baseUrl,
          Permission: state.permissionMode,
          Messages: String(state.session.messages.length),
          "~Tokens": estimateTokens(state.session).toLocaleString(),
        }),
      );
      break;

    case "compact": {
      const before = state.session.messages.length;
      spinner.start("compacting…");
      await compactSession(createClient(state.config), state.session, state.config);
      spinner.stop();
      process.stdout.write(
        render.renderSuccess(`Compacted: ${before} → ${state.session.messages.length} messages`),
      );
      break;
    }

    case "clear":
      state.session = Session.new(state.config);
      process.stdout.write(render.renderSuccess("Session cleared."));
      break;

    case "save": {
      const path =
        args[0] ?? resolve(process.cwd(), ".loccode", "sessions", `${state.session.id}.json`);
      mkdirSync(dirname(path), { recursive: true });
      process.stdout.write(render.renderSuccess(`Saved → ${state.session.save(dirname(path))}`));
      break;
    }

    case "load":
      if (!args[0]) {
        process.stdout.write(render.renderError("Usage: /load <path>"));
        break;
      }
      try {
        state.session = Session.load(args[0]);
        process.stdout.write(
          render.renderSuccess(
            `Loaded ${state.session.id} (${state.session.messages.length} msgs)`,
          ),
        );
      } catch {
        process.stdout.write(render.renderError(`Cannot load: ${args[0]}`));
      }
      break;

    case "tools":
      process.stdout.write(render.renderToolsTable(TOOL_DEFINITIONS));
      break;

    case "permission": {
      const m = args[0];
      if (m === "read-only" || m === "workspace-write" || m === "allow-all") {
        state.permissionMode = m;
        process.stdout.write(render.renderSuccess(`Permission → ${m}`));
      } else {
        process.stdout.write(render.renderError("Modes: read-only | workspace-write | allow-all"));
      }
      break;
    }

    case "model":
      if (!args[0]) {
        process.stdout.write(render.renderError("Usage: /model <name>"));
        break;
      }
      state.config = { ...state.config, model: args[0] };
      process.stdout.write(render.renderSuccess(`Model → ${args[0]}`));
      break;

    case "mem":
      process.stdout.write(render.renderInfo("Memory viewer → http://localhost:37899/viewer"));
      break;

    case "exit":
    case "quit":
      rl.close();
      process.stdout.write("\n");
      process.exit(0);
      break;

    default:
      process.stdout.write(render.renderError(`Unknown command: /${cmd}  —  type /help`));
  }
}

// ─── REPL entry ───────────────────────────────────────────────────────────────
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
    prompt: render.PROMPT_STR,
    historySize: 500,
    // @ts-expect-error — not in types but works in Node ≥18
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  // Patch stdout to prevent readline's clearScreenDown from erasing the bottom frame.
  // readline calls \x1B[0J (clearScreenDown) on every keypress refresh; we replace it
  // with \x1B[2K\r (clear current line only) so pre-drawn lines below the cursor persist.
  let _origWrite: typeof process.stdout.write | null = null;

  function patchStdout(): void {
    if (_origWrite) return;
    const orig = process.stdout.write.bind(process.stdout);
    _origWrite = orig;
    // @ts-expect-error — intentional monkey-patch
    process.stdout.write = (chunk: unknown, ...rest: unknown[]) => {
      // Replace clearScreenDown (ESC[J / ESC[0J) with clear-line-only to preserve bottom frame
      const clearScreenDown = new RegExp(`${"\x1B"}\\[0?J`, "g");
      const out = typeof chunk === "string" ? chunk.replace(clearScreenDown, "\x1B[2K\r") : chunk;
      return (orig as (c: unknown, ...r: unknown[]) => boolean)(out, ...rest);
    };
  }

  function unpatchStdout(): void {
    if (_origWrite) {
      // @ts-expect-error — restoring original
      process.stdout.write = _origWrite;
      _origWrite = null;
    }
  }

  /** Draw top border, pre-render bottom frame below input line, then show readline prompt */
  function doPrompt(): void {
    unpatchStdout();
    process.stdout.write(render.renderInputTop());
    // Draw bottom line + patience below the (blank) input line, then cursor-up back to it
    process.stdout.write(`\n${render.renderInputBottom()}\x1B[2A\r`);
    patchStdout();
    rl.prompt();
  }

  rl.on("SIGINT", () => {
    if (spinner.isSpinning()) {
      spinner.stop();
      process.stdout.write(render.renderInfo("Cancelled."));
      doPrompt();
    } else {
      unpatchStdout();
      // cursor is on the input line; move down past bottom border + patience line before exiting
      process.stdout.write("\x1B[2B\n");
      process.exit(0);
    }
  });

  doPrompt();

  for await (const line of rl) {
    unpatchStdout();
    const trimmed = line.trim();
    if (!trimmed) {
      doPrompt();
      continue;
    }

    // Show the user's message as a styled bubble
    process.stdout.write(render.renderUserBubble(trimmed));

    if (trimmed.startsWith("/")) {
      await handleCommand(trimmed, state, rl);
    } else {
      await runAgentTurn(trimmed, state);
    }

    doPrompt();
  }
}
