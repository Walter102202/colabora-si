export const ELIDED_NOTE: string;
export function estimateTokens(messages: object[]): number;
export function trimMessages(messages: object[], opts: { budgetTokens: number; keepTurns: number }): { elided: number; tokens: number };
