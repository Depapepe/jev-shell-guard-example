import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { requestJudgment } from "./client.js";
import { combine, decide, parseAnswers } from "./policy.js";
import { evaluateRules } from "./rules.js";
import { CaseSchema, ActionSchema } from "./schema.js";
import {
  formatRequest,
  formatResponse,
  formatResult,
  inputForDisplay,
  policyReason,
} from "./output.js";
import { buildRequest } from "./request.js";

const snapshotsSchema = z.array(
  z.object({
    caseId: z.string(),
    rule_action: ActionSchema,
    policy_action: ActionSchema,
    combined_action: ActionSchema,
    result: z.object({
      judgment: z.unknown(),
      model: z.string().nullable().optional(),
      provider: z.string().nullable().optional(),
      requestId: z.string().nullable().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    }),
    costUsd: z.number().optional(),
    timing: z.object({ apiMs: z.number() }).optional(),
  }),
);
const usage = `Jev Shell Guard Example

pnpm examples
pnpm demo [--case <id>] [--threshold <0..1>] [--verbose | --json]
pnpm live --case <id> [--threshold <0..1>] [--verbose | --json]
pnpm verify

demo: 저장된 B 응답을 재생합니다. API 키와 네트워크가 필요 없습니다.
live: 선택한 사례 하나를 유료 API로 새로 평가합니다. 셸 명령은 실행하지 않습니다.
--verbose: 실제 state와 영문 질문·선택 기준 전체를 추가 표시합니다.
--json: 전체 입력과 응답·판정을 JSON으로 출력합니다.
`;

async function main() {
  const [mode = "demo", ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    options: {
      case: { type: "string" },
      threshold: { type: "string" },
      verbose: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!["examples", "demo", "live"].includes(mode)) throw new Error(usage);
  const threshold = Number(values.threshold ?? "0.8");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error("threshold는 0부터 1 사이의 유한한 숫자여야 합니다.");
  const cases = z
    .array(CaseSchema)
    .parse(
      JSON.parse(
        await readFile(
          new URL("../data/examples.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  if (mode === "examples") {
    for (const sample of cases)
      console.log(
        JSON.stringify({
          id: sample.id,
          expected: sample.expected,
          command: sample.command,
        }),
      );
    return;
  }
  const selected = values.case
    ? cases.filter((sample) => sample.id === values.case)
    : cases;
  if (!selected.length) throw new Error(`알 수 없는 사례: ${values.case}`);
  if (mode === "live" && !values.case)
    throw new Error("live는 --case <id>로 사례 하나를 지정해야 합니다.");
  if (mode === "live") {
    const sample = selected[0];
    const rule = evaluateRules(sample.command, sample.shell);
    if (rule.action !== "allow") {
      const result = {
        rule: rule.action,
        jev: null,
        combined: rule.action,
        answers: null,
      };
      console.log(
        values.json
          ? JSON.stringify(
              {
                id: sample.id,
                mode,
                threshold,
                expected: sample.expected,
                ...inputForDisplay(sample),
                ...result,
                matchesExpected: result.combined === sample.expected,
                policyReason: policyReason(result, threshold),
                apiCalled: false,
              },
              null,
              2,
            )
          : formatResult(sample, result, {
              mode,
              threshold,
              verbose: values.verbose,
              sent: false,
            }),
      );
      return;
    }
    let apiCalled = false;
    const result = await requestJudgment(sample, {
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
      threshold,
      onRequest(request) {
        apiCalled = true;
        if (!values.json)
          console.log(
            formatRequest(request, {
              mode,
              threshold,
              verbose: values.verbose,
            }),
          );
      },
    });
    if (!apiCalled && !values.json)
      console.log(
        formatRequest(buildRequest(sample), {
          mode,
          threshold,
          verbose: values.verbose,
          sent: false,
        }),
      );
    const display = {
      rule: rule.action,
      jev: result.action,
      combined: combine(rule.action, result.action),
      answers: result.answers,
      error: result.error,
      response: {
        requestId: result.requestId,
        model: result.model,
        provider: result.provider,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        elapsedMs: result.elapsedMs,
      },
    };
    console.log(
      values.json
        ? JSON.stringify(
            {
              id: sample.id,
              mode,
              threshold,
              expected: sample.expected,
              ...inputForDisplay(sample),
              ...display,
              ...result,
              apiCalled,
              matchesExpected: display.combined === sample.expected,
              policyReason: policyReason(display, threshold),
            },
            null,
            2,
          )
        : [
            formatResponse(sample, display, {
              mode,
              threshold,
              verbose: values.verbose,
            }),
            values.verbose
              ? `\nAPI RESPONSE\n${JSON.stringify(result, null, 2)}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
    );
    if (result.status === "error") process.exitCode = 1;
    return;
  }
  const snapshots = snapshotsSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../data/example-responses.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const output = [];
  for (const sample of selected) {
    const row = snapshots.find((snapshot) => snapshot.caseId === sample.id);
    if (!row) throw new Error(`저장 응답 없음: ${sample.id}`);
    const rule = evaluateRules(sample.command, sample.shell);
    const answers = parseAnswers(row.result.judgment);
    if (!answers) throw new Error(`잘못된 저장 응답: ${sample.id}`);
    const jev = decide(answers, threshold);
    const combined = combine(rule.action, jev);
    if (
      rule.action !== row.rule_action ||
      (threshold === 0.8 &&
        (jev !== row.policy_action || combined !== row.combined_action))
    )
      throw new Error(`원본과 재생 판정 불일치: ${sample.id}`);
    const display = {
      rule: rule.action,
      jev,
      combined,
      answers,
      response: {
        requestId: row.result.requestId,
        model: row.result.model,
        provider: row.result.provider,
        inputTokens: row.result.inputTokens,
        outputTokens: row.result.outputTokens,
        costUsd: row.costUsd,
        apiMs: row.timing?.apiMs,
      },
    };
    if (values.json) {
      output.push({
        id: sample.id,
        mode,
        threshold,
        expected: sample.expected,
        ...inputForDisplay(sample),
        ...display,
        apiCalled: false,
        matchesExpected: combined === sample.expected,
        policyReason: policyReason(display, threshold),
      });
    } else {
      console.log(
        formatResult(sample, display, {
          mode: "demo",
          threshold,
          verbose: values.verbose,
        }),
      );
      if (sample !== selected.at(-1)) console.log("\n" + "─".repeat(60) + "\n");
    }
  }
  if (values.json)
    console.log(
      JSON.stringify(output.length === 1 ? output[0] : output, null, 2),
    );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "실행 실패");
  process.exitCode = 1;
});
