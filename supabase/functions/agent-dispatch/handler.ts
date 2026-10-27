// Pure handler for agent-dispatch: drains the agent_dispatch queue (§IV.7.4, §IV.10.2).
// Pull agents get nothing pushed (they fetch with wait_for_my_tasks); webhook agents get a signed CloudEvent.
import { jsonResponse, oauthError } from '../_shared/errors.ts';
import { hmacSha256Hex, timingSafeEqual } from '../_shared/hmac.ts';

export interface DispatchEvent {
  event_id: string;
  workspace_id: string;
  task_id: string;
  run_id: string | null;
  agent_id: string;
  type: string;
  payload: Record<string, unknown>;
  seq: number;
  attempt: number;
  created_at: string;
}

export interface DispatchAgent {
  id: string;
  workspace_id: string;
  kind: string;
  delivery: 'pull' | 'push';
  status: string;
  capabilities: Record<string, unknown> | null;
  connection: Record<string, unknown> | null;
}

export interface DispatchMessage {
  msg_id: number;
  read_ct: number;
  event: DispatchEvent;
  agent: DispatchAgent;
  secrets: Record<string, string>;
}

export interface AckInput {
  msgId: number;
  eventId: string;
  ok: boolean;
  error?: string;
  retryable?: boolean;
}

export interface DispatchDeps {
  /** Shared secret the cron job sends in x-dispatch-secret (Vault dispatch_cron_secret). */
  secret: string;
  /** rpc('dispatch_dequeue', {p_batch, p_vt}). */
  dequeue(batch: number, vt: number): Promise<DispatchMessage[]>;
  /** rpc('dispatch_ack', {p_msg_id, p_event_id, p_ok, p_error, p_retryable}). */
  ack(input: AckInput): Promise<void>;
  fetch: typeof fetch;
  now(): number;
  /** Public URL of the mcp function, sent to webhook agents so they know where to call back. */
  mcpUrl: string;
  batch?: number;
  maxRounds?: number;
  webhookTimeoutMs?: number;
}

export interface DispatchSummary {
  processed: number;
  delivered: number;
  retried: number;
  failed: number;
}

const VISIBILITY_S = 60;

/** CloudEvents 1.0 body of one event (§IV.7.4). */
export function cloudEvent(e: DispatchEvent, mcpUrl: string) {
  const p = e.payload ?? {};
  return {
    specversion: '1.0',
    id: e.event_id,
    type: e.type,
    source: `workspace/${e.workspace_id}`,
    time: e.created_at,
    datacontenttype: 'application/json',
    data: {
      task_id: e.task_id,
      run_id: e.run_id,
      seq: e.seq,
      context_id: p.context_id ?? null,
      brief_version: p.brief_version ?? null,
      signal: p.signal ?? null,
      text: p.text ?? null,
      payload: p,
      mcp_url: mcpUrl,
      token_hint: 'use your PAT',
    },
  };
}

/** Outcome of one HTTP delivery: 2xx delivered; 410 and other 4xx final; 408, 429, 5xx and network errors retried. */
export function classify(status: number): { ok: boolean; retryable: boolean } {
  if (status >= 200 && status < 300) return { ok: true, retryable: false };
  if (status === 408 || status === 429 || status >= 500) return { ok: false, retryable: true };
  return { ok: false, retryable: false };
}

async function deliverWebhook(m: DispatchMessage, deps: DispatchDeps): Promise<AckInput> {
  const base = { msgId: m.msg_id, eventId: m.event.event_id };
  const conn = m.agent.connection ?? {};
  const url = typeof conn.webhook_url === 'string' ? conn.webhook_url : '';
  const secret = m.secrets.webhook_secret ?? (typeof conn.webhook_secret === 'string' ? conn.webhook_secret : '');
  if (!/^https?:\/\//i.test(url)) return { ...base, ok: false, error: 'webhook_url_missing', retryable: false };
  if (!secret) return { ...base, ok: false, error: 'webhook_secret_missing', retryable: false };

  const body = JSON.stringify(cloudEvent(m.event, deps.mcpUrl));
  const t = Math.floor(deps.now() / 1000);
  const signatures = [`t=${t}`, `v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`];
  if (m.secrets.webhook_secret_prev) signatures.push(`v1prev=${await hmacSha256Hex(m.secrets.webhook_secret_prev, `${t}.${body}`)}`);
  const headers = {
    'Content-Type': 'application/cloudevents+json',
    'X-Signature': `sha256=${await hmacSha256Hex(secret, body)}`,
    'X-Agent-Signature': signatures.join(','),
    'X-Agent-Event-Id': m.event.event_id,
    'X-Agent-Event-Type': m.event.type,
    'X-Agent-Attempt': String(m.event.attempt + 1),
  };
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(deps.webhookTimeoutMs ?? 10_000),
    });
    await res.body?.cancel();
    const outcome = classify(res.status);
    return outcome.ok ? { ...base, ok: true } : { ...base, ok: false, error: `http_${res.status}`, retryable: outcome.retryable };
  } catch (err) {
    return { ...base, ok: false, error: `network: ${err instanceof Error ? err.message : String(err)}`.slice(0, 280), retryable: true };
  }
}

/** Decides and performs the delivery of one message; returns the ack to record. */
export async function deliver(m: DispatchMessage, deps: DispatchDeps): Promise<AckInput> {
  const base = { msgId: m.msg_id, eventId: m.event.event_id };
  if (m.agent.status !== 'enabled') return { ...base, ok: false, error: `agent_${m.agent.status}`, retryable: true };
  if (m.agent.delivery === 'pull') return { ...base, ok: true }; // the agent fetches its own work
  if (m.agent.kind === 'webhook' || typeof m.agent.connection?.webhook_url === 'string') return await deliverWebhook(m, deps);
  return { ...base, ok: false, error: `adapter_not_supported:${m.agent.kind}`, retryable: false };
}

export async function handleAgentDispatch(req: Request, deps: DispatchDeps): Promise<Response> {
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'Use POST.', { Allow: 'POST' });
  if (!deps.secret) return oauthError(500, 'misconfigured', 'DISPATCH_SECRET is not set.');
  const presented = req.headers.get('x-dispatch-secret') ?? '';
  if (!presented || !timingSafeEqual(presented, deps.secret)) {
    return oauthError(401, 'invalid_token', 'Missing or wrong x-dispatch-secret.');
  }
  await req.body?.cancel();

  const summary: DispatchSummary = { processed: 0, delivered: 0, retried: 0, failed: 0 };
  const batch = deps.batch ?? 20;
  for (let round = 0; round < (deps.maxRounds ?? 5); round++) {
    let messages: DispatchMessage[];
    try {
      messages = await deps.dequeue(batch, VISIBILITY_S);
    } catch (err) {
      console.error(err);
      return oauthError(500, 'server_error', 'dispatch_dequeue failed.');
    }
    if (!messages.length) break;
    for (const m of messages) {
      const ack = await deliver(m, deps);
      try {
        await deps.ack(ack);
      } catch (err) {
        console.error(err); // the message becomes visible again after the lease and is retried
      }
      summary.processed++;
      if (ack.ok) summary.delivered++;
      else if (ack.retryable) summary.retried++;
      else summary.failed++;
    }
    if (messages.length < batch) break;
  }
  console.log(JSON.stringify({ fn: 'agent-dispatch', ...summary }));
  return jsonResponse(200, summary);
}
