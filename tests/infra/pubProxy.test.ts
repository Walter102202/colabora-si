import { describe, expect, it } from "vitest";
import { proxyPublicPage, upstreamUrl } from "../../api/pub";

// The Vercel proxy that gives crawlers the public page as real HTML.
const html = "<!doctype html><html><head><title>Launch plan · colabora.si</title></head><body></body></html>";

function fakeFetch(status: number, body: string, headers: Record<string, string> = {}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(body, { status, headers });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe("proxyPublicPage", () => {
  it("re-emits the upstream HTML as text/html with its cache headers", async () => {
    const f = fakeFetch(200, html, { "Content-Type": "text/plain", "Cache-Control": "public, max-age=60, s-maxage=300", Link: "<x>; rel=\"alternate\"" });
    const res = await proxyPublicPage(new Request("https://colabora.si/api/pub?id=launch-plan"), f.fetch);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=300");
    expect(res.headers.get("Link")).toContain("alternate");
    expect(await res.text()).toBe(html);
    expect(f.calls).toEqual([upstreamUrl("launch-plan")]);
  });

  it("passes a 404 through without caching", async () => {
    const f = fakeFetch(404, "Not found", { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    const res = await proxyPublicPage(new Request("https://colabora.si/api/pub?id=missing"), f.fetch);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects ids the function would not accept before calling upstream", async () => {
    const f = fakeFetch(200, html);
    const res = await proxyPublicPage(new Request("https://colabora.si/api/pub?id=bad%20id"), f.fetch);
    expect(res.status).toBe(400);
    expect(f.calls).toEqual([]);
  });

  it("answers HEAD with headers only", async () => {
    const f = fakeFetch(200, html, { "Cache-Control": "public, max-age=60" });
    const res = await proxyPublicPage(new Request("https://colabora.si/api/pub?id=launch-plan", { method: "HEAD" }), f.fetch);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
