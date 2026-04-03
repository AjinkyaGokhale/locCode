import * as vscode from "vscode";
import type { AgentConfig } from "@loccode/core";

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private currentModel = "";
  private currentMode: AgentConfig["permissionMode"] = "workspace-write";
  private currentUrl = "";
  private connected = false;
  private thinking = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "workbench.action.openSettings";
    this.item.show();
    this.refresh();
  }

  update(config: AgentConfig, connected: boolean): void {
    this.currentModel = config.model || "no model";
    this.currentMode = config.permissionMode;
    this.currentUrl = config.baseUrl;
    this.connected = connected;
    this.thinking = false;
    this.refresh();
  }

  setThinking(thinking: boolean): void {
    this.thinking = thinking;
    this.refresh();
  }

  dispose(): void {
    this.item.dispose();
  }

  private refresh(): void {
    const modelLabel = this.currentModel || "no model";
    const modeLabel = this.currentMode;

    if (this.thinking) {
      this.item.text = `$(loading~spin) ${modelLabel} | thinking…`;
      this.item.color = undefined;
    } else {
      this.item.text = `$(robot) ${modelLabel} | ${modeLabel}`;
      this.item.color = this.connected
        ? undefined
        : new vscode.ThemeColor("statusBarItem.warningBackground");
    }

    const status = this.connected ? "Connected" : "Disconnected";
    this.item.tooltip = new vscode.MarkdownString(
      [
        "**LocCode**",
        "",
        `Backend: \`${this.currentUrl}\``,
        `Status: ${status}`,
        `Permission: ${this.currentMode}`,
        "",
        "_Click to open LocCode settings_",
      ].join("\n"),
    );
  }
}
