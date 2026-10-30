import assert from "node:assert/strict";
import { isBrowserPushEndpoint } from "./endpoint.ts";

const savedKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "local-test-key");
const { sendPush, handleRequest } = await import("./index.ts");
if (savedKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedKey);

const b64 = (data: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64(await crypto.subtle.exportKey("raw", keys.publicKey));
const cfg = { vapid_public: publicKey, vapid_private: (await crypto.subtle.exportKey("jwk", keys.privateKey)).d!, vapid_subject: "mailto:push@example.com", cron_secret: "test-secret" };
const sub = { user_id: "person", p256dh: publicKey, auth: b64(new Uint8Array(16).buffer) };
const rejected = [
  "https://fcm.googleapis.com.evil.com/push", "http://fcm.googleapis.com/push", "https://fcm.googleapis.com@evil.com/push",
  "https://127.0.0.1/push", "https://[::1]/push", "https://169.254.169.254/latest/meta-data", "https://2130706433/push",
  "https://fcm.googleapis.com:444/push", "https://fcm.googleapis.com:80/push", "https://evilnotify.windows.com/push",
  "https://web.push.apple.com.evil.com/push", "https://updates.push.services.mozilla.com.evil.com/push",
  "https://user:password@fcm.googleapis.com/push", "https://fcm.googleapis.com/push#fragment", "not a URL",
];

function environment(values: Record<string, string | undefined>): () => void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, Deno.env.get(key)]));
  const apply = (env: typeof values) => Object.entries(env).forEach(([key, value]) => value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value));
  apply(values);
  return () => apply(before);
}

Deno.test("only browser push providers reach the network, with redirects disabled", async () => {
  const restore = environment({ PUSH_LOCAL_CAPTURE_ORIGIN: undefined });
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (_input, init) => { calls.push(init!); return Promise.resolve(new Response(null, { status: 201 })); };
  try {
    for (const endpoint of rejected) {
      assert.equal(isBrowserPushEndpoint(endpoint), false, endpoint);
      assert.equal(await sendPush({ ...sub, endpoint }, "payload", cfg), "invalid", endpoint);
    }
    assert.equal(calls.length, 0, "blocked endpoints never reach fetch, even with valid encryption keys");
    const accepted = ["https://fcm.googleapis.com/wp/token", "https://fcm.googleapis.com:443/fcm/send/token",
      "https://updates.push.services.mozilla.com/wpush/v2/token", "https://wns2-db5p.notify.windows.com/?token=opaque",
      "https://web.push.apple.com/Qtoken", "https://a.b.push.apple.com/token"];
    for (const endpoint of accepted) {
      assert.equal(isBrowserPushEndpoint(endpoint), true, endpoint);
      assert.equal(await sendPush({ ...sub, endpoint }, "payload", cfg), 201);
    }
    assert.equal(calls.length, accepted.length);
    assert.ok(calls.every((call) => call.method === "POST" && call.redirect === "manual" && call.body instanceof Uint8Array));
  } finally { globalThis.fetch = originalFetch; restore(); }
});

Deno.test("local capture is explicit, cannot run hosted, and never follows redirects", async () => {
  const origin = "http://127.0.0.1:60727";
  const paths: string[] = [];
  const capture = Deno.serve({ hostname: "127.0.0.1", port: 60727, onListen() {} }, async (req) => {
    paths.push(new URL(req.url).pathname);
    assert.equal(req.headers.get("content-encoding"), "aes128gcm");
    assert.ok((await req.arrayBuffer()).byteLength > 100);
    return new Response(null, { status: 307, headers: { Location: `${origin}/redirect-target` } });
  });
  const restore = environment({ SUPABASE_URL: "http://127.0.0.1:60721", DENO_DEPLOYMENT_ID: undefined, PUSH_LOCAL_CAPTURE_ORIGIN: undefined });
  try {
    const target = { ...sub, endpoint: `${origin}/capture` };
    assert.equal(await sendPush(target, "payload", cfg), "invalid");
    Deno.env.set("PUSH_LOCAL_CAPTURE_ORIGIN", origin);
    assert.equal(await sendPush({ ...sub, endpoint: "http://127.0.0.1:60726/wrong-port" }, "payload", cfg), "invalid");
    assert.equal(await sendPush(target, "payload", cfg), 307);
    Deno.env.set("DENO_DEPLOYMENT_ID", "project_function_version");
    assert.equal(await sendPush(target, "payload", cfg), "invalid", "hosted deployments cannot enable capture");
    Deno.env.delete("DENO_DEPLOYMENT_ID");
    Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
    assert.equal(await sendPush(target, "payload", cfg), "invalid", "a remote backend also disables capture");
    assert.deepEqual(paths, ["/capture"], "no redirect or rejected endpoint was called");
  } finally { restore(); await capture.shutdown(); }
});

