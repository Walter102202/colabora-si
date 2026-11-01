// POST /functions/v1/waitlist-invites: called every minute by pg_cron with the dispatch secret (verify_jwt = false).
import { denoEnv, serviceClient } from '../_shared/supabase.ts';
import { handleWaitlistInvites } from './handler.ts';
import { markInvited, markInviteError, pendingInvites } from './notion.ts';

Deno.serve((req) => {
  const env = denoEnv();
  const { NOTION_TOKEN: token, NOTION_WAITLIST_DATABASE_ID: databaseId, APP_URL: appUrl } = env;
  return handleWaitlistInvites(req, {
    secret: env.DISPATCH_SECRET ?? '',
    now: () => new Date(),
    list: token && databaseId && appUrl ? {
      pending: () => pendingInvites(token, databaseId),
      markInvited: (pageId, at) => markInvited(token, pageId, at),
      markError: (pageId, message) => markInviteError(token, pageId, message),
    } : undefined,
    async invite(email) {
      const { error } = await serviceClient(env).auth.admin.inviteUserByEmail(email, { redirectTo: appUrl });
      return error ? { status: error.status, code: error.code } : null;
    },
  });
});
