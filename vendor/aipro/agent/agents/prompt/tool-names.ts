/**
 * Tool name constants for use in agent prompts.
 * Source of truth: core-v2/tool/builtin/ defineTool() registrations.
 * When a tool is renamed, update here and all prompts auto-sync.
 */

/** Registered tool names matching defineTool() declarations */
export const TOOLS = {
  READ_FILE: 'Read',
  WRITE_FILE: 'Write',
  EDIT_FILE: 'Edit',
  READ_FOLDER: 'ListDir',
  RUN_COMMAND: 'Bash',
  LIST_PROCESSES: 'ProcessList',
  READ_PROCESS: 'ProcessRead',
  STOP_PROCESS: 'ProcessStop',
  SEARCH: 'Grep',
  FIND: 'Glob',
  AGENT: 'Agent',
  SKILL: 'Skill',
  ENTER_PLAN_MODE: 'EnterPlanMode',
  EXIT_PLAN_MODE: 'ExitPlanMode',
  ASK_USER: 'AskUser',
  REGISTER_SCHEDULE: 'RegisterSchedule',
  LIST_SCHEDULE: 'ListSchedule',
  DELETE_SCHEDULE: 'DeleteSchedule',
  DOCTOR: 'Doctor',
  MEMORY: 'Memory',
  WEB_FETCH: 'WebFetch',
  WEB_SEARCH: 'WebSearch',
  CREATE_TASK: 'TaskCreate',
  UPDATE_TASK: 'TaskUpdate',
  GET_TASK: 'TaskGet',
  LIST_TASKS: 'TaskList',
  DELETE_TASK: 'TaskDelete',
};

export type ToolName = (typeof TOOLS)[keyof typeof TOOLS];

/**
 * Built-ins stripped from every subagent context (recursion + task-management
 * guard; Memory is root-agent-only). Single source for BOTH the runtime
 * filter (engine/orchestrator `applySubagentFilter`) and the Agent-tool
 * listing label (tool/builtin/agent.ts), so the model-facing description can
 * never drift from the runtime surface.
 */
export const BUILTIN_TOOLS_HIDDEN_FROM_SUBAGENT: ReadonlySet<string> = new Set([
  TOOLS.AGENT,
  TOOLS.CREATE_TASK,
  TOOLS.DELETE_TASK,
  TOOLS.MEMORY,
  TOOLS.LIST_PROCESSES,
  TOOLS.READ_PROCESS,
  TOOLS.STOP_PROCESS,
]);

/** Tool lists for agent configs. */
export const AIPRO_TOOLS: ToolName[] = [
  TOOLS.RUN_COMMAND,
  TOOLS.LIST_PROCESSES,
  TOOLS.READ_PROCESS,
  TOOLS.STOP_PROCESS,
  TOOLS.READ_FILE,
  TOOLS.EDIT_FILE,
  TOOLS.WRITE_FILE,
  TOOLS.FIND,
  TOOLS.SEARCH,
  TOOLS.READ_FOLDER,
  TOOLS.AGENT,
  TOOLS.SKILL,
  TOOLS.ENTER_PLAN_MODE,
  TOOLS.EXIT_PLAN_MODE,
  TOOLS.ASK_USER,
  TOOLS.REGISTER_SCHEDULE,
  TOOLS.LIST_SCHEDULE,
  TOOLS.DELETE_SCHEDULE,
  TOOLS.WEB_FETCH,
  TOOLS.MEMORY,
  TOOLS.WEB_SEARCH,
  TOOLS.CREATE_TASK,
  TOOLS.UPDATE_TASK,
  TOOLS.GET_TASK,
  TOOLS.LIST_TASKS,
  TOOLS.DELETE_TASK,
];

export const EXPLORER_TOOLS: ToolName[] = [
  TOOLS.RUN_COMMAND,
  TOOLS.READ_FILE,
  TOOLS.READ_FOLDER,
  TOOLS.SEARCH,
  TOOLS.FIND,
];

export const REVIEWER_TOOLS: ToolName[] = [
  TOOLS.RUN_COMMAND,
  TOOLS.READ_FILE,
  TOOLS.READ_FOLDER,
  TOOLS.SEARCH,
  TOOLS.FIND,
];

export const SCHEDULER_TOOLS: ToolName[] = [
  TOOLS.RUN_COMMAND,
  TOOLS.READ_FILE,
  TOOLS.EDIT_FILE,
  TOOLS.WRITE_FILE,
  TOOLS.READ_FOLDER,
  TOOLS.SEARCH,
  TOOLS.FIND,
  TOOLS.AGENT,
  TOOLS.SKILL,
];

// Plan mode applies its own runtime allowlist in ToolOrchestrator. Keep agent
// definitions complete here; declarations are narrowed per turn by the controller.
