import { Session, createClient, createPermissionPolicy, runTurn } from "@loccode/core";
import { detectBackend, printNoBackendError } from "./auto-detect.js";
import { buildConfig, toAgentConfig } from "./config.js";
import * as render from "./render.js";
import { startRepl } from "./repl.js";

const VERSION = "0.1.0";

const USAGE = `\
Usage: loccode [OPTIONS] [PROMPT]

Options:
  --url <URL>            Model server URL (default: auto-detect)
  --model <NAME>         Model name (default: auto-detect)
  --api-key <KEY>        API key (default: "")
  --permission <MODE>    read-only | workspace-write | allow-all (default: workspace-write)
  --resume <PATH>        Resume a saved session
  --no-tools             Disable tool execution (chat-only mode)
  --max-iterations <N>   Max tool-call loops per turn (default: 6)
  -h, --help             Show this help

Examples:
  loccode                          Start interactive REPL
  loccode "list all .ts files"     Single-turn mode
  loccode --url http://localhost:11434/v1 --model qwen2.5-coder:7b
`;

interface ParsedArgs {
  flags: {
    url?: string;
    model?: string;
    apiKey?: string;
    permission?: string;
    resume?: string;
    noTools: boolean;
    maxIterations?: number;
    help: boolean;
  };
  prompt: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs["flags"] = { noTools: false, help: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--url":
        flags.url = argv[++i];
        break;
      case "--model":
        flags.model = argv[++i];
        break;
      case "--api-key":
        flags.apiKey = argv[++i];
        break;
      case "--permission":
        flags.permission = argv[++i];
        break;
      case "--resume":
        flags.resume = argv[++i];
        break;
      case "--no-tools":
        flags.noTools = true;
        break;
      case "--max-iterations":
        flags.maxIterations = Number.parseInt(argv[++i] ?? "6", 10);
        break;
      default:
        if (!arg.startsWith("-")) positional.push(arg);
        break;
    }
  }

  return { flags, prompt: positional.length > 0 ? positional.join(" ") : null };
}

async function main(): Promise<void> {
  const { flags, prompt } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // Build config from flags, env, and file
  const cliConfig = buildConfig({
    url: flags.url,
    model: flags.model,
    apiKey: flags.apiKey,
    permission: flags.permission,
    maxIterations: flags.maxIterations,
  });

  // Auto-detect backend if URL or model not specified
  if (!cliConfig.baseUrl || !cliConfig.model) {
    const detected = await detectBackend();
    if (!detected) {
      printNoBackendError();
    } else {
      if (!cliConfig.baseUrl) cliConfig.baseUrl = detected.url;
      if (!cliConfig.model) cliConfig.model = detected.model;
    }
  }

  const agentConfig = toAgentConfig(cliConfig, process.cwd());

  // Resume session if --resume given
  let session: Session | null = null;
  if (flags.resume) {
    try {
      session = Session.load(flags.resume);
      process.stdout.write(
        render.renderInfo(`Resumed session ${session.id} (${session.messages.length} messages)`),
      );
    } catch {
      process.stderr.write(`Cannot load session: ${flags.resume}\n`);
      process.exit(1);
    }
  }

  // Single-turn mode
  if (prompt !== null) {
    const s = session ?? Session.new(agentConfig);
    const client = createClient(agentConfig);
    const policy = createPermissionPolicy(agentConfig.permissionMode);

    let totalIn = 0;
    let totalOut = 0;
    const writer = new render.BoxStreamWriter();
    let streaming = false;

    for await (const event of runTurn(client, s, prompt, agentConfig, policy)) {
      switch (event.type) {
        case "text_delta":
          if (!streaming) {
            process.stdout.write(render.renderAssistantBoxStart());
            streaming = true;
          }
          writer.write(event.content);
          break;
        case "tool_call_start":
          if (streaming) {
            writer.flush();
            process.stdout.write(render.renderAssistantBoxEnd(0, 0));
            streaming = false;
          }
          process.stdout.write(
            `  ${render.GRAY}▸${render.R}  ${render.CYAN}${event.name}${render.R}\n`,
          );
          break;
        case "tool_result":
          process.stdout.write(render.renderToolResult(event.name, event.output, event.isError));
          break;
        case "usage":
          totalIn += event.inputTokens;
          totalOut += event.outputTokens;
          break;
        case "guardrail_triggered":
          if (streaming) {
            writer.flush();
            streaming = false;
          }
          process.stdout.write(render.renderGuardrail(event.reason));
          break;
        case "turn_complete":
          if (streaming) {
            writer.flush();
            process.stdout.write(render.renderAssistantBoxEnd(totalIn, totalOut));
            streaming = false;
          } else if (totalIn > 0 || totalOut > 0)
            process.stdout.write(render.renderUsage(totalIn, totalOut));
          break;
        case "error":
          if (streaming) {
            writer.flush();
            streaming = false;
          }
          process.stderr.write(render.renderError(event.message));
          break;
      }
    }

    process.exit(0);
  }

  // Interactive REPL
  render.renderHeader(agentConfig.model, agentConfig.baseUrl, VERSION);

  if (session) {
    // Inject resumed session into REPL — patch agentConfig and pass
    await startRepl({ ...agentConfig });
  } else {
    await startRepl(agentConfig);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
