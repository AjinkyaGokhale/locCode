import * as vscode from "vscode";
import { getAgentConfig, onConfigChange } from "./config";
import { ChatPanelProvider } from "./chat-panel";
import { LocCodeLensProvider } from "./inline-actions";
import { StatusBarManager } from "./status-bar";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Load config — fail gracefully if something goes wrong
  let config: Awaited<ReturnType<typeof getAgentConfig>>;
  try {
    config = await getAgentConfig();
  } catch (err) {
    vscode.window.showErrorMessage(`LocCode: failed to load config — ${err}`);
    return;
  }

  // Status bar
  const statusBar = new StatusBarManager();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  // Chat panel
  const chatPanel = new ChatPanelProvider(context.extensionUri, config, statusBar, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, chatPanel),
  );

  // Inline code lens
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, new LocCodeLensProvider()),
  );

  // Probe connectivity — show notification if no backend found
  probeConnectivity(config.baseUrl).then((connected) => {
    statusBar.update(config, connected);
    if (!connected || !config.model) {
      showNoBackendNotification();
    }
  });

  // React to settings changes
  context.subscriptions.push(
    onConfigChange(async (configPromise) => {
      const newConfig = await configPromise;
      chatPanel.updateConfig(newConfig);
      probeConnectivity(newConfig.baseUrl).then((connected) => {
        statusBar.update(newConfig, connected);
      });
    }),
  );

  // ── Commands ─────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("loccode.openChat", () => {
      vscode.commands.executeCommand("loccode.chatView.focus");
    }),

    vscode.commands.registerCommand("loccode.explainSelection", async () => {
      const code = getSelection();
      if (!code) return;
      await focusChat();
      chatPanel.sendUserMessage(`Explain this code:\n\n\`\`\`\n${code}\n\`\`\``);
    }),

    vscode.commands.registerCommand("loccode.editSelection", async () => {
      const code = getSelection();
      if (!code) return;
      const instruction = await vscode.window.showInputBox({
        prompt: "Edit instruction",
        placeHolder: "e.g. Add error handling",
      });
      if (!instruction) return;
      await focusChat();
      chatPanel.sendUserMessage(`${instruction}\n\nCode:\n\`\`\`\n${code}\n\`\`\``);
    }),

    vscode.commands.registerCommand("loccode.fixSelection", async () => {
      const code = getSelection();
      if (!code) return;
      await focusChat();
      chatPanel.sendUserMessage(`Fix issues in this code:\n\n\`\`\`\n${code}\n\`\`\``);
    }),

    vscode.commands.registerCommand("loccode.writeTests", async () => {
      const code = getSelection();
      if (!code) return;
      await focusChat();
      chatPanel.sendUserMessage(`Write tests for this code:\n\n\`\`\`\n${code}\n\`\`\``);
    }),

    vscode.commands.registerCommand("loccode.inlineChat", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Ask LocCode",
        placeHolder: "e.g. Refactor this file to use async/await",
      });
      if (!input) return;
      await focusChat();
      chatPanel.sendUserMessage(input);
    }),
  );
}

export function deactivate(): void {}

// ── Helpers ───────────────────────────────────────────────────────────────

function getSelection(): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const { selection } = editor;
  return selection.isEmpty
    ? editor.document.getText()
    : editor.document.getText(selection);
}

async function focusChat(): Promise<void> {
  await vscode.commands.executeCommand("loccode.chatView.focus");
}

async function probeConnectivity(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const ollamaUrl = `${baseUrl.replace(/\/v1\/?$/, "")}/api/tags`;
    const resp = await fetch(ollamaUrl, { signal: controller.signal });
    if (resp.ok) return true;
  } catch {
    // fall through
  } finally {
    clearTimeout(timer);
  }

  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), 3000);
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      signal: controller2.signal,
      headers: { Authorization: "Bearer not-needed" },
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer2);
  }
}

function showNoBackendNotification(): void {
  vscode.window
    .showWarningMessage(
      "LocCode: No local model backend found. Start Ollama, LM Studio, or llama.cpp, then reload.",
      "Open Settings",
      "Reload Window",
    )
    .then((choice) => {
      if (choice === "Open Settings") {
        vscode.commands.executeCommand("workbench.action.openSettings", "loccode");
      } else if (choice === "Reload Window") {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
}
