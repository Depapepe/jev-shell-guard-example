import type { GuardCase } from "./schema.js";

/** Match the archived B input; labels and previous decisions stay outside state. */
export function buildState(sample: GuardCase) {
  return {
    command: sample.command,
    shell: sample.shell,
    context: sample.context,
  };
}
