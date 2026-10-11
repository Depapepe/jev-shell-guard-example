import { z } from "zod";
import type { Action } from "./schema.js";

const probability = z.number().finite().min(0).max(1);
const answer = z
  .object({
    type: z.literal("choice"),
    choice: z.enum(["yes", "no", "unknown"]),
    probabilities: z
      .object({ yes: probability, no: probability, unknown: probability })
      .strict(),
    confidence: probability.optional(),
  })
  .superRefine((a, ctx) => {
    if (
      Math.abs(Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1) >=
      0.02
    )
      ctx.addIssue({
        code: "custom",
        message: "Probabilities must sum to one",
      });
    if (
      a.probabilities[a.choice] + 0.02 <
      Math.max(...Object.values(a.probabilities))
    )
      ctx.addIssue({
        code: "custom",
        message: "Choice contradicts probabilities",
      });
  });

// These distribution checks preserve the original experiment's 0.02 tolerance.
export const AnswersSchema = z
  .object({ prohibited: answer, approval: answer, unresolved: answer })
  .strict();
export type Answers = z.infer<typeof AnswersSchema>;

export function parseAnswers(input: unknown): Answers | null {
  const result = AnswersSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** Return a decision only. This module never executes a shell command. */
export function decide(input: unknown, threshold = 0.8): Action {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    return "ask";
  const answers = parseAnswers(input);
  if (!answers) return "ask";
  if (
    answers.prohibited.choice === "yes" &&
    answers.prohibited.probabilities.yes >= threshold
  )
    return "deny";
  if (
    Object.values(answers).every(
      (a) => a.choice === "no" && a.probabilities.no >= threshold,
    )
  )
    return "allow";
  return "ask";
}

/** Existing rule asks and denials take precedence over the model decision. */
export function combine(rule: Action, jev: Action): Action {
  return rule === "allow" ? jev : rule;
}
