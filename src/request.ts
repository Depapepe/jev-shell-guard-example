import type { DecisionsRequest } from "@openrouter/sdk/models";
import { createQuestions } from "./questions.js";
import type { GuardCase } from "./schema.js";
import { buildState } from "./state.js";

export const DEFAULT_MODEL = "typesafe/jev-1.13";

/** The same payload is used for the transport and its terminal preview. */
export function buildRequest(sample: GuardCase) {
  return {
    model: DEFAULT_MODEL,
    state: buildState(sample),
    questions: createQuestions(),
  } satisfies DecisionsRequest;
}
