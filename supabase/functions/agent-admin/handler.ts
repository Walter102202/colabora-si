// Pure handler for agent-admin: creates, revokes and rotates the auth user behind an agent.
// The caller's own client (RLS) authorizes every action before the service key is used.
// No Supabase imports here: index.ts wires the real clients through `deps`.
import { agentEmail, agentLoginPassword } from '../_shared/agentLogin.ts';
import { webhookSecret } from '../_shared/ciWebhook.ts';
import { jsonResponse, oauthError } from '../_shared/errors.ts';
import { AgentUserError, createPlatformAgent, type PlatformAgentDeps } from '../_shared/platformAgent.ts';

export interface Caller {
  userId: string;
  principalType: string;
  clientId: string | null;
}

export interface AgentRecord {
  id: string;
  workspace_id: string;
  auth_user_id: string;
  connection: Record<string, unknown> | null;
}

/** Errors thrown by deps carry the PostgREST code and message (e.g. {code: 'PT403', message: 'forbidden'}). */
export interface DbError {
  code?: string;
  message?: string;
}

/** Calls made with the caller's JWT, so RLS and the RPC checks apply. */
export interface CallerApi {
  canManageWorkspace(workspaceId: string, userId: string): Promise<boolean>;
  isWorkspaceOwner(workspaceId: string, userId: string): Promise<boolean>;
  getPlatformAgent(workspaceId: string): Promise<AgentRecord | null>;
  getAgent(agentId: string): Promise<AgentRecord | null>;
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentAdminDeps {
  loginPepper: string;
  ciPepper: string;
  functionsBaseUrl: string;
  /** Verifies the bearer JWT; null when it is not a valid session token of this project. */
  verifyCaller(token: string): Promise<Caller | null>;
  caller(token: string): CallerApi;
  admin: PlatformAgentDeps['admin'];
  serviceRpc: PlatformAgentDeps['serviceRpc'];
  /** Fresh server-only login as the selected agent; its credentials never leave this handler. */
  signInAgent(email: string, password: string): Promise<AgentOAuthApi>;
  newId(): string;
  randomSecret(): string;
}

export interface AgentOAuthApi {
  read(id: string): Promise<Record<string, unknown>>;
  approve(id: string): Promise<Record<string, unknown>>;
  deny(id: string): Promise<Record<string, unknown>>;
  disconnect(clientId: string): Promise<void>;
}

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['mcp_client', 'webhook', 'a2a', 'managed', 'acp_local'];
const ROLES = ['worker', 'lead'];
// Revocation cannot sign out by user id with the admin API; a ban blocks any new login of the agent's user.
const REVOKED_BAN = '876000h';

const STATUS_BY_CODE: Record<string, number> = { PT400: 400, PT403: 403, PT404: 404, PT409: 409, PT422: 422 };

function error(status: number, code: string, description: string): Response {
  return oauthError(status, code, description, CORS_HEADERS);
}

function ok(body: unknown): Response {
  return jsonResponse(200, body, CORS_HEADERS);
}

function dbFailure(err: unknown, fallback: string): Response {
  const e = (err ?? {}) as DbError;
  const status = e.code ? STATUS_BY_CODE[e.code] : undefined;
  if (status) return error(status, e.message || 'invalid_request', fallback);
  return error(500, 'server_error', fallback);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '');
  return match ? match[1] : null;
}

