import { OpenRouter } from "@openrouter/sdk";
import type { DecisionsRequest } from "@openrouter/sdk/models";
import { z } from "zod";
import { decide, parseAnswers, type Answers } from "./policy.js";
import { buildRequest } from "./request.js";
import type { Action, GuardCase } from "./schema.js";
export { DEFAULT_MODEL } from "./request.js";
const metadata = z.object({
  model: z.string(),
  provider: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  answers: z.unknown(),
  usage: z.object({
    inputTokens: z.number().finite().nonnegative(),
    outputTokens: z.number().finite().nonnegative(),
    cost: z.number().finite().nonnegative().nullable().optional(),
  }),
});

export type DecisionsCall = (
  request: DecisionsRequest,
  signal: AbortSignal,
) => Promise<unknown>;

export interface LiveResult {
  action: Action;
  answers: Answers | null;
  status: "ok" | "error";
  error: "missing-api-key" | "request-failed" | "invalid-response" | null;
  model: string | null;
  provider: string | null;
  requestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  elapsedMs: number;
}

export async function requestJudgment(
  sample: GuardCase,
  options: {
    apiKey: string;
    threshold?: number;
    timeoutMs?: number;
    call?: DecisionsCall;
    onRequest?: (request: ReturnType<typeof buildRequest>) => void;
  },
): Promise<LiveResult> {
  const start = performance.now();
  const failed = (error: LiveResult["error"]): LiveResult => ({
    action: "ask",
    answers: null,
    status: "error",
    error,
    model: null,
    provider: null,
    requestId: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    elapsedMs: performance.now() - start,
  });
  if (!options.apiKey.trim()) return failed("missing-api-key");
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const sdk = options.call
    ? null
    : new OpenRouter({
        apiKey: options.apiKey,
        retryConfig: { strategy: "none" },
        appTitle: "Jev Shell Guard Example",
      });
  const call: DecisionsCall =
    options.call ??
    ((request, requestSignal) =>
      sdk!.alpha.decisions.create(
        { decisionsRequest: request },
        { signal: requestSignal, retries: { strategy: "none" } },
      ));
  let response: unknown;
  try {
    const request = buildRequest(sample);
    options.onRequest?.(request);
    response = await call(request, signal);
  } catch {
    // Do not retry a possibly billed request or print server text containing inputs.
    return failed("request-failed");
  }
  // Keep a completed response even if its deadline elapses while parsing it.
  const parsed = metadata.safeParse(response);
  if (!parsed.success) return failed("invalid-response");
  const value = parsed.data;
  const answers = parseAnswers(value.answers);
  return {
    action: decide(answers, options.threshold ?? 0.8),
    answers,
    status: answers ? "ok" : "error",
    error: answers ? null : "invalid-response",
    model: value.model,
    provider: value.provider ?? null,
    requestId: value.id ?? null,
    inputTokens: value.usage.inputTokens,
    outputTokens: value.usage.outputTokens,
    costUsd: value.usage.cost ?? null,
    elapsedMs: performance.now() - start,
  };
}
