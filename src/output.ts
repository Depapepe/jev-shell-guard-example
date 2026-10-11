import { stripVTControlCharacters } from "node:util";
import { parseAnswers, type Answers } from "./policy.js";
import { createQuestions } from "./questions.js";
import { buildRequest } from "./request.js";
import type { Action, GuardCase } from "./schema.js";
import { buildState } from "./state.js";

const keys = ["prohibited", "approval", "unresolved"] as const;
type QuestionKey = (typeof keys)[number];

export interface DisplayResult {
  rule: Action;
  jev: Action | null;
  combined: Action;
  answers: Answers | null;
  error?: string | null;
  response?: {
    requestId?: string | null;
    model?: string | null;
    provider?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
    apiMs?: number | null;
    elapsedMs?: number | null;
  };
}

function probability(value: number, threshold: number): string {
  const rounded = Number(value.toFixed(2));
  // Preserve precision whenever rounding would cross the policy boundary.
  return rounded >= threshold === value >= threshold
    ? rounded.toFixed(2)
    : String(value);
}

/** An exact excerpt of the specific question, without the shared instructions. */
export function questionExcerpt(
  key: QuestionKey,
  questions = createQuestions(),
): string {
  const instructions = questions[key].instructions;
  const specific = instructions.slice(instructions.indexOf("\n") + 1);
  const end = specific.indexOf("?");
  if (end === -1) throw new Error(`Missing question text: ${key}`);
  return specific.slice(0, end + 1);
}

/** Machine-readable policy conditions, not a model-generated explanation. */
export function policyReason(result: DisplayResult, threshold: number): string {
  if (result.rule !== "allow") return `rule=${result.rule}; preserved`;
  if (result.error) return `error=${result.error}; fail-closed=ask`;
  const answers = parseAnswers(result.answers);
  if (!answers) return "invalid-response; fail-closed=ask";
  if (result.jev === "deny")
    return `prohibited=yes; p=${probability(answers.prohibited.probabilities.yes, threshold)} >= threshold=${threshold}`;
  if (result.jev === "allow")
    return `all choices=no; all p(no) >= threshold=${threshold}`;
  return keys
    .flatMap((key) => {
      const answer = answers[key];
      if (answer.choice !== "no")
        return [
          `${key}=${answer.choice}; p=${probability(answer.probabilities[answer.choice], threshold)}`,
        ];
      return answer.probabilities.no < threshold
        ? [
            `${key}.p(no)=${probability(answer.probabilities.no, threshold)} < ${threshold}`,
          ]
        : [];
    })
    .join("; ");
}

/** JSON always includes the exact model input, even without --verbose. */
export function inputForDisplay(sample: GuardCase) {
  return {
    command: sample.command,
    shell: sample.shell,
    state: buildState(sample),
    questions: createQuestions(),
    request: buildRequest(sample),
  };
}

function wrap(text: string, width: number): string[] {
  return text.split("\n").flatMap((paragraph) => {
    const lines: string[] = [];
    let remaining = paragraph;
    while (remaining.length > width) {
      const space = remaining.lastIndexOf(" ", width);
      const at = space > 0 ? space : width;
      lines.push(remaining.slice(0, at));
      remaining = remaining.slice(at + (space > 0 ? 1 : 0));
    }
    lines.push(remaining);
    return lines;
  });
}

interface DisplayOptions {
  mode: "demo" | "live";
  threshold: number;
  verbose?: boolean;
  width?: number;
  color?: boolean;
  sent?: boolean;
}

function card(options: DisplayOptions) {
  const width = Math.max(
    64,
    Math.min(96, options.width ?? process.stdout.columns ?? 96),
  );
  const inner = width - 4;
  const color =
    options.color ??
    Boolean(
      process.stdout.isTTY &&
      !Object.hasOwn(process.env, "NO_COLOR") &&
      process.env.TERM !== "dumb",
    );
  const ink = (text: string, code: string) =>
    color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const lines: string[] = [];
  const row = (text = "", code?: string) => {
    // Styled table rows fit the card; wrap unstyled command/question text.
    const indent = text.match(/^ */)?.[0] ?? "";
    const content =
      stripVTControlCharacters(text).length <= inner
        ? [text]
        : wrap(text.slice(indent.length), inner - indent.length).map(
            (line) => indent + line,
          );
    for (const line of content) {
      const padding = " ".repeat(
        Math.max(0, inner - stripVTControlCharacters(line).length),
      );
      lines.push(
        `${ink("│", "2;37")} ${code ? ink(line, code) : line}${padding} ${ink("│", "2;37")}`,
      );
    }
  };
  const divider = () => lines.push(ink(`├${"─".repeat(width - 2)}┤`, "2;37"));
  const actionInk = (value: Action | null) =>
    value
      ? ink(
          value.toUpperCase().padEnd(12),
          { allow: "1;32", ask: "1;33", deny: "1;31" }[value],
        )
      : ink("--".padEnd(12), "2");
  lines.push(ink(`╭${"─".repeat(width - 2)}╮`, "2;37"));
  return {
    row,
    divider,
    ink,
    actionInk,
    inner,
    finish() {
      lines.push(ink(`╰${"─".repeat(width - 2)}╯`, "2;37"));
      return lines.join("\n");
    },
  };
}

