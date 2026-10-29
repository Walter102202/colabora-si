import { must } from '../db.ts';
import type { JsonSchema } from '../jsonSchema.ts';
import type { ToolDef } from '../mcp.ts';
import { object, output, WRITE_IDEMPOTENT } from './common.ts';

export const CHECKPOINT_VERSION = 1;
const text = (minLength: number, maxLength: number): JsonSchema => ({ type: 'string', minLength, maxLength });
const list = (items: JsonSchema, maxItems: number): JsonSchema => ({ type: 'array', items, maxItems });
const op = object({
  key: text(1, 200), tool: text(1, 60), summary: text(0, 280), page_id: text(0, 64),
  block_ids: list(text(1, 64), 200), args_hash: text(0, 128),
}, ['key', 'tool']);
const effect = object({
  action: text(1, 200), summary: text(0, 280),
  external_op_id: { type: 'string', format: 'uuid' }, approval_id: { type: 'string', format: 'uuid' },
}, ['action']);
const evidence = object({
  criterion_id: text(1, 60), status: { type: 'string', enum: ['met', 'unmet', 'unknown'] },
  refs: list(text(0, 500), 20), note: text(0, 1000),
}, ['criterion_id', 'status']);
export const CHECKPOINT_SCHEMA: JsonSchema = object({
  v: { type: 'integer', const: CHECKPOINT_VERSION }, next_step: text(1, 2000),
  ops: object({ confirmed: list(op, 200), pending: list(op, 200) }),
  effects: object({ confirmed: list(effect, 50), not_executed: list(effect, 50), unknown: list(effect, 50) }),
  evidence: list(evidence, 50), handover_note: text(0, 4000),
}, ['v', 'next_step']);
const inputs = { run_id: { type: 'string', minLength: 1 }, checkpoint: CHECKPOINT_SCHEMA, idempotency_key: text(1, 200) };
const saved = { activity_id: { type: 'string' }, seq: { type: 'integer' }, replayed: { type: 'boolean' } };

const saveCheckpoint: ToolDef = {
  name: 'save_checkpoint', title: 'Save a checkpoint',
  description: 'Saves where you are: next step, writes done and pending (with their idempotency keys), external effects, evidence per criterion. Call it before risky steps; the same key returns the first checkpoint.',
  inputSchema: object(inputs, ['run_id', 'checkpoint', 'idempotency_key']),
  outputSchema: output(saved), annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Record<string, unknown>>('save_checkpoint', {
      p_run_id: args.run_id, p_checkpoint: args.checkpoint, p_idempotency_key: args.idempotency_key,
    })) ?? {};
    return { text: `Checkpoint #${String(data.seq)} saved.`, structured: data };
  },
};

const handOver: ToolDef = {
  name: 'hand_over', title: 'Hand over a task',
  description: 'Ends your run so another session or harness can continue: saves a final checkpoint with a handover note and keeps pending approvals for the next run. Use it instead of end_run when the task is not finished.',
  inputSchema: object({ ...inputs, checkpoint: {
    ...CHECKPOINT_SCHEMA, properties: { ...CHECKPOINT_SCHEMA.properties, handover_note: text(1, 4000) },
    required: ['v', 'next_step', 'handover_note'],
  } }, ['run_id', 'checkpoint', 'idempotency_key']),
  outputSchema: output({ ...saved, task_state: { type: 'string' } }), annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Record<string, unknown>>('hand_over', {
      p_run_id: args.run_id, p_checkpoint: args.checkpoint, p_idempotency_key: args.idempotency_key,
    })) ?? {};
    return { text: `Handed over (task ${String(data.task_state)}). Another session can continue with claim_task resume: true.`, structured: data };
  },
};

export const handoverTools: ToolDef[] = [saveCheckpoint, handOver];
