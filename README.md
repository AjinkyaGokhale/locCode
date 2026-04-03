# LocCode

**Local-first AI coding agent. Your code, your machine, your model.**

LocCode is an open-source AI coding assistant that runs entirely on your hardware using any local model backend (Ollama, llama.cpp, LM Studio, vLLM). It ships as both a CLI tool and a VS Code extension, powered by a shared core library built specifically for local model reliability.

> **Status:** Active development — Phase 1 (core) and Phase 2 (CLI) complete. See [roadmap](#roadmap).

---

## Why LocCode?

Local models produce malformed tool calls, get stuck in loops, and drift from instructions more often than hosted models. LocCode is engineered around those realities:

| Problem | LocCode's Solution |
|---------|-------------------|
| Malformed JSON tool calls | 8-step recovery parser that fixes output before execution |
| Infinite tool loops | Guardrail engine detects repetition, error cascades, and runaway bash |
| Context ballooning | Automatic session compaction with configurable token budgets |
| Zero-config startup | Auto-detects running backends (Ollama, LM Studio, llama.cpp) |
| Unsafe tool execution | 3-mode permission system (read-only / workspace-write / allow-all) |

---

## Features

- **Interactive REPL** — persistent sessions, `/save` / `/load`, Markdown rendering
- **Single-turn mode** — pipe-friendly: `loccode "explain this file"`
- **6 built-in tools** — bash, read\_file, write\_file, edit\_file, glob\_search, grep\_search
- **Session persistence** — JSON format, resume across restarts with `--resume`
- **Auto backend detection** — probes Ollama → LM Studio → llama.cpp on startup
- **Cloud fallback** — works with OpenAI, Anthropic-compatible APIs, or any OpenAI-compatible endpoint
- **VS Code extension** — chat panel + inline code actions *(Phase 4, coming soon)*

---

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@loccode/core`](packages/core) | — | Shared agent library — tools, session, recovery, guardrails, compaction |
| [`loccode`](packages/cli) | `npm i -g loccode` | CLI — interactive REPL + single-turn mode |
| [`loccode-vscode`](packages/vscode) | VS Code Marketplace | VS Code extension *(Phase 4)* |

---

## Quick Start

### Prerequisites

- Node.js 20+
- A running local model backend (see [Backend Support](#backend-support))

### Install

```bash
npm install -g loccode
```

### Run

```bash
# Auto-detects a running backend
loccode

# Single-turn mode
loccode "list all TypeScript files in src/"

# Point at a specific backend and model
loccode --url http://localhost:11434/v1 --model qwen2.5-coder:7b
```

### REPL Commands

```
/help                   Show all commands
/status                 Session info: model, backend, token estimate
/compact                Manually summarise the conversation
/clear                  Reset session
/save [path]            Save session to JSON
/load <path>            Load a saved session
/tools                  List available tools
/permission <mode>      Switch permission mode mid-session
/model <name>           Switch model without losing history
/exit                   Exit
```

---

## Backend Support

LocCode auto-detects backends running on localhost. You can also specify `--url` and `--model` directly.

| Backend | Default URL | Auto-detect | Notes |
|---------|-------------|-------------|-------|
| [Ollama](https://ollama.ai) | `http://localhost:11434/v1` | Yes | Easiest setup |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | Yes | GUI app |
| [llama.cpp](https://github.com/ggerganov/llama.cpp) | `http://localhost:8080/v1` | Yes | Fastest inference |
| [vLLM](https://github.com/vllm-project/vllm) | any | No | Multi-GPU |
| OpenAI / compatible | `https://api.openai.com/v1` | No | Cloud fallback |

### Recommended Models

| Model | Size | Good for |
|-------|------|----------|
| `qwen2.5-coder:7b` | 4 GB | General coding, fast |
| `qwen2.5-coder:32b` | 20 GB | Complex refactoring |
| `deepseek-coder-v2:16b` | 9 GB | Strong instruction following |
| `codellama:13b` | 8 GB | Stable, widely tested |

---

## Permission Modes

| Mode | bash | read\_file | write\_file | edit\_file |
|------|------|------------|-------------|------------|
| `read-only` | No | Yes | No | No |
| `workspace-write` | Yes | Yes | Yes | Yes |
| `allow-all` | Yes | Yes | Yes | Yes |

Default is `workspace-write`. Switch at runtime with `/permission <mode>` or `--permission` flag.

---

## Development

```bash
# Prerequisites: Node.js 20+, pnpm 10+
git clone https://github.com/your-org/loccode
cd loccode
pnpm install
pnpm build
pnpm test
pnpm lint
```

### Project Structure

```
loccode/
├── packages/
│   ├── core/          @loccode/core — agent library (tools, session, guardrails)
│   │   ├── src/
│   │   │   ├── agent.ts        Agent turn loop (AsyncGenerator streaming)
│   │   │   ├── client.ts       OpenAI-compatible HTTP client
│   │   │   ├── tools/          6 built-in tools
│   │   │   ├── recovery.ts     Malformed JSON repair (8-step)
│   │   │   ├── guardrails.ts   Loop + cascade detection
│   │   │   ├── permissions.ts  3-mode permission policy
│   │   │   ├── session.ts      Session persistence (JSON)
│   │   │   ├── compact.ts      Context window management
│   │   │   └── prompt.ts       System prompt + few-shot examples
│   │   └── test/       115 unit tests (Vitest)
│   ├── cli/           loccode — CLI binary (REPL + single-turn)
│   └── vscode/        loccode-vscode — VS Code extension (Phase 4)
├── turbo.json
├── pnpm-workspace.yaml
└── biome.json
```

### Stack

- **TypeScript** — strict mode, ES2022, ESM
- **pnpm + Turborepo** — monorepo with parallel builds
- **tsup** — esbuild-based bundler (ESM + CJS dual output)
- **Vitest** — unit tests
- **Biome** — linting + formatting (replaces ESLint + Prettier)
- **OpenAI SDK** — with configurable `baseURL` for local backends

### Contributing

1. Fork the repo and create a branch
2. Make changes — keep them focused and minimal
3. Run `pnpm test` and `pnpm lint` — both must pass
4. Open a pull request with a clear description

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/your-org/loccode/issues).

---

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 — Core | **Complete** | `@loccode/core`: agent loop, 6 tools, guardrails, recovery, session, compaction — 115 tests |
| Phase 2 — CLI | **Complete** | `loccode` binary: REPL, single-turn, auto-detect, Markdown rendering, spinner |
| Phase 3 — Memory | Planned | SQLite + local embeddings, session-aware recall, `autoDream` consolidation |
| Phase 4 — VS Code | Planned | Chat panel, inline code actions, status bar, diff preview |
| Phase 5 — Polish | Planned | Docs, CI/CD, npm + marketplace publishing |

---

## License

[AGPL-3.0](LICENSE) — free to use, modify, and distribute. If you ship a modified version as a networked service, you must publish your source under the same license.
