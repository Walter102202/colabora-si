// Creates the Trama of a workspace: the agent's auth user, then its row. agent-admin and trama-runtime share it.
import { agentEmail, agentLoginPassword } from './agentLogin.ts';

export interface AdminUserAttributes {
  email?: string;
  password?: string;
  email_confirm?: boolean;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  ban_duration?: string;
}

export interface PlatformAgentDeps {
  loginPepper: string;
  admin: {
    createUser(attrs: AdminUserAttributes): Promise<{ id: string }>;
    updateUserById(id: string, attrs: AdminUserAttributes): Promise<void>;
    deleteUser(id: string): Promise<void>;
  };
  serviceRpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
  newId(): string;
  randomSecret(): string;
}

/** The auth user could not be created; nothing was left behind. */
export class AgentUserError extends Error {}

export async function createPlatformAgent(workspaceId: string, createdBy: string, deps: PlatformAgentDeps) {
  const agentId = deps.newId();
  const appMetadata = {
    principal_type: 'agent',
    agent_id: agentId,
    workspace_id: workspaceId,
    provider: 'agent_token',
    providers: ['agent_token'],
  };

  let userId: string;
  try {
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
    const result = await deps.serviceRpc('ensure_platform_agent', {
      p_workspace_id: workspaceId,
      p_created_by: createdBy,
      p_auth_user_id: userId,
      p_id: agentId,
    }) as { agent_id?: string; auth_user_id?: string; created?: boolean } | null;
    if (result?.created !== true) {
      await deps.admin.deleteUser(userId).catch(() => undefined);
      return { agent_id: result?.agent_id, auth_user_id: result?.auth_user_id, created: false };
    }
    return { agent_id: result.agent_id, auth_user_id: userId, created: true };
  } catch (err) {
    await deps.admin.deleteUser(userId).catch(() => undefined);
    throw err;
  }
}
