import type { AccountTarget } from '../_shared/accountEmail.ts';

export interface AccountLinkDeps {
  appOrigin: string;
  background(work: Promise<unknown>): void;
  allowed(email: string, ip: string): Promise<boolean>;
  lookup(email: string, invite: string | null): Promise<AccountTarget | null>;
  send(email: string, target: AccountTarget, invite: string | null): Promise<void>;
}

// Drain oversized bodies too: the Edge gateway otherwise hangs the response. Keep at most 2 KiB.
export async function readAccountBody(req: Request): Promise<string | null> {
  let size = 0; const chunks: Uint8Array[] = [];
  if (req.body) for await (const chunk of req.body) { size += chunk.length; if (size <= 2048) chunks.push(chunk); }
  if (size > 2048) return null;
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function handleAccountLink(req: Request, deps: AccountLinkDeps): Promise<Response> {
  const origin = req.headers.get('Origin') === deps.appOrigin;
  const headers: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': deps.appOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin', 'Cache-Control': 'no-store' } : {};
  if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers });
  const raw = await readAccountBody(req);
  if (!origin) return new Response(null, { status: 403 });
  if (raw === null) return new Response(null, { status: 413, headers });
  let email: string, invite: string | null;
  try {
    const body = JSON.parse(raw);
    email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    invite = typeof body?.invite === 'string' && body.invite ? body.invite : null;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || (invite && invite.length > 256)) throw new Error();
  } catch { return new Response(null, { status: 400, headers }); }
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  deps.background((async () => {
    // Yield before account-dependent work. No lookup/provider latency affects the public answer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      if (!await deps.allowed(email, ip)) return;
      const target = await deps.lookup(email, invite);
      // generateLink(invite) creates users, so unknown public callers must stop here.
      if (target?.exists) await deps.send(email, target, invite);
    } catch { console.error('account_link_failed'); }
  })());
  return Response.json({ message: 'If that email has an account, we sent a link.' }, { headers });
}