export async function handleAgentAdmin(req: Request, deps: AgentAdminDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return error(405, 'invalid_request', 'Use POST.');

  const token = bearer(req);
  const caller = token ? await deps.verifyCaller(token).catch(() => null) : null;
  if (!token || !caller) return error(401, 'invalid_token', 'Sign in to manage agents.');
  if (caller.clientId) return error(403, 'direct_session_required', 'Open the app directly to manage agents.');
  if (caller.principalType !== 'human') return error(403, 'humans_only', 'Only people can manage agents.');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!isRecord(body)) return error(400, 'invalid_request', 'Body must be a JSON object.');
  if (body.action !== 'ci_connect' && !deps.loginPepper) return error(500, 'misconfigured', 'AGENT_LOGIN_PEPPER is not set.');

  const api = deps.caller(token);
  switch (body.action) {
    case 'oauth_read':
    case 'oauth_approve':
    case 'oauth_deny':
    case 'oauth_disconnect':
      return agentOAuth(body, api, deps);
    case 'ci_connect': {
      if (!deps.ciPepper || !deps.functionsBaseUrl) return error(500, 'misconfigured', 'CI_WEBHOOK_PEPPER and the functions URL must be set.');
      if (!isUuid(body.workspace_id) || typeof body.repo !== 'string') return error(400, 'invalid_input', 'Use a workspace id and owner/name repository.');
      try {
        const connection = await api.rpc('create_ci_connection', { p_workspace_id: body.workspace_id, p_repo: body.repo });
        if (!isRecord(connection) || !isUuid(connection.id) || typeof connection.repo !== 'string') throw new Error('Invalid connection');
        return ok({ ...connection, webhook_url: `${deps.functionsBaseUrl.replace(/\/+$/, '')}/github-webhook/${connection.id}`,
          secret: await webhookSecret(deps.ciPepper, connection.id) });
      } catch (e) { return dbFailure(e, 'Could not connect the repository.'); }
    }
    case 'connect_agent':
    case 'connect_own_agent':
      return connectAgent(body, caller, api, deps);
    case 'create_agent':
      return createAgent(body, caller, api, deps);
    case 'enable_platform_agent':
      return enablePlatformAgent(body, caller, api, deps);
    case 'revoke_agent':
      return revokeAgent(body, api, deps);
    case 'rotate_login':
      return rotateLogin(body, api, deps);
    default:
      return error(400, 'invalid_request', 'action must be connect_agent, connect_own_agent, create_agent, enable_platform_agent, revoke_agent, rotate_login, ci_connect, oauth_read, oauth_approve, oauth_deny or oauth_disconnect.');
  }
}

async function agentOAuth(body: Record<string, unknown>, api: CallerApi, deps: AgentAdminDeps): Promise<Response> {
  if (!isUuid(body.agent_id)) return error(400, 'invalid_input', 'agent_id must be a uuid.');
  const disconnect = body.action === 'oauth_disconnect';
  const id = disconnect ? body.client_id : body.authorization_id;
  if (typeof id !== 'string' || !id) return error(400, 'invalid_input', 'An authorization or client id is required.');
  try {
    return ok(await runAgentOAuth(String(body.action), id, body.agent_id, api, deps));
  } catch (e) {
    if (e instanceof AgentReadRequired) return error(404, 'not_found', 'Read this authorization as the selected agent first.');
    return dbFailure(e, 'Could not complete this connection. Try again or use Rotate login and reconnect.');
  }
}

