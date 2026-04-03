// Webview script — runs in the browser context inside VS Code's webview.
// No Node.js APIs are available here.

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// ── Types ────────────────────────────────────────────────────────────────

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
  | { type: "permissionChanged"; mode: string }
  | { type: "init"; permissionMode: string; model: string; trusted: boolean; dir: string; maxTokens: number }
  | { type: "permissionRequest"; id: string; command: string }
  | { type: "trustGranted" }
  | { type: "compacted" };

// ── State ────────────────────────────────────────────────────────────────

const vscode = acquireVsCodeApi();
let isThinking = false;
let currentAssistantEl: HTMLElement | null = null;
let currentTextEl: HTMLElement | null = null;
let lastInputTokens = 0;  // latest prompt size — best proxy for current context fill
let maxTokens = 8000;
let permissionMode = "workspace-write";

// Track open tool call groups by id
const toolGroups = new Map<string, { details: HTMLDetailsElement; inputEl: HTMLElement; outputEl: HTMLElement | null }>();

// ── DOM refs ─────────────────────────────────────────────────────────────

const messagesEl = document.getElementById("messages")!;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("btn-send") as HTMLButtonElement;
const clearBtn = document.getElementById("btn-clear") as HTMLButtonElement;
const saveBtn = document.getElementById("btn-save") as HTMLButtonElement;
const clearConfirm = document.getElementById("clear-confirm")!;
const btnClearYes = document.getElementById("btn-clear-yes") as HTMLButtonElement;
const btnClearNo = document.getElementById("btn-clear-no") as HTMLButtonElement;
const ctxFill = document.getElementById("ctx-fill")!;
const ctxLabel = document.getElementById("ctx-label")!;
const ctxStatus = document.getElementById("ctx-status")!;
const permBar = document.getElementById("permission-bar")!;
const permModeText = document.getElementById("perm-mode-text")!;
const permButtons = document.querySelectorAll<HTMLButtonElement>(".perm-btn");
const permDismiss = document.getElementById("perm-dismiss")!;
const modelNameEl = document.getElementById("model-name")!;
const modelDotEl = document.getElementById("model-dot")!;
const noBackendBanner = document.getElementById("no-backend-banner")!;
const reloadLink = document.getElementById("reload-link")!;
const settingsLink = document.getElementById("settings-link")!;
const trustBanner = document.getElementById("trust-banner")!;
const trustDirPath = document.getElementById("trust-dir-path")!;
const btnTrust = document.getElementById("btn-trust") as HTMLButtonElement;
const btnDenyTrust = document.getElementById("btn-deny-trust") as HTMLButtonElement;

let permHideTimer: ReturnType<typeof setTimeout> | null = null;

// ── Init ─────────────────────────────────────────────────────────────────

sendBtn.addEventListener("click", sendMessage);

// Save — flash icon briefly
saveBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "saveSession" });
});

// Clear — show inline confirm
clearBtn.addEventListener("click", () => {
  clearConfirm.style.display = "flex";
});
btnClearYes.addEventListener("click", () => {
  clearConfirm.style.display = "none";
  vscode.postMessage({ type: "clearSession" });
});
btnClearNo.addEventListener("click", () => {
  clearConfirm.style.display = "none";
});
// Dismiss confirm on outside click
document.addEventListener("click", (e) => {
  if (!clearConfirm.contains(e.target as Node) && e.target !== clearBtn) {
    clearConfirm.style.display = "none";
  }
});

inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
});

permDismiss.addEventListener("click", () => hidePermBar());

permButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset["mode"]!;
    permissionMode = mode;
    vscode.postMessage({ type: "changePermission", mode });
    updatePermUI(mode);
    // Hide shortly after selection so user sees the change
    schedulePermHide(800);
  });
});

// Hide on first keystroke
inputEl.addEventListener("keydown", () => hidePermBar(), { once: true });

reloadLink.addEventListener("click", (e) => {
  e.preventDefault();
  vscode.postMessage({ type: "reloadWindow" });
});

settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  vscode.postMessage({ type: "openSettings" });
});

btnTrust.addEventListener("click", () => {
  trustBanner.style.display = "none";
  vscode.postMessage({ type: "trustDir" });
});

btnDenyTrust.addEventListener("click", () => {
  trustBanner.style.display = "none";
  vscode.postMessage({ type: "denyTrust" });
});

// ── Message handler ───────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as ExtensionMessage;
  handleMessage(msg);
});

