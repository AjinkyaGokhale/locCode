import type { ToolDefinition } from "./types.js";

// Common field name substitutions local models make
const FIELD_ALIASES: Record<string, Record<string, string>> = {
  bash: { cmd: "command", shell_command: "command", exec: "command" },
  read_file: { file: "path", filename: "path", file_path: "path" },
  write_file: {
    file: "path",
    filename: "path",
    file_path: "path",
    text: "content",
    data: "content",
  },
  edit_file: {
    file: "path",
    find: "old_string",
    search: "old_string",
    replace: "new_string",
    replacement: "new_string",
  },
  glob_search: { glob: "pattern", query: "pattern", dir: "path", directory: "path" },
  grep_search: {
    regex: "pattern",
    search: "pattern",
    query: "pattern",
    dir: "path",
    directory: "path",
  },
};

function tryParse(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

function applyFieldNameMapping(
  obj: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  const aliases = FIELD_ALIASES[toolName];
  if (!aliases) return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[aliases[key] ?? key] = value;
  }
  return result;
}

/**
 * Attempts to recover valid tool-call JSON from malformed model output.
 *
 * Handles the most common local model failure patterns:
 * 1. Markdown code fences wrapping JSON
 * 2. Trailing commas
 * 3. Single-quoted strings
 * 4. Unquoted keys
 * 5. Comments in JSON
 * 6. Truncated JSON (missing closing braces)
 * 7. Extra text before/after JSON
 * 8. Wrong field names (common substitutions)
 */
export function recoverToolInput(
  raw: string,
  toolName: string,
  _toolDefs: ToolDefinition[],
): Record<string, unknown> {
  // Step 1: Try parsing as-is
  const direct = tryParse(raw);
  if (direct) return applyFieldNameMapping(direct, toolName);

  // Step 2: Strip markdown fences
  let cleaned = raw
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();

  // Step 3: Extract JSON object from surrounding text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  // Step 4: Fix common syntax issues
  cleaned = cleaned
    .replace(/,\s*([}\]])/g, "$1") // trailing commas
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/'/g, '"') // single → double quotes
    .replace(/(\b\w+\b)\s*:/g, '"$1":'); // unquoted keys

  // Step 5: Close truncated JSON
  const opens = (cleaned.match(/\{/g) ?? []).length;
  const closes = (cleaned.match(/\}/g) ?? []).length;
  cleaned += "}".repeat(Math.max(0, opens - closes));

  // Step 6: Try parsing cleaned version
  const recovered = tryParse(cleaned);
  if (recovered) return applyFieldNameMapping(recovered, toolName);

  // Step 7: Field name substitution on partially-cleaned object
  if (recovered) {
    const mapped = applyFieldNameMapping(recovered, toolName);
    const remapped = tryParse(JSON.stringify(mapped));
    if (remapped) return remapped;
  }

  // Step 8: Last resort — empty input (causes a tool error, not a crash)
  return {};
}
