import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { requestJudgment } from "../src/client.js";
import { CaseSchema } from "../src/schema.js";
import { buildState } from "../src/state.js";

const input = JSON.parse(
  await readFile(new URL("../data/examples.json", import.meta.url), "utf8"),
);
const saved = JSON.parse(
  await readFile(
    new URL("../data/example-responses.json", import.meta.url),
    "utf8",
  ),
);
const sample = CaseSchema.parse(input[0]);
const row = saved.find((item: { caseId: string }) => item.caseId === sample.id);
const response = () => ({
  model: row.result.model,
  provider: row.result.provider,
  id: row.result.requestId,
  answers: row.result.judgment,
  usage: {
    inputTokens: row.result.inputTokens,
    outputTokens: row.result.outputTokens,
    cost: row.costUsd,
  },
});

describe("live adapter (mocked API; no paid calls)", () => {
  it("only sends command, shell and supplied context; labels stay outside input", async () => {
    const call = vi.fn(async () => response());
    const result = await requestJudgment(sample, { apiKey: "test-key", call });
    expect(call).toHaveBeenCalledTimes(1);
    const request = call.mock.calls[0] as unknown as [
      { state: unknown; questions: object },
    ];
    expect(request[0].state).toEqual(buildState(sample));
    expect(Object.keys(request[0].state as object)).toEqual([
      "command",
      "shell",
      "context",
    ]);
    expect(Object.keys(request[0].questions)).toEqual([
      "prohibited",
      "approval",
      "unresolved",
    ]);
    expect(result).toMatchObject({
      status: "ok",
      action: "deny",
      costUsd: row.costUsd,
      requestId: row.result.requestId,
    });
  });

  it("previews the exact request before the transport receives it", async () => {
    const order: string[] = [];
    let preview: unknown;
    const result = await requestJudgment(sample, {
      apiKey: "test-key",
      onRequest(request) {
        preview = request;
        order.push("request");
      },
      async call(request) {
        expect(request).toBe(preview);
        expect(request.state).toEqual(buildState(sample));
        order.push("transport");
        return response();
      },
    });
    expect(order).toEqual(["request", "transport"]);
    expect(result.status).toBe("ok");
  });

  it("does not request an API when the key is absent", async () => {
    const call = vi.fn(async () => response());
    const result = await requestJudgment(sample, { apiKey: " ", call });
    expect(call).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "error",
      action: "ask",
      error: "missing-api-key",
      costUsd: null,
    });
  });

  it("returns ask on an API error without retrying or revealing server text", async () => {
    const call = vi.fn(async () => {
      throw new Error("403 test-key confidential input");
    });
    const result = await requestJudgment(sample, { apiKey: "test-key", call });
    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "error",
      action: "ask",
      error: "request-failed",
      costUsd: null,
    });
    expect(JSON.stringify(result)).not.toContain("test-key");
    expect(JSON.stringify(result)).not.toContain("confidential");
  });

  it("keeps billing metadata when successful transport has invalid answers", async () => {
    const value = response();
    value.answers = { prohibited: { type: "noul", noul: 1 } };
    const result = await requestJudgment(sample, {
      apiKey: "test-key",
      call: async () => value,
    });
    expect(result).toMatchObject({
      status: "error",
      action: "ask",
      error: "invalid-response",
      costUsd: row.costUsd,
    });
  });

  it("rejects malformed response metadata", async () => {
    const result = await requestJudgment(sample, {
      apiKey: "test-key",
      call: async () => ({ model: "jev", answers: {} }),
    });
    expect(result).toMatchObject({
      status: "error",
      action: "ask",
      error: "invalid-response",
    });
  });

  it("keeps a completed billed response when the timeout has just elapsed", async () => {
    const call = vi.fn(async (_request, signal: AbortSignal) => {
      await delay(15);
      expect(signal.aborted).toBe(true);
      return response();
    });
    const result = await requestJudgment(sample, {
      apiKey: "test-key",
      timeoutMs: 1,
      call,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "ok",
      action: "deny",
      costUsd: row.costUsd,
    });
  });
});