function handleMessage(msg: ExtensionMessage): void {
  switch (msg.type) {
    case "init":
      permissionMode = msg.permissionMode;
      maxTokens = msg.maxTokens;
      updatePermUI(msg.permissionMode);
      setNoBackend(!msg.model);
      if (msg.model) {
        modelNameEl.textContent = msg.model;
        modelDotEl.classList.remove("disconnected");
        showPermBarBriefly();
        if (!msg.trusted) {
          trustDirPath.textContent = msg.dir;
          trustBanner.style.display = "flex";
        }
      } else {
        modelNameEl.textContent = "no model connected";
        modelDotEl.classList.add("disconnected");
      }
      break;

    case "trustGranted":
      trustBanner.style.display = "none";
      break;

    case "textDelta":
      ensureAssistantEl();
      appendTextDelta(msg.content);
      scrollToBottom();
      break;

    case "toolCallStart": {
      ensureAssistantEl();
      const group = createToolGroup(msg.id, msg.name);
      currentAssistantEl!.appendChild(group.details);
      toolGroups.set(msg.id, group);
      scrollToBottom();
      break;
    }

    case "toolCallInput": {
      const group = toolGroups.get(msg.id);
      if (group) {
        group.inputEl.textContent = (group.inputEl.textContent ?? "") + msg.partialInput;
      }
      break;
    }

    case "toolResult": {
      const group = toolGroups.get(msg.id);
      if (group) {
        const hr = document.createElement("hr");
        hr.className = "tool-divider";
        group.details.appendChild(hr);

        const outputEl = document.createElement("div");
        outputEl.className = `tool-output${msg.isError ? " error" : ""}`;
        outputEl.textContent = msg.output.length > 2000
          ? `${msg.output.slice(0, 2000)}\n… (truncated)`
          : msg.output;
        group.details.appendChild(outputEl);
        // Auto-open on error
        if (msg.isError) group.details.open = true;
      }
      currentTextEl = null; // Force new text block after tool result
      scrollToBottom();
      break;
    }

    case "usage":
      if (msg.inputTokens > 0) lastInputTokens = msg.inputTokens;
      updateCtxBar();
      break;

    case "turnComplete":
      setThinking(false);
      currentAssistantEl = null;
      currentTextEl = null;
      toolGroups.clear();
      scrollToBottom();
      break;

    case "guardrailTriggered":
      setThinking(false);
      appendSystemMessage(`⚠ Guardrail triggered: ${msg.reason}`, "warning");
      currentAssistantEl = null;
      currentTextEl = null;
      break;

    case "error":
      setThinking(false);
      appendSystemMessage(`✖ Error: ${msg.message}`, "error");
      currentAssistantEl = null;
      currentTextEl = null;
      break;

    case "sessionCleared":
      messagesEl.innerHTML = "";
      lastInputTokens = 0;
      updateCtxBar();
      currentAssistantEl = null;
      currentTextEl = null;
      toolGroups.clear();
      appendSystemMessage("Session cleared.", "info");
      break;

    case "compacted":
      lastInputTokens = 0;
      updateCtxBar();
      ctxStatus.textContent = "auto-compacted";
      setTimeout(() => { ctxStatus.textContent = ""; }, 3000);
      appendSystemMessage("Context auto-compacted to free space.", "info");
      break;

    case "sessionSaved":
      appendSystemMessage(`Session saved to ${msg.path}`, "info");
      break;

    case "permissionChanged":
      permissionMode = msg.mode;
      updatePermUI(msg.mode);
      break;

    case "permissionRequest":
      showApprovalCard(msg.id, msg.command);
      scrollToBottom();
      break;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sendMessage(): void {
  const text = inputEl.value.trim();
  if (!text || isThinking) return;

  appendUserMessage(text);
  inputEl.value = "";
  inputEl.style.height = "auto";
  setThinking(true);

  vscode.postMessage({ type: "sendMessage", text });
}

function appendUserMessage(text: string): void {
  const el = document.createElement("div");
  el.className = "msg-user";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function ensureAssistantEl(): void {
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg-assistant";
    messagesEl.appendChild(currentAssistantEl);
    currentTextEl = null;
  }
}

function appendTextDelta(content: string): void {
  if (!currentTextEl) {
    currentTextEl = document.createElement("div");
    currentTextEl.className = "text-content";
    currentAssistantEl!.appendChild(currentTextEl);
  }
  // Simple inline markdown: bold, inline code
  currentTextEl.textContent = (currentTextEl.textContent ?? "") + content;
}

function createToolGroup(
  _id: string,
  name: string,
): { details: HTMLDetailsElement; inputEl: HTMLElement; outputEl: HTMLElement | null } {
  const details = document.createElement("details");
  details.className = "tool-group";

  const summary = document.createElement("summary");
  const nameSpan = document.createElement("span");
  nameSpan.className = "tool-name";
  nameSpan.textContent = name;
  summary.appendChild(nameSpan);
  details.appendChild(summary);

  const inputEl = document.createElement("div");
  inputEl.className = "tool-input";
  details.appendChild(inputEl);

  return { details, inputEl, outputEl: null };
}

function appendSystemMessage(
  text: string,
  kind: "info" | "warning" | "error",
): void {
  const el = document.createElement("div");
  el.style.cssText = `
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 3px;
    opacity: 0.8;
    color: ${kind === "error" ? "var(--vscode-errorForeground)" : kind === "warning" ? "var(--vscode-editorWarning-foreground)" : "var(--vscode-descriptionForeground)"};
  `;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function setThinking(thinking: boolean): void {
  isThinking = thinking;
  sendBtn.disabled = thinking;
  inputEl.disabled = thinking;
  modelDotEl.classList.toggle("thinking", thinking);

  if (thinking) {
    const dot = document.createElement("span");
    dot.className = "thinking-dot";
    dot.id = "thinking-indicator";
    dot.textContent = "●";
    ensureAssistantEl();
    currentAssistantEl!.appendChild(dot);
  } else {
    document.getElementById("thinking-indicator")?.remove();
    inputEl.disabled = false;
    inputEl.focus();
  }
}

function updatePermUI(mode: string): void {
  permModeText.textContent = mode;
  permButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset["mode"] === mode);
  });
}

