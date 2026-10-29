export const CHECKPOINT_VERSION: 1;
export const WRITE_TOOLS: Set<string>;
export interface CheckpointOp { key: string; tool: string; summary?: string; page_id?: string; block_ids?: string[]; args_hash?: string }
export interface CheckpointEffect { action: string; summary?: string; external_op_id?: string; approval_id?: string }
export interface CheckpointEvidence { criterion_id: string; status: "met" | "unmet" | "unknown"; refs?: string[]; note?: string }
export interface CheckpointState {
  nextStep: string; confirmed: CheckpointOp[]; pending: CheckpointOp[];
  effects: { confirmed: CheckpointEffect[]; not_executed: CheckpointEffect[]; unknown: CheckpointEffect[] };
  evidence: CheckpointEvidence[]; handoverNote?: string;
}
export type Guard = { status: "confirmed" | "unknown"; key: string; summary: string };
export function argsHash(name: string, args: Record<string, unknown>): string;
export function buildCheckpoint(state: CheckpointState): Record<string, unknown>;
export function parseCheckpoint(body: unknown): { status: "ok"; checkpoint: Record<string, unknown> } | { status: "newer_schema"; version: number } | { status: "invalid" };
export function guardsFromResume(resume: Record<string, unknown> | null | undefined): Map<string, Guard>;
export function guardFor(name: string, args: Record<string, unknown>, guards: Map<string, Guard>): null | { error: "already_done" | "verify_first"; message: string; key: string };
export function handoverText(resume: Record<string, unknown> | null | undefined): string;