class AgentReadRequired extends Error {}
async function runAgentOAuth(action: string, id: string, agentId: string, api: CallerApi, deps: AgentAdminDeps): Promise<Record<string, unknown>> {
  const disconnect = action === 'oauth_disconnect';
  // This caller-token RPC enforces direct human, current membership and sponsor/owner on every action.
  const context = await api.rpc('oauth_agent_context', {
    p_agent_id: agentId, p_client_id: disconnect ? id : null, p_require_enabled: !disconnect,
  });
  if (!isRecord(context) || !isUuid(context.auth_user_id)) throw new Error('Invalid agent context');
  // Block all RLS surfaces before revoking the Auth grant.
  if (disconnect && !context.link_revoked) await api.rpc('revoke_oauth_link', { p_client_id: id });
  const authorization = disconnect ? null : await deps.serviceRpc('oauth_authorization_context', {
    p_authorization_id: id, p_auth_user_id: context.auth_user_id,
  });
  if (!disconnect && (!isRecord(authorization) || typeof authorization.client_id !== 'string' || typeof authorization.redirect_uri !== 'string')) {
    throw new Error('Invalid authorization');
  }
  if (!disconnect && action !== 'oauth_read' && (authorization as Record<string, unknown>).user_id !== context.auth_user_id) {
    throw new AgentReadRequired();
  }
  const agent = await deps.signInAgent(agentEmail(agentId), await agentLoginPassword(
    deps.loginPepper, context.auth_user_id, typeof context.login_nonce === 'string' ? context.login_nonce : null,
  ));
  if (disconnect) { await agent.disconnect(id); return { disconnected: true }; }
  const details = authorization as Record<string, unknown>;
  const result = action === 'oauth_read' ? await agent.read(id)
    : action === 'oauth_approve' ? await agent.approve(id) : await agent.deny(id);
  if (action === 'oauth_approve' || (action === 'oauth_read' && typeof result.redirect_url === 'string')) {
    // Withhold the authorization code unless the current person can still establish the link.
    await api.rpc('set_oauth_app', { p_client_id: details.client_id, p_agent_id: agentId,
      p_client_name: details.client_name ?? 'An app', p_redirect_uri: details.redirect_uri });
  }
  return result;
}

async function createAgent(
  body: Record<string, unknown>,
  caller: Caller,
  api: CallerApi,
  deps: AgentAdminDeps,
): Promise<Response> {
  const { workspace_id, name, kind, role, sponsor_user_id, capabilities, connection, monthly_budget_usd } = body;
  if (!isUuid(workspace_id)) return error(400, 'invalid_request', 'workspace_id must be a uuid.');
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 80) {
    return error(400, 'invalid_request', 'name must have 1 to 80 characters.');
  }
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    return error(400, 'invalid_request', `kind must be one of ${KINDS.join(', ')}.`);
  }
  if (role !== undefined && (typeof role !== 'string' || !ROLES.includes(role))) {
    return error(400, 'invalid_request', 'role must be worker or lead.');
  }
  if (sponsor_user_id !== undefined && !isUuid(sponsor_user_id)) {
    return error(400, 'invalid_request', 'sponsor_user_id must be a uuid.');
  }
  if (capabilities !== undefined && !isRecord(capabilities)) {
    return error(400, 'invalid_request', 'capabilities must be an object.');
  }
  if (connection !== undefined && !isRecord(connection)) {
    return error(400, 'invalid_request', 'connection must be an object.');
  }
  if (
    monthly_budget_usd !== undefined && monthly_budget_usd !== null &&
    !(typeof monthly_budget_usd === 'number' && Number.isFinite(monthly_budget_usd) && monthly_budget_usd >= 0)
  ) {
    return error(400, 'invalid_request', 'monthly_budget_usd must be a non-negative number.');
  }

  let allowed = false;
  try {
    allowed = await api.canManageWorkspace(workspace_id, caller.userId);
  } catch {
    allowed = false;
  }
  if (!allowed) return error(403, 'forbidden', 'Only owners and editors of the workspace can add agents.');

  try { return ok(await createAgentUser(body, caller, deps, deps.newId())); }
  catch (err) {
    if (err instanceof AgentUserError) return error(500, 'server_error', 'The agent user could not be created.');
    return dbFailure(err, 'The agent could not be created.');
  }
}

