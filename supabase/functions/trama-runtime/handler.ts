// Pure handler of trama-runtime: the managed runtime of this deployment asks which Tramas to serve and signs each one in.
// It answers only to TRAMA_RUNTIME_SECRET, so a deployment without that secret has no managed Trama.
import { agentEmail, agentLoginPassword } from '../_shared/agentLogin.ts';
import { jsonResponse, oauthError } from '../_shared/errors.ts';
import { timingSafeEqual } from '../_shared/hmac.ts';

export interface PlatformAgentRow {
  id: string;
  workspace_id: string;
  auth_user_id: string;
  login_nonce: string | null;
  /** False for a paused or revoked agent. */
  serving: boolean;
}

export interface TramaRuntimeDeps {
  secret: string;
  loginPepper: string;
  /** Every platform agent, revoked ones included. */
  platformAgents(): Promise<PlatformAgentRow[]>;
  workspaces(): Promise<{ id: string; owner_id: string }[]>;
  createAgent(workspaceId: string, ownerId: string): Promise<string | undefined>;
  signIn(email: string, password: string): Promise<{ access_token: string; expires_in: number }>;
  log(message: string): void;
}

// A workspace whose owner revoked Trama keeps that row, so it is not created again.
async function listAgents(deps: TramaRuntimeDeps): Promise<Response> {
  const [agents, workspaces] = await Promise.all([deps.platformAgents(), deps.workspaces()]);
  const known = new Set(agents.map((a) => a.workspace_id));
  const ids = agents.filter((a) => a.serving).map((a) => a.id);
  for (const workspace of workspaces.filter((w) => !known.has(w.id))) {
    try {
      const id = await deps.createAgent(workspace.id, workspace.owner_id);
      if (id) ids.push(id);
    } catch {
      deps.log(`trama-runtime could not create the agent of workspace ${workspace.id}`);
    }
  }
  return jsonResponse(200, { agents: ids });
}

async function signAgentIn(agentId: unknown, deps: TramaRuntimeDeps): Promise<Response> {
  const agent = (await deps.platformAgents()).find((a) => a.id === agentId && a.serving);
  if (!agent) return oauthError(404, 'not_found', 'There is no such Trama.');
  const password = await agentLoginPassword(deps.loginPepper, agent.auth_user_id, agent.login_nonce);
  const session = await deps.signIn(agentEmail(agent.id), password);
  return jsonResponse(200, { access_token: session.access_token, expires_in: session.expires_in });
}

export async function handleTramaRuntime(req: Request, deps: TramaRuntimeDeps): Promise<Response> {
  const body = await req.json().catch(() => null) as { action?: unknown; agent_id?: unknown } | null;
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'Use POST.', { Allow: 'POST' });
  if (!deps.secret) return oauthError(404, 'not_found', 'This deployment has no managed Trama.');
  if (!timingSafeEqual(req.headers.get('X-Runtime-Secret') ?? '', deps.secret)) return oauthError(401, 'unauthorized', 'The runtime secret does not match.');
  if (!deps.loginPepper) return oauthError(500, 'misconfigured', 'AGENT_LOGIN_PEPPER is not set.');
  try {
    if (body?.action === 'agents') return await listAgents(deps);
    if (body?.action === 'token') return await signAgentIn(body.agent_id, deps);
  } catch {
    return oauthError(500, 'server_error', 'The runtime request failed.');
  }
  return oauthError(400, 'invalid_request', 'action must be agents or token.');
}
