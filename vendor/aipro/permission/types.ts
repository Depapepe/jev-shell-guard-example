export interface Rule { permission: string; pattern: string; action: 'allow' | 'ask' | 'deny'; consequence?: string }
export type Ruleset = Rule[];