async function createAgentUser(fields: Record<string, unknown>, caller: Caller, deps: AgentAdminDeps, agentId: string) {
  const { workspace_id, kind, role, sponsor_user_id, capabilities, connection, monthly_budget_usd } = fields;
  const name = String(fields.name);
  const appMetadata = {
    principal_type: 'agent',
    agent_id: agentId,
    workspace_id,
    provider: 'agent_token',
    providers: ['agent_token'],
  };

  let userId: string;
  try {
    // The login password derives from the auth user id, which createUser assigns: set it right after.
    const user = await deps.admin.createUser({
      email: agentEmail(agentId),
      password: deps.randomSecret(),
      email_confirm: true,
      app_metadata: appMetadata,
      user_metadata: {},
    });
    userId = user.id;
  } catch {
    throw new AgentUserError();
  }

  try {
    await deps.admin.updateUserById(userId, {
      password: await agentLoginPassword(deps.loginPepper, userId),
      app_metadata: appMetadata,
    });
    const result = await deps.serviceRpc('create_agent', {
      p_workspace_id: workspace_id,
      p_created_by: caller.userId,
      p_auth_user_id: userId,
      p_name: name.trim(),
      p_kind: kind,
      p_role: role ?? 'worker',
      p_sponsor_user_id: sponsor_user_id ?? null,
      p_capabilities: capabilities ?? {},
      p_connection: connection ?? {},
      p_monthly_budget_usd: monthly_budget_usd ?? null,
      p_id: agentId,
    }) as { agent_id?: string } | null;
    return { agent_id: result?.agent_id ?? agentId, auth_user_id: userId };
  } catch (err) {
    await deps.admin.deleteUser(userId).catch(() => undefined);
    throw err;
  }
}

async function connectAgent(body: Record<string, unknown>, caller: Caller, api: CallerApi, deps: AgentAdminDeps): Promise<Response> {
  const own = body.action === 'connect_own_agent';
  const { workspace_id, authorization_id, agent_id, role } = body;
  const existing = !own && agent_id !== undefined;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!isUuid(workspace_id) || (!own && (typeof authorization_id !== 'string' || !authorization_id))
    || (existing ? !isUuid(agent_id) : name.length < 1 || name.length > 80)
    || (role !== undefined && (typeof role !== 'string' || !ROLES.includes(role)))) {
    return error(400, 'invalid_request', 'Use a workspace, an agent name or id, and a worker or lead role.');
  }
  let createdUser: string | undefined;
  let finished = false;
  try {
    if (!await api.canManageWorkspace(workspace_id, caller.userId)) return error(403, 'forbidden', 'Only owners and editors of the workspace can add agents.');
    let meta: Record<string, unknown> | null = null;
    if (!own) {
      try {
        const context = await api.rpc('oauth_human_context', { p_authorization_id: authorization_id });
        if (isRecord(context)) meta = context;
      } catch (e) { if ((e as DbError)?.code !== 'PT404') throw e; }
    }
    let id: string;
    if (existing) {
      id = agent_id as string;
      await api.rpc('oauth_agent_context', { p_agent_id: id, p_client_id: null, p_require_enabled: true });
    } else {
      const claimed = own ? deps.newId() : await api.rpc('connect_claim', {
        p_workspace_id: workspace_id, p_authorization_id: authorization_id,
        p_client_id: meta?.client_id ?? null, p_agent_id: deps.newId(),
      });
      if (!isUuid(claimed)) throw new Error('Invalid connection claim');
      id = claimed;
      if (own || !await api.getAgent(id)) {
        const created = await createAgentUser({ workspace_id, name, kind: 'mcp_client', role: role ?? 'worker', connection: { source: 'connect' } }, caller, deps, id);
        createdUser = created.auth_user_id;
      }
    }
    const connection = await api.rpc('connect_agent_finish', {
      p_workspace_id: workspace_id, p_agent_id: id, p_client_id: meta?.client_id ?? null,
      p_authorization_id: own ? null : authorization_id,
    });
    if (!isRecord(connection) || typeof connection.page_id !== 'string') throw new Error('Invalid starter page');
    finished = true;
    let result: Record<string, unknown> = {};
    if (!own) {
      result = await runAgentOAuth('oauth_read', authorization_id as string, id, api, deps);
      if (typeof result.redirect_url !== 'string') result = await runAgentOAuth('oauth_approve', authorization_id as string, id, api, deps);
    }
    await api.rpc('connect_agent_approved', { p_agent_id: id });
    return ok({ ...result, agent_id: id, page_id: connection.page_id });
  } catch (e) {
    // Only a user created by this request is disposable. Once granted, a retry resumes it.
    if (createdUser && !finished) await deps.admin.deleteUser(createdUser).catch(() => undefined);
    return dbFailure(e, 'We couldn’t finish saving this connection.');
  }
}

