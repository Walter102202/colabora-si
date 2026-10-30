import { validSignature, webhookSecret } from '../_shared/ciWebhook.ts';
import { jsonResponse, oauthError } from '../_shared/errors.ts';

export interface GithubWebhookDeps {
  pepper: string;
  /** record_ci_check with the service role. A null run records a ping. */
  record(connectionId: string, repo: string, run: Record<string, unknown> | null): Promise<{ data: unknown; error: { message?: string } | null }>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = { connection_revoked: 410, repo_mismatch: 403, not_found: 404, invalid_input: 400 };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function handleGithubWebhook(req: Request, deps: GithubWebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'Use POST.', { Allow: 'POST' });
  const id = new URL(req.url).pathname.split('/').pop() ?? '';
  if (!UUID.test(id)) return oauthError(404, 'not_found', 'Connection not found.');
  let raw: string;
  try { raw = await req.text(); } catch { return oauthError(400, 'invalid_input', 'Could not read the body.'); }
  if (new TextEncoder().encode(raw).length > 1024 * 1024) return oauthError(413, 'payload_too_large', 'The body exceeds 1 MiB.');
  if (!deps.pepper) return oauthError(500, 'misconfigured', 'CI_WEBHOOK_PEPPER is not set.');
  const connectionId = id.toLowerCase();
  if (!await validSignature(await webhookSecret(deps.pepper, connectionId), raw, req.headers.get('X-Hub-Signature-256'))) {
    return oauthError(401, 'invalid_signature', 'The delivery signature is invalid.');
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return oauthError(400, 'invalid_input', 'The body must be JSON.'); }
  if (!record(body) || !record(body.repository) || typeof body.repository.full_name !== 'string') {
    return oauthError(400, 'invalid_input', 'The delivery must name its repository.');
  }
  const event = req.headers.get('X-GitHub-Event');
  let run: Record<string, unknown> | null = null;
  if (event !== 'ping') {
    if (event !== 'check_run' || body.action !== 'completed') return new Response(null, { status: 204 });
    const check = body.check_run;
    if (!record(check)) return oauthError(400, 'invalid_input', 'The delivery must contain a check run.');
    run = { id: check.id, name: check.name, head_sha: check.head_sha,
      head_branch: record(check.check_suite) ? check.check_suite.head_branch ?? null : null,
      conclusion: check.conclusion, html_url: check.html_url,
      app_slug: record(check.app) ? check.app.slug ?? null : null,
      started_at: check.started_at, completed_at: check.completed_at };
  }
  try {
    const { data, error } = await deps.record(connectionId, body.repository.full_name, run);
    if (error) return oauthError(STATUS[error.message ?? ''] ?? 500, error.message ?? 'server_error', 'Could not record the delivery.');
    const result = record(data) ? data : {};
    return jsonResponse(200, { ok: true, recorded: result.recorded ?? false, tasks: result.tasks ?? 0 });
  } catch { return oauthError(500, 'server_error', 'Could not record the delivery.'); }
}
