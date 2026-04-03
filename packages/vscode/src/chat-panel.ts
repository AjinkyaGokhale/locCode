import * as fs from "node:fs";
import * as path from "node:path";
import {
  MemoryWorkerClientImpl,
  Session,
  createClient,
  createMemoryHooks,
  createNoopHooks,
  runTurn,
} from "@loccode/core";
import type {
  AgentConfig,
  LifecycleHooks,
  PermissionPolicy,
  PermissionResult,
} from "@loccode/core";
import * as vscode from "vscode";

// Injected by webpack DefinePlugin at build time
declare const MEMORY_WORKER_SCRIPT: string;

import type { StatusBarManager } from "./status-bar";

// Messages sent from webview → extension
type WebviewMessage =
  | { type: "sendMessage"; text: string }
  | { type: "clearSession" }
  | { type: "saveSession" }
  | { type: "changePermission"; mode: AgentConfig["permissionMode"] }
  | { type: "reloadWindow" }
  | { type: "openSettings" }
  | { type: "toolPermission"; id: string; decision: "allow" | "always" | "deny" }
  | { type: "trustDir" }
  | { type: "denyTrust" };

// Messages sent from extension → webview
type ExtensionMessage =
  | { type: "textDelta"; content: string }
  | { type: "toolCallStart"; id: string; name: string }
  | { type: "toolCallInput"; id: string; partialInput: string }
  | { type: "toolResult"; id: string; name: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turnComplete"; iterations: number }
  | { type: "guardrailTriggered"; reason: string }
  | { type: "error"; message: string }
  | { type: "sessionCleared" }
  | { type: "sessionSaved"; path: string }
  | { type: "permissionChanged"; mode: AgentConfig["permissionMode"] }
  | {
      type: "init";
      permissionMode: AgentConfig["permissionMode"];
      model: string;
      trusted: boolean;
      dir: string;
      maxTokens: number;
    }
  | { type: "trustGranted" }
  | { type: "compacted" };

// Memory worker that overrides start() to use the webpack-injected script path
class ExtensionMemoryWorker extends MemoryWorkerClientImpl {
  private workerEnv: NodeJS.ProcessEnv;

  constructor(config: AgentConfig) {
    super(config.cwd);
    this.workerEnv = {
      ...process.env,
      LOCCODE_WORKER_CWD: config.cwd,
      LOCCODE_BASE_URL: config.baseUrl,
      LOCCODE_MODEL: config.model,
    };
  }

  override async start(): Promise<void> {
    if (await this.isRunning()) return;
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, [MEMORY_WORKER_SCRIPT], {
        detached: true,
        stdio: "ignore",
        env: this.workerEnv,
      });
      child.unref();
      // Wait up to 5s for worker to be ready
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await this.isRunning()) return;
      }
    } catch {
      // Spawning failed — memory disabled
    }
  }
}

class AsyncPermissionPolicy implements PermissionPolicy {
  private pending = new Map<string, (result: PermissionResult) => void>();
  private alwaysAllow = false;
  private post: (msg: unknown) => void;
  private mode: AgentConfig["permissionMode"];

  constructor(mode: AgentConfig["permissionMode"], post: (msg: unknown) => void, trusted = false) {
    this.mode = mode;
    this.post = post;
    this.alwaysAllow = trusted;
  }

  setTrusted(trusted: boolean): void {
    this.alwaysAllow = trusted;
    // Resolve any pending bash approvals that are waiting
    for (const [id, resolve] of this.pending) {
      resolve({ outcome: "allow", reason: "" });
      this.pending.delete(id);
    }
  }

  async authorize(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    if (this.mode === "allow-all" || this.alwaysAllow) {
      return { outcome: "allow", reason: "" };
    }
    if (this.mode === "read-only") {
      const safe = new Set(["read_file", "glob_search", "grep_search"]);
      return safe.has(toolName)
        ? { outcome: "allow", reason: "" }
        : { outcome: "deny", reason: `Tool "${toolName}" is not allowed in read-only mode` };
    }
    // workspace-write: prompt for bash
    if (toolName === "bash") {
      if (this.alwaysAllow) return { outcome: "allow", reason: "" };
      const id = Math.random().toString(36).slice(2, 10);
      const command = (input.command as string | undefined) ?? String(input);
      this.post({ type: "permissionRequest", id, command });
      return new Promise<PermissionResult>((resolve) => {
        this.pending.set(id, resolve);
      });
    }
    return { outcome: "allow", reason: "" };
  }