async function enablePlatformAgent(
  body: Record<string, unknown>,
  caller: Caller,
  api: CallerApi,
  deps: AgentAdminDeps,
): Promise<Response> {
  const { workspace_id } = body;
  if (!isUuid(workspace_id)) return error(400, 'invalid_request', 'workspace_id must be a uuid.');

  let allowed = false;
  try {
    allowed = await api.isWorkspaceOwner(workspace_id, caller.userId);
  } catch {
    allowed = false;
  }
  if (!allowed) return error(403, 'forbidden', 'Only the workspace owner can enable the Colabora agent.');

  try {
    const existing = await api.getPlatformAgent(workspace_id);
    if (existing) return ok({ agent_id: existing.id, auth_user_id: existing.auth_user_id, created: false });
  } catch (err) {
    return dbFailure(err, 'The platform agent could not be read.');
  }

  try {
    return ok(await createPlatformAgent(workspace_id, caller.userId, deps));
  } catch (err) {
    if (err instanceof AgentUserError) return error(500, 'server_error', 'The agent user could not be created.');
    return dbFailure(err, 'The platform agent could not be enabled.');
  }
}

async function revokeAgent(body: Record<string, unknown>, api: CallerApi, deps: AgentAdminDeps): Promise<Response> {
  const { agent_id, reason } = body;
  if (!isUuid(agent_id)) return error(400, 'invalid_request', 'agent_id must be a uuid.');
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
    return error(400, 'invalid_request', 'reason must be text up to 500 characters.');
  }

  let agent: AgentRecord | null;
  try {
    agent = await api.getAgent(agent_id);
  } catch (err) {
    return dbFailure(err, 'The agent could not be read.');
  }
  if (!agent) return error(404, 'not_found', 'Agent not found.');

  try {
    await api.rpc('revoke_agent', { p_agent_id: agent_id, p_reason: reason ?? null });
  } catch (err) {
    return dbFailure(err, 'The agent could not be revoked.');
  }

  // The database already denies the agent everywhere; the ban also stops new logins.
  let loginBlocked = true;
  try {
    await deps.admin.updateUserById(agent.auth_user_id, { ban_duration: REVOKED_BAN });
  } catch {
    loginBlocked = false;
  }
  return ok({ agent_id, revoked: true, login_blocked: loginBlocked });
}

async function rotateLogin(body: Record<string, unknown>, api: CallerApi, deps: AgentAdminDeps): Promise<Response> {
  const { agent_id } = body;
  if (!isUuid(agent_id)) return error(400, 'invalid_request', 'agent_id must be a uuid.');

  let agent: AgentRecord | null;
  try {
    agent = await api.getAgent(agent_id);
  } catch (err) {
    return dbFailure(err, 'The agent could not be read.');
  }
  if (!agent) return error(404, 'not_found', 'Agent not found.');

  const nonce = deps.randomSecret();
  try {
    // update_agent replaces the whole connection object, so merge the current one.
    await api.rpc('update_agent', {
      p_agent_id: agent_id,
      p_patch: { connection: { ...(agent.connection ?? {}), login_nonce: nonce } },
    });
  } catch (err) {
    return dbFailure(err, 'The agent login could not be rotated.');
  }

  try {
    const password = await agentLoginPassword(deps.loginPepper, agent.auth_user_id, nonce);
    await deps.serviceRpc('prepare_agent_login_rotation', { p_auth_user_id: agent.auth_user_id, p_password: password });
    await deps.admin.updateUserById(agent.auth_user_id, {
      password,
    });
  } catch {
    return error(500, 'server_error', 'The new login was recorded but not applied. Rotate again.');
  }
  return ok({ agent_id, rotated: true });
}