Deno.test("the handler prunes unsafe subscriptions without marking reminders notified", async () => {
  const restore = environment({ SUPABASE_URL: "http://127.0.0.1:60721", PUSH_LOCAL_CAPTURE_ORIGIN: undefined });
  const originalFetch = globalThis.fetch;
  const writes: { table: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input)), table = url.pathname.split("/").pop()!;
    assert.equal(url.origin, "http://127.0.0.1:60721", "no untrusted push endpoint reaches fetch");
    const method = init?.method ?? "GET";
    if (table === "prune_push_subscriptions") {
      assert.equal(method, "POST");
      assert.equal(url.search, "", "opaque endpoints stay out of the URL");
      writes.push({ table, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(Response.json(1));
    }
    const rows: Record<string, unknown> = {
      push_config: [cfg], due_push_reminders: [{ id: "r1", user_id: "person", page_id: null, body: "Reminder" }],
      pending_push_notifications: [], push_subscriptions: [{ ...sub, endpoint: "http://127.0.0.1:60727/untrusted" }],
    };
    assert.ok(table in rows, table);
    return Promise.resolve(Response.json(rows[table]));
  };
  try {
    const response = await handleRequest(new Request("http://localhost/send-reminders", {
      method: "POST", headers: { "x-push-secret": cfg.cron_secret, "x-push-local-capture-origin": "http://127.0.0.1:60727" },
      body: JSON.stringify({ PUSH_LOCAL_CAPTURE_ORIGIN: "http://127.0.0.1:60727" }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { due: 1, sent: 0, notified: 0, removed: 1, statuses: { invalid: 1 } });
    assert.deepEqual(writes, [{ table: "prune_push_subscriptions", method: "POST", body: { p_endpoints: ["http://127.0.0.1:60727/untrusted"] } }]);
  } finally { globalThis.fetch = originalFetch; restore(); }
});

Deno.test("the handler sends opaque ids in the RPC body and counts only marked reminders", async () => {
  const restore = environment({ SUPABASE_URL: "http://127.0.0.1:60721" });
  const originalFetch = globalThis.fetch;
  const ids = ['p")q', 'zz","victim-1', ...Array.from({ length: 20 }, (_, i) => `${i}-${"x".repeat(2600)}`)];
  let markResult: number | null = 7;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input)), table = url.pathname.split("/").pop()!;
    if (url.origin === "https://fcm.googleapis.com") return Promise.resolve(new Response(null, { status: 201 }));
    if (table === "mark_reminders_pushed") {
      assert.equal(init?.method, "POST");
      assert.equal(url.search, "");
      assert.deepEqual(JSON.parse(String(init?.body)), { p_ids: ids });
      return Promise.resolve(markResult === null
        ? Response.json({ message: "write failed" }, { status: 500 }) : Response.json(markResult));
    }
    const rows: Record<string, unknown> = {
      push_config: [cfg], due_push_reminders: ids.map((id) => ({ id, user_id: "person", page_id: null, body: "Reminder" })),
      pending_push_notifications: [], push_subscriptions: [{ ...sub, endpoint: "https://fcm.googleapis.com/wp/token" }],
    };
    assert.ok(table in rows, table);
    return Promise.resolve(Response.json(rows[table]));
  };
  try {
    for (markResult of [7, 0, null]) {
      const response = await handleRequest(new Request("http://localhost/send-reminders", {
        method: "POST", headers: { "x-push-secret": cfg.cron_secret },
      }));
      assert.deepEqual(await response.json(), { due: ids.length, sent: ids.length, notified: markResult ?? 0, removed: 0, statuses: { 201: ids.length } });
    }
  } finally { globalThis.fetch = originalFetch; restore(); }
});

Deno.test("redirects and rejections skip only that device until the next pass", async () => {
  const restore = environment({ SUPABASE_URL: "http://127.0.0.1:60721" });
  const originalFetch = globalThis.fetch;
  let rejectedStatus = 307;
  globalThis.fetch = (input) => {
    const url = new URL(String(input)), table = url.pathname.split("/").pop()!;
    if (url.origin === "https://fcm.googleapis.com") {
      return Promise.resolve(new Response(null, { status: table === "rejected" ? rejectedStatus : 201 }));
    }
    const rows: Record<string, unknown> = {
      push_config: [cfg], pending_push_notifications: [],
      due_push_reminders: [1, 2, 3].map((i) => ({ id: `r${i}`, user_id: "person", page_id: null, body: "Reminder" })),
      push_subscriptions: ["rejected", "working"].map((name) => ({ ...sub, endpoint: `https://fcm.googleapis.com/wp/${name}` })),
      mark_reminders_pushed: 3,
    };
    assert.ok(table in rows, `unexpected request (subscriptions must not be pruned): ${table}`);
    return Promise.resolve(Response.json(rows[table]));
  };
  try {
    for (rejectedStatus of [301, 307, 400, 401, 403, 413, 429, 500, 503]) {
      for (let pass = 0; pass < 2; pass++) {
        const response = await handleRequest(new Request("http://localhost/send-reminders", {
          method: "POST", headers: { "x-push-secret": cfg.cron_secret },
        }));
        assert.deepEqual(await response.json(), {
          due: 3, sent: 3, notified: 3, removed: 0, statuses: { 201: 3, [rejectedStatus]: 1 },
        }, `status ${rejectedStatus}, pass ${pass}: the healthy device still receives every reminder`);
      }
    }
  } finally { globalThis.fetch = originalFetch; restore(); }
});
