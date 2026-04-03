import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@loccode/core";

export interface CliConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  permissionMode: AgentConfig["permissionMode"];
  maxIterations: number;
  fewShotExamples: boolean;
}

const DEFAULTS: CliConfig = {
  baseUrl: "",
  model: "",
  apiKey: "",
  permissionMode: "workspace-write",
  maxIterations: 6,
  fewShotExamples: false,
};

export const CONFIG_PATH = join(homedir(), ".loccode", "config.json");
export const HISTORY_PATH = join(homedir(), ".loccode", "history");

function loadFileConfig(): Partial<CliConfig> {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as Partial<CliConfig>;
  } catch {
    return {};
  }
}

function loadEnvConfig(): Partial<CliConfig> {
  const env: Partial<CliConfig> = {};
  if (process.env.LOCCODE_BASE_URL) env.baseUrl = process.env.LOCCODE_BASE_URL;
  if (process.env.LOCCODE_MODEL) env.model = process.env.LOCCODE_MODEL;
  if (process.env.LOCCODE_API_KEY) env.apiKey = process.env.LOCCODE_API_KEY;
  if (process.env.LOCCODE_PERMISSION) {
    const p = process.env.LOCCODE_PERMISSION;
    if (p === "read-only" || p === "workspace-write" || p === "allow-all") {
      env.permissionMode = p;
    }
  }
  return env;
}

export interface CliFlags {
  url?: string;
  model?: string;
  apiKey?: string;
  permission?: string;
  maxIterations?: number;
}

function parseFlagPermission(p: string | undefined): AgentConfig["permissionMode"] | undefined {
  if (p === "read-only" || p === "workspace-write" || p === "allow-all") return p;
  return undefined;
}

export function buildConfig(flags: CliFlags): CliConfig {
  const file = loadFileConfig();
  const env = loadEnvConfig();

  const flagConfig: Partial<CliConfig> = {};
  if (flags.url) flagConfig.baseUrl = flags.url;
  if (flags.model) flagConfig.model = flags.model;
  if (flags.apiKey) flagConfig.apiKey = flags.apiKey;
  const flagPerm = parseFlagPermission(flags.permission);
  if (flagPerm) flagConfig.permissionMode = flagPerm;
  if (flags.maxIterations !== undefined) flagConfig.maxIterations = flags.maxIterations;

  // Priority: flags > env > file > defaults
  return { ...DEFAULTS, ...file, ...env, ...flagConfig };
}

export function toAgentConfig(cli: CliConfig, cwd: string): AgentConfig {
  return {
    baseUrl: cli.baseUrl,
    model: cli.model,
    apiKey: cli.apiKey,
    permissionMode: cli.permissionMode,
    maxIterations: cli.maxIterations,
    maxTokensBeforeCompact: 8000,
    cwd,
    fewShotExamples: cli.fewShotExamples,
  };
}