  resolve(id: string, decision: "allow" | "always" | "deny"): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    if (decision === "always") {
      this.alwaysAllow = true;
      resolve({ outcome: "allow", reason: "" });
    } else if (decision === "allow") {
      resolve({ outcome: "allow", reason: "" });
    } else {
      resolve({ outcome: "deny", reason: "Denied by user" });
    }
  }
}

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "loccode.chatView";

  private view?: vscode.WebviewView;
  private session: Session | undefined = undefined;
  private config: AgentConfig;
  private statusBar: StatusBarManager;
  private extensionUri: vscode.Uri;
  private extContext: vscode.ExtensionContext;
  private isRunning = false;
  private permPolicy: AsyncPermissionPolicy | undefined = undefined;
  private memoryWorker: ExtensionMemoryWorker | undefined = undefined;

  private static readonly TRUST_KEY = "loccode.trustedDirs";

  constructor(
    extensionUri: vscode.Uri,
    config: AgentConfig,
    statusBar: StatusBarManager,
    extContext: vscode.ExtensionContext,
  ) {
    this.extensionUri = extensionUri;
    this.config = config;
    this.statusBar = statusBar;
    this.extContext = extContext;
    this.memoryWorker = new ExtensionMemoryWorker(config);
  }

  private isTrusted(dir: string): boolean {
    const trusted = this.extContext.workspaceState.get<string[]>(ChatPanelProvider.TRUST_KEY, []);
    return trusted.includes(dir);
  }

  private async setTrusted(dir: string): Promise<void> {
    const trusted = this.extContext.workspaceState.get<string[]>(ChatPanelProvider.TRUST_KEY, []);
    if (!trusted.includes(dir)) {
      await this.extContext.workspaceState.update(ChatPanelProvider.TRUST_KEY, [...trusted, dir]);
    }
    this.permPolicy?.setTrusted(true);
    this.post({ type: "trustGranted" });
  }

  updateConfig(config: AgentConfig): void {
    this.config = config;
    this.memoryWorker = new ExtensionMemoryWorker(config);
    this.post({ type: "permissionChanged", mode: config.permissionMode });
    this.post({
      type: "init",
      permissionMode: config.permissionMode,
      model: config.model,
      trusted: this.isTrusted(config.cwd),
      dir: config.cwd,
      maxTokens: config.maxTokensBeforeCompact,
    });
  }

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg));

    // Send initial state once webview is ready (small delay for load)
    setTimeout(() => {
      this.post({
        type: "init",
        permissionMode: this.config.permissionMode,
        model: this.config.model,
        trusted: this.isTrusted(this.config.cwd),
        dir: this.config.cwd,
        maxTokens: this.config.maxTokensBeforeCompact,
      });
    }, 300);
  }

  /** Send a prefilled user message (from inline actions / commands) */
  sendUserMessage(text: string): void {
    if (!this.view) return;
    // Reveal the panel
    this.view.show?.(true);
    // Post message to webview so it appears in the chat, then trigger agent
    this.runAgentTurn(text);
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "sendMessage":
        if (!this.isRunning) await this.runAgentTurn(msg.text);
        break;
      case "clearSession":
        this.session = undefined;
        this.post({ type: "sessionCleared" });
        break;
      case "saveSession":
        await this.saveSession();
        break;
      case "changePermission":
        this.config = { ...this.config, permissionMode: msg.mode };
        this.post({ type: "permissionChanged", mode: msg.mode });
        break;
      case "toolPermission":
        this.permPolicy?.resolve(msg.id, msg.decision);
        break;
      case "trustDir":
        await this.setTrusted(this.config.cwd);
        break;
      case "denyTrust":
        // User said no — nothing to store, just leave as-is
        break;
      case "reloadWindow":
        vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
      case "openSettings":
        vscode.commands.executeCommand("workbench.action.openSettings", "loccode");
        break;
    }
  }

  private async runAgentTurn(userInput: string): Promise<void> {
    if (this.isRunning) return;

    // Guard: no model detected
    if (!this.config.model) {
      this.post({
        type: "error",
        message:
          "No local model found. Start Ollama, LM Studio, or llama.cpp, then set a model in Settings (loccode.model).",
      });
      return;
    }

    this.isRunning = true;
    this.statusBar.setThinking(true);

    try {
      if (!this.session) {
        this.session = Session.new(this.config);
      }

      const client = createClient(this.config);
      this.permPolicy = new AsyncPermissionPolicy(
        this.config.permissionMode,
        (msg) => this.post(msg as ExtensionMessage),
        this.isTrusted(this.config.cwd),
      );

      // Start memory worker if not already running, use noop hooks on failure
      let hooks: LifecycleHooks = createNoopHooks();
      if (this.memoryWorker) {
        try {
          if (!(await this.memoryWorker.isRunning())) {
            await this.memoryWorker.start();
          }
          if (await this.memoryWorker.isRunning()) {
            hooks = createMemoryHooks(this.memoryWorker);
          }
        } catch {
          // Memory unavailable — proceed without it
        }
      }

      for await (const event of runTurn(
        client,
        this.session,
        userInput,
        this.config,
        this.permPolicy,
        hooks,
      )) {
        switch (event.type) {
          case "text_delta":
            this.post({ type: "textDelta", content: event.content });
            break;
          case "tool_call_start":
            this.post({ type: "toolCallStart", id: event.id, name: event.name });
            break;
          case "tool_call_input":
            this.post({ type: "toolCallInput", id: event.id, partialInput: event.partialInput });
            break;
          case "tool_result":
            this.post({
              type: "toolResult",
              id: event.id,
              name: event.name,
              output: event.output,
              isError: event.isError,
            });
            // If edit_file succeeded, offer a diff view
            if (event.name === "edit_file" && !event.isError) {
              await this.offerDiff(event.output);
            }
            break;
          case "usage":
            this.post({
              type: "usage",
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
            });
            break;
          case "compacted":
            this.post({ type: "compacted" });
            break;
          case "turn_complete":
            this.post({ type: "turnComplete", iterations: event.iterations });
            break;
          case "guardrail_triggered":
            this.post({ type: "guardrailTriggered", reason: event.reason });
            break;
          case "error":
            this.post({ type: "error", message: event.message });
            break;
        }
      }
    } catch (err) {
      this.post({ type: "error", message: String(err) });
    } finally {
      this.isRunning = false;
      this.statusBar.setThinking(false);
    }
  }

  private async saveSession(): Promise<void> {
    if (!this.session) {
      this.post({ type: "error", message: "No session to save." });
      return;
    }
    const dir = path.join(this.config.cwd, ".loccode", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    this.session.save(dir);
    this.post({ type: "sessionSaved", path: path.join(dir, `${this.session.id}.json`) });
  }

  private async offerDiff(toolOutput: string): Promise<void> {
    // Parse "Replaced N occurrence(s) in <path>" to find the file
    const match = /in (.+)$/.exec(toolOutput.trim());
    if (!match) return;
    const filePath = match[1].trim();
    if (!fs.existsSync(filePath)) return;

    const answer = await vscode.window.showInformationMessage(
      `LocCode edited ${path.basename(filePath)}`,
      "Open Diff",
      "Dismiss",
    );
    if (answer === "Open Diff") {
      const uri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand("vscode.open", uri);
    }
  }

  private post(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(this.extensionUri.fsPath, "src", "webview", "index.html");

    // URI for compiled webview JS
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "chat.js"),
    );
    // URI for CSS
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "src", "webview", "chat.css"),
    );

    const nonce = getNonce();

    let html = fs.readFileSync(htmlPath, "utf8");
    html = html
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{scriptUri\}/g, scriptUri.toString())
      .replace(/\$\{cssUri\}/g, cssUri.toString())
      .replace(/\$\{cspSource\}/g, webview.cspSource);

    return html;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
