import { denoEnv, serviceClient } from '../_shared/supabase.ts';
import { handleGithubWebhook } from './handler.ts';

Deno.serve((req) => {
  const env = denoEnv();
  return handleGithubWebhook(req, {
    pepper: env.CI_WEBHOOK_PEPPER ?? '',
    record: async (connectionId, repo, run) => {
      const { data, error } = await serviceClient(env).rpc('record_ci_check', {
        p_connection_id: connectionId, p_repo: repo, p_run: run,
      });
      return { data, error };
    },
  });
});
