import { inviteUrl, recoveryCopy, sendAccountEmail, sendInvite, workspaceCopy, type InviteFailure } from './inviteEmail.ts';

export interface AccountTarget { exists: boolean; confirmed: boolean; workspace?: { name: string; inviter: string } | null; }
interface AccountLinks {
  generateLink(params: { type: 'invite' | 'recovery'; email: string }): Promise<{ data: { properties: { hashed_token?: string } | null }; error: InviteFailure | null }>;
}

export async function deliverAccountLink(links: AccountLinks, key: string, appUrl: string, email: string, target: AccountTarget, invite: string | null, send: typeof fetch = fetch): Promise<void> {
  let failure: InviteFailure | null;
  if (!target.confirmed) {
    failure = await sendInvite(links, key, appUrl, email, send, target.workspace && invite ? { ...target.workspace, token: invite } : undefined);
  } else {
    const { data, error } = await links.generateLink({ type: 'recovery', email });
    if (error || !data.properties?.hashed_token) throw new Error('account_token_failed');
    const token = data.properties.hashed_token;
    const url = inviteUrl(appUrl, token, email, 'recovery', invite ?? undefined);
    const copy = target.workspace ? workspaceCopy(target.workspace.inviter, target.workspace.name) : recoveryCopy;
    failure = await sendAccountEmail(key, email, url, copy, `recovery/${token}`, send);
  }
  if (failure) throw new Error('account_email_failed');
}
