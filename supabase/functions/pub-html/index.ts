// GET /functions/v1/pub-html/<pageId>[.md]: a public page as HTML for crawlers and link previews, or as Markdown
// for agents (verify_jwt = false). Reads only through the anon client: get_page_bundle applies the same "published"
// rule the web app's /pub route relies on. Never the service role.
import { supabaseDb } from '../_shared/db.ts';
import { anonClient, denoEnv } from '../_shared/supabase.ts';
import { handlePubHtml } from './handler.ts';

export { handlePubHtml };

Deno.serve((req) => {
  const env = denoEnv();
  let db;
  try {
    db = supabaseDb(anonClient(env), req.signal);
  } catch {
    return new Response('The function environment is incomplete.\n', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return handlePubHtml(req, { db, appUrl: (env.APP_URL ?? '').replace(/\/+$/, '') });
});
