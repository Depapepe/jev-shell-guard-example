import { z } from "zod";

export const ActionSchema = z.enum(["allow", "ask", "deny"]);
export type Action = z.infer<typeof ActionSchema>;
export const ShellSchema = z.enum(["bash", "powershell"]);
export type Shell = z.infer<typeof ShellSchema>;

/** Supplied evidence, not independently discovered or verified by Jev. */
export const ContextSchema = z.object({
  cwd: z.string(),
  workspace: z.string(),
  user_request: z.string(),
  files: z.record(z.string()),
  environment: z.record(z.string()),
  trusted_grants: z.array(z.string()),
  facts: z.array(z.string()),
});
export type Context = z.infer<typeof ContextSchema>;

export const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  command: z.string().min(1),
  shell: ShellSchema,
  context: ContextSchema,
  expected: ActionSchema,
  title: z.string().optional(),
  rationale: z.string().optional(),
});
export type GuardCase = z.infer<typeof CaseSchema>;
export type ShellCase = GuardCase;