function showPermBarBriefly(): void {
  permBar.classList.remove("hiding");
  permBar.style.display = "flex";
  schedulePermHide(4000);
}

function schedulePermHide(ms: number): void {
  if (permHideTimer) clearTimeout(permHideTimer);
  permHideTimer = setTimeout(() => hidePermBar(), ms);
}

function hidePermBar(): void {
  if (permHideTimer) { clearTimeout(permHideTimer); permHideTimer = null; }
  if (permBar.style.display === "none") return;
  permBar.classList.add("hiding");
  permBar.addEventListener("animationend", () => {
    permBar.style.display = "none";
    permBar.classList.remove("hiding");
  }, { once: true });
}

function updateCtxBar(): void {
  const pct = maxTokens > 0 ? Math.min((lastInputTokens / maxTokens) * 100, 100) : 0;
  ctxFill.style.width = `${pct}%`;
  ctxFill.classList.remove("warn", "danger");
  if (pct >= 90) {
    ctxFill.classList.add("danger");
    ctxStatus.textContent = "context full — compacting…";
  } else if (pct >= 70) {
    ctxFill.classList.add("warn");
    ctxStatus.textContent = "context filling up";
  } else {
    ctxStatus.textContent = "";
  }
  ctxLabel.textContent = lastInputTokens > 0
    ? `${lastInputTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`
    : "0 tokens";
}

function showApprovalCard(id: string, command: string): void {
  const tpl = document.getElementById("tpl-approval") as HTMLTemplateElement;
  const card = tpl.content.cloneNode(true) as DocumentFragment;
  const cardEl = card.querySelector(".approval-card") as HTMLElement;
  const cmdEl = card.querySelector(".approval-cmd") as HTMLElement;
  const allowBtn = card.querySelector(".approval-btn.allow") as HTMLButtonElement;
  const alwaysBtn = card.querySelector(".approval-btn.always") as HTMLButtonElement;
  const denyBtn = card.querySelector(".approval-btn.deny") as HTMLButtonElement;

  cmdEl.textContent = command;

  const resolve = (decision: "allow" | "always" | "deny") => {
    cardEl.classList.add("resolved");
    vscode.postMessage({ type: "toolPermission", id, decision });
  };

  allowBtn.addEventListener("click", () => resolve("allow"));
  alwaysBtn.addEventListener("click", () => resolve("always"));
  denyBtn.addEventListener("click", () => resolve("deny"));

  messagesEl.appendChild(card);
}

function setNoBackend(noBackend: boolean): void {
  noBackendBanner.style.display = noBackend ? "block" : "none";
  inputEl.disabled = noBackend;
  sendBtn.disabled = noBackend;
  if (noBackend) {
    inputEl.placeholder = "No model connected — start a local backend first";
  } else {
    inputEl.placeholder = "Ask LocCode…";
  }
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
