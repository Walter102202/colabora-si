// Narrow database surface the MCP tools use: RPC calls and simple selects, always as the caller (RLS applies).
// Tests replace it with an in-memory fake; production wraps a supabase-js client built with the caller's token.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface DbError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
}

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'in' | 'is';

export interface Filter {
  col: string;
  op: FilterOp;
  value: unknown;
}

export interface SelectSpec {
  table: string;
  columns: string;
  filters?: Filter[];
  order?: { column: string; ascending?: boolean }[];
  limit?: number;
  offset?: number;
}

export interface Db {
  rpc<T = unknown>(fn: string, params: Record<string, unknown>): Promise<DbResult<T>>;
  select<T = Record<string, unknown>>(spec: SelectSpec): Promise<DbResult<T[]>>;
}

/** Drops undefined values so PostgREST applies the SQL defaults of omitted parameters. */
export function definedParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
}

// deno-lint-ignore no-explicit-any
type Query = any;

export function supabaseDb(client: SupabaseClient, signal?: AbortSignal): Db {
  return {
    async rpc<T>(fn: string, params: Record<string, unknown>) {
      let q: Query = client.rpc(fn, definedParams(params));
      if (signal) q = q.abortSignal(signal);
      const { data, error } = await q;
      return { data: (data ?? null) as T | null, error: error ?? null };
    },
    async select<T>(spec: SelectSpec) {
      let q: Query = client.from(spec.table).select(spec.columns);
      for (const f of spec.filters ?? []) {
        if (f.op === 'in') q = q.in(f.col, f.value as unknown[]);
        else if (f.op === 'is') q = q.is(f.col, f.value);
        else q = q[f.op](f.col, f.value);
      }
      for (const o of spec.order ?? []) q = q.order(o.column, { ascending: o.ascending ?? true });
      if (spec.offset !== undefined) q = q.range(spec.offset, spec.offset + (spec.limit ?? 1000) - 1);
      else if (spec.limit !== undefined) q = q.limit(spec.limit);
      if (signal) q = q.abortSignal(signal);
      const { data, error } = await q;
      return { data: (data ?? null) as T[] | null, error: error ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/** An error the model can act on. Returned as a tool result with isError: true, never as a JSON-RPC error. */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly detail: unknown = null) {
    super(message);
    this.name = 'ToolError';
  }
}

const SQLSTATE_CODES: Record<string, string> = {
  '42501': 'forbidden',
  '57014': 'timeout',
  'PGRST116': 'not_found',
  'PGRST202': 'not_found',
  '22P02': 'invalid_input',
  '23503': 'not_found',
  '23505': 'conflict',
};

const MESSAGES: Record<string, string> = {
  checkpoint_version_unsupported: 'This server reads checkpoint version 1 only. Send v: 1.',
  resume_unsupported: 'This agent does not declare the resume capability. Claim without resume, or ask a person to enable it.',
  delegate_not_found: 'That agent does not exist in this workspace or is not enabled.',
  not_found: 'Not found, or you have no access to it.',
  forbidden: 'You are not allowed to do this.',
  agent_disabled: 'This agent is paused or disabled, or agents are turned off. Stop working and end the run if you can.',
  rate_limited: 'Too many calls in the last minute. Wait about a minute and retry.',
  budget_exceeded: "The agent's monthly budget is spent. Stop and tell the person.",
  run_active: 'A run is already active on this task. Use heartbeat/post_activity with that run, or wait for it to end.',
  run_not_active: 'The run is not active. Claim the task again with claim_task.',
  stop_requested: 'A person asked to stop this run. Acknowledge it with ack_stop instead of handing the task over.',
  idempotency_conflict: 'That idempotency key was already used for a different call on this task. Use a new key.',
  task_unavailable: 'The task cannot be claimed in its current state.',
  use_partial_writes: 'Agents do not call apply_page_ops. Write with append_blocks, edit_page, update_block, add_row, update_row or add_comment.',
  task_closed: 'The task is closed.',
  invalid_state: 'The task is not in a state that allows this.',
  invalid_input: 'Some input is invalid. Check the tool schema and retry.',
  old_str_not_found: 'old_str does not appear in the block text. Re-read the page and copy the exact text.',
  old_str_not_unique: 'old_str appears more than once. Pass block_id, or include more surrounding text.',
  computed_property: 'That property is computed and cannot be written.',
  criteria_uncovered: 'Some "done when" criteria have no artifact that satisfies them. Add artifacts with add_artifact, then submit again.',
  brief_version_stale: 'The brief changed. Read it again with get_task before continuing.',
  humans_only: 'Only a person can do this.',
  lead_only: 'Only the Lead of the parent task can do this.',
  page_locked: 'The page is locked. Ask a person to unlock it.',
  block_type_not_allowed: 'That block type cannot be written by agents.',
  field_not_allowed: 'That block field cannot be changed with this tool.',
  cross_workspace: 'The page belongs to another workspace.',
  unknown_criterion: 'An artifact refers to a criterion id that is not in the brief.',
  policy_denied: 'No policy allows this. Ask a person.',
  approval_consumed: 'That approval receipt was already used.',
  approval_mismatch: 'The approval receipt does not cover these parameters.',
  approval_expired: 'The approval expired. Request a new one.',
  receipt_expired: 'The approval receipt expired. Request a new approval.',
  direct_session_required: 'This needs the person to act from the app directly.',
  timeout: 'The operation took too long. Retry, or narrow the request.',
  conflict: 'The record already exists.',
};

export function messageFor(code: string): string {
  return MESSAGES[code] ?? `The operation failed (${code}).`;
}

function parseDetail(details: string | null | undefined): unknown {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return details;
  }
}

/** Maps a PostgREST error (RPC `raise ... using errcode = 'PTnnn', message = '<code>'`) to a ToolError. */
export function fromDbError(err: DbError): ToolError {
  const msg = (err.message ?? '').trim();
  let code: string;
  if (/^[a-z][a-z0-9_]*$/.test(msg)) code = msg;
  else if (err.code && SQLSTATE_CODES[err.code]) code = SQLSTATE_CODES[err.code];
  else if (/abort/i.test(msg)) code = 'timeout';
  else code = 'internal';
  const message = code === 'internal' ? `The database returned an error: ${msg || err.code || 'unknown'}` : messageFor(code);
  return new ToolError(code, message, parseDetail(err.details));
}

/** Returns data or throws the mapped ToolError. A null result of a non-void RPC is left to the caller. */
export async function must<T>(p: Promise<DbResult<T>>): Promise<T | null> {
  const { data, error } = await p;
  if (error) throw fromDbError(error);
  return data;
}
