import {
  SAFETY_RULESET,
  detectHardlineCommand,
  detectSensitiveCommand,
} from "../vendor/aipro/permission/safety-ruleset.js";
import type { Action, Shell } from "./schema.js";

// Same glob semantics as Permission.matchPattern at the pinned AI PRO commit.
export function matchPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "s",
  );
  return regex.test(value);
}

/** The baseline deliberately receives only the command and shell. */
export function evaluateRules(
  command: string,
  shell: Shell,
): { action: Action; reason: string } {
  const hardline = detectHardlineCommand(command, shell);
  if (hardline) return { action: "deny", reason: `hardline:${hardline.id}` };
  const sensitive = detectSensitiveCommand(command, shell);
  if (sensitive) return { action: "ask", reason: `sensitive:${sensitive}` };
  const matched = SAFETY_RULESET.filter(
    (rule) => rule.permission === "Bash" && matchPattern(command, rule.pattern),
  ).at(-1);
  return matched
    ? { action: matched.action, reason: `pattern:${matched.pattern}` }
    : { action: "allow", reason: "agent-default-allow" };
}
