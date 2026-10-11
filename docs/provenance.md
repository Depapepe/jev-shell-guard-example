# 코드와 질문의 출처

이 저장소는 [jev-shell-guard-lab의 고정 커밋](https://github.com/Depapepe/jev-shell-guard-lab/tree/256b3cfb4241aabb365afb8216475e88794d5db3)에서 컬럼 1에 필요한 부분을 추린 예제다. 원본 실험 저장소와 동결 기록은 수정하지 않았다. 2026-10-11 실험의 **B 구성**만 사용하며 A/C 구성, 구조화 근거 전처리, 다른 실험용 정책은 포함하지 않는다.

## 질문과 결합 정책

`src/questions.ts`의 질문은 원본 `createAlignedAtomicQuestions()`의 반환 객체를 그대로 추출했다. `data/questions.json`과 동일하고, `JSON.stringify(questions)`의 UTF-8 SHA-256은 `648ae667ce1055d386531232b4b6544aad8931f3d764fba24b25bb8e2d5276ca`다. prefix, 선택지 순서, instructions, criteria를 변경하지 않았다. 각 호출에는 새 객체를 반환한다.

`src/policy.ts`는 기존 응답 검사와 `atomicPolicy`를 작은 공개 API로 옮겼다. 확률은 유한한 0~1 수여야 하고, 세 후보의 확률 합계와 선택된 답에 대한 모순 검사에는 원본의 0.02 허용 오차를 유지한다. 기본 임계값 0.8에서 강한 금지 `yes`는 `deny`, 세 질문의 강한 `no`는 `allow`, 나머지는 `ask`다. `confidence`에는 임계값을 적용하지 않는다. 유효하지 않은 응답을 직접 전달하거나 범위를 벗어난 임계값을 설정하면 `ask`로 보류하는 호출 경계를 추가했으며, 유효한 원본 응답의 0.8 정책은 바꾸지 않았다.

`combine`은 원본 `hybridPolicy`와 같이 기존 규칙이 `allow`일 때만 Jev 결과를 사용한다. 기존 규칙의 `ask`와 `deny`는 유지한다. 따라서 규칙의 `ask`가 모델의 `deny`보다 먼저 적용되는 경우도 있다. `src/rules.ts`는 원본 `rulePolicy`의 인자 형태만 `command`, `shell`로 풀었고 탐지 순서, glob 의미, 기본 허용을 유지했다.

| 원본 lab 파일                                                                                                                                  | 원본 파일 SHA-256                                                  | 이 예제에서 사용하는 부분                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| [src/atomic-guard.ts](https://github.com/Depapepe/jev-shell-guard-lab/blob/256b3cfb4241aabb365afb8216475e88794d5db3/src/atomic-guard.ts)       | `3d2f2f0659aa31b931a6886af50d96892fe10dad6f631be1e4bf43792b1ba80f` | 공통 prefix, 금지·정보 부족 질문, 응답 검사, 결합 정책 |
| [src/alignment-guard.ts](https://github.com/Depapepe/jev-shell-guard-lab/blob/256b3cfb4241aabb365afb8216475e88794d5db3/src/alignment-guard.ts) | `a9906b161f0fd60e2598b691af15f2facc7184f4d32fe5140b249458b49bdf5b` | B 구성의 보완된 추가 승인 질문                         |
| [src/rules.ts](https://github.com/Depapepe/jev-shell-guard-lab/blob/256b3cfb4241aabb365afb8216475e88794d5db3/src/rules.ts)                     | `88be5f074a8d49aab18b7f639398603a7635d45bbe2d23b4ffe96985c256376a` | 기존 규칙을 비교하는 고정 세션 어댑터                  |
| [src/schema.ts](https://github.com/Depapepe/jev-shell-guard-lab/blob/256b3cfb4241aabb365afb8216475e88794d5db3/src/schema.ts)                   | `29d55f1cf01e18ec1a3412ff0b3ef40870164988b048f8846fadf289ccfb1f33` | command/shell/context와 평가용 정답 구조               |

## 기존 AI PRO 규칙

AI PRO 커밋은 `212fb6e31bf7ebbdcda84490862695552be1f88a`다. lab의 vendor 스냅샷을 읽어 이 예제에 필요한 네 파일만 원본 바이트 그대로 복사했다. 규칙은 명령 문자열과 셸만 받으며 파일·환경·승인 문맥을 입력으로 받지 않는다. 전체 AI PRO 실행 환경이나 사용자 승인 UI를 복제한 것은 아니다.

| 복사한 파일                                      | AI PRO의 원본 경로 또는 어댑터 출처               | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------ |
| `vendor/aipro/permission/safety-ruleset.ts`      | `packages/core/permission/safety-ruleset.ts`      | `552bd85885817f50ff4509a24938ac33b11fed33df5cfbbf1eaed2ed95d2c03c` |
| `vendor/aipro/agent/agents/prompt/tool-names.ts` | `packages/core/agent/agents/prompt/tool-names.ts` | `9323e176cd9dd3091fa71d354887ffb93d8b4034b6633e393f3b2da06faed061` |
| `vendor/aipro/permission/types.ts`               | lab에서 타입 전용 의존성을 대신한 최소 구조 타입  | `c2f23cc6aaec4803c1857bf2b44a09258b385f9b1907660f55ef295930be491f` |
| `vendor/aipro/util/shell-utils.ts`               | lab에서 타입 전용 의존성을 대신한 ShellType       | `2007a9b0ad98b076be2d959c805553769d1e87f6ef259b8e56ec537e073dd59d` |

기계적으로 검증할 값은 `vendor/provenance.json`에도 있다. 테스트에서 vendor 파일의 바이트 해시와 질문 객체의 해시를 확인한다. vendor 파일에는 formatter를 적용하지 않는다.

## 저작권과 공개 범위

복사한 규칙은 사용자가 개발하는 AI PRO와 같은 GitHub 계정 `Depapepe`의 [원본 실험 저장소](https://github.com/Depapepe/jev-shell-guard-lab)에서 가져왔다. 사용자의 별도 공개 예제 저장소 작성 요청에 따라 복사·게시한다. 고정된 lab와 AI PRO 소스에서 별도의 `LICENSE` 또는 `COPYING` 파일을 확인하지 못했으므로 MIT 등 재사용 라이선스를 임의로 부여하지 않았다. 저장소 공개 자체를 자유로운 재사용 허가로 해석하지 않는다. 저작권은 각 원저작자에게 있으며, 재사용 허가가 필요한 경우 저장소 소유자에게 확인한다.

TypeSafe AI와 OpenRouter의 모델·API·SDK는 각 제공자의 약관과 패키지 라이선스가 적용된다. 이 저장소는 이들 업체의 공식 제품이나 보안 보증이 아니다. 데이터의 명령은 판단 대상 문자열이며 실제 셸에서 실행하지 않는다.
