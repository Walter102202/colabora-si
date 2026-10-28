// Vercel function: serves a public page as HTML for crawlers.
//
// The HTML itself comes from the Supabase Edge Function `pub-html`, but the
// Supabase gateway relabels every `text/html` response as `text/plain`, which
// crawlers refuse to parse for Open Graph. This proxy fetches that response and
// re-emits it with the right content type. `vercel.json` routes crawler user
// agents for `/pub/:id` here; people keep getting the single-page app.

const ORIGIN = "https://xiuehxfljusakgblcfhm.supabase.co";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function upstreamUrl(id: string, origin = ORIGIN): string {
  return `${origin}/functions/v1/pub-html/${encodeURIComponent(id)}`;
}

export async function proxyPublicPage(request: Request, fetchImpl: typeof fetch = fetch, origin = ORIGIN): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!ID.test(id)) return new Response("Bad request", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const upstream = await fetchImpl(upstreamUrl(id, origin), { headers: { Accept: "text/html" } });
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  for (const name of ["Cache-Control", "Link", "Content-Security-Policy", "Last-Modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", upstream.ok ? "public, max-age=60, s-maxage=300" : "no-store");
  const body = request.method === "HEAD" ? null : await upstream.text();
  return new Response(body, { status: upstream.status, headers });
}

export function GET(request: Request): Promise<Response> {
  return proxyPublicPage(request);
}

export function HEAD(request: Request): Promise<Response> {
  return proxyPublicPage(request);
}