function excerpt(value: string, limit = 130, mark = true): string {
  if (value.length <= limit) return JSON.stringify(value);
  const space = value.lastIndexOf(" ", limit);
  const end = space >= limit / 2 ? space : limit;
  return JSON.stringify(value.slice(0, end)) + (mark ? " …" : "");
}

/** Preview the same object handed to the SDK, folding long values visibly. */
export function formatRequest(
  request: ReturnType<typeof buildRequest>,
  options: DisplayOptions,
): string {
  const panel = card(options);
  const { row, divider } = panel;
  row("REQUEST / OpenRouter Decisions", "1;36");
  row(
    options.mode === "demo"
      ? "ARCHIVED INPUT / B   |   API calls: 0"
      : options.sent === false
        ? "PREVIEW / NOT SENT"
        : "LIVE REQUEST / B",
    "2",
  );
  divider();
  row("POST /api/alpha/decisions", "2");
  row("{");
  row(`  "model": ${JSON.stringify(request.model)},`);
  row('  "state": {');
  row(`    "command": ${JSON.stringify(request.state.command)},`);
  row(`    "shell": ${JSON.stringify(request.state.shell)},`);
  row('    "context": {');
  row(
    `      "user_request": ${excerpt(request.state.context.user_request, 80)},`,
  );
  const files = Object.entries(request.state.context.files);
  row(files.length ? '      "files": {' : '      "files": {},');
  for (const [path, content] of files.slice(0, 2))
    row(`        ${JSON.stringify(path)}: ${excerpt(content, 140)}`);
  if (files.length > 2) row("        …");
  if (files.length) row("      },");
  row("      …");
  row("    }");
  row("  },");
  row('  "questions": {');
  for (const [index, key] of keys.entries()) {
    row(
      `    "${key}": { "type": ${JSON.stringify(request.questions[key].type)},`,
    );
    row(
      `      "instructions": … ${excerpt(questionExcerpt(key, request.questions), 160, false)} …,`,
    );
    row('      "criteria": { "yes": …, "no": …, "unknown": … }');
    row(index < keys.length - 1 ? "    }," : "    }");
  }
  row("  }");
  row("}");
  divider();
  row("… folded values / full request: --verbose", "2");
  return (
    panel.finish() +
    (options.verbose
      ? `\n\nFULL REQUEST\n${JSON.stringify(request, null, 2)}`
      : "")
  );
}

export function formatResponse(
  sample: GuardCase,
  result: DisplayResult,
  options: DisplayOptions,
): string {
  const panel = card(options);
  const { row, divider, ink, actionInk } = panel;
  row("RESPONSE", "1;36");
  row(
    options.mode === "demo"
      ? "ARCHIVED RESPONSE / B"
      : result.error
        ? "NO VALID RESPONSE"
        : "LIVE RESPONSE / B",
    "2",
  );
  const metadata = result.response;
  if (metadata?.requestId) row(`id: ${metadata.requestId}`, "2");
  if (metadata?.model) row(`model: ${metadata.model}`, "2");
  if (metadata?.costUsd != null)
    row(
      `tokens: ${metadata.inputTokens ?? "--"} in / ${metadata.outputTokens ?? "--"} out   |   cost: $${metadata.costUsd}${metadata.apiMs != null ? `   |   API: ${metadata.apiMs}ms` : metadata.elapsedMs != null ? `   |   elapsed: ${Math.round(metadata.elapsedMs)}ms` : ""}`,
      "2",
    );
  divider();
  const answers = parseAnswers(result.answers);
  row("answers".padEnd(24) + "choice".padEnd(12) + "P(choice)", "2");
  for (const key of keys) {
    const answer = answers?.[key];
    row(
      key.padEnd(24) +
        (answer?.choice ?? "--").padEnd(12) +
        (answer
          ? probability(answer.probabilities[answer.choice], options.threshold)
          : "--"),
      answer &&
        (answer.choice === "unknown" ||
          answer.probabilities[answer.choice] < options.threshold)
        ? "33"
        : "36",
    );
  }
  divider();
  row(`POLICY / threshold: ${options.threshold}`, "2");
  row(
    "RULE".padEnd(12) +
      "JEV POLICY".padEnd(12) +
      "FINAL".padEnd(12) +
      "EXPECTED".padEnd(12) +
      "CHECK",
    "2",
  );
  row(
    actionInk(result.rule) +
      actionInk(result.jev) +
      actionInk(result.combined) +
      actionInk(sample.expected) +
      ink(
        result.combined === sample.expected ? "MATCH" : "MISMATCH",
        result.combined === sample.expected ? "32" : "1;31",
      ),
  );
  if (result.error) row(`error: ${result.error}`, "31");
  const output = panel.finish();
  return (
    output +
    (options.verbose
      ? `\n\nRESPONSE + POLICY\n${JSON.stringify({ id: sample.id, expected: sample.expected, ...result, policyReason: policyReason(result, options.threshold) }, null, 2)}`
      : "")
  );
}

export function formatResult(
  sample: GuardCase,
  result: DisplayResult,
  options: DisplayOptions,
): string {
  return `${formatRequest(buildRequest(sample), options)}\n\n${formatResponse(sample, result, options)}`;
}
