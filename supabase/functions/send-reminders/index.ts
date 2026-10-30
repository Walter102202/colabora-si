// send-reminders — delivers due reminders as Web Push notifications.
//
// Invoked once a minute by pg_cron (see the schedule_send_reminders migration).
// Deployed with verify_jwt = false because the caller is Postgres, not a user:
// authorization is a shared secret in the `x-push-secret` header, compared
// against private.app_secrets via public.push_config() (service_role only).
//
// VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291/8188) are
// implemented directly on WebCrypto — no third-party push library.

import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { agentPush, pushOutcome, shouldPush, tooOldToPush, type AgentNotification, type PushApproval, type PushPayload, type PushResult } from "./payload.ts";
import { isBrowserPushEndpoint } from "./endpoint.ts";

const enc = new TextEncoder();

// --- byte helpers -----------------------------------------------------------

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Timing-safe equality for the shared secret. */
function secretEquals(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// --- HKDF (RFC 5869, single-block output — everything here is <= 32 bytes) ---

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

// --- VAPID -------------------------------------------------------------------

async function vapidAuthorization(
  endpoint: string,
  publicKey: string,
  privateKeyD: string,
  subject: string,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(
    enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const payload = bytesToB64url(
    enc.encode(
      JSON.stringify({
        aud,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;

  const pub = b64urlToBytes(publicKey); // 65-byte uncompressed P-256 point
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: privateKeyD,
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      key_ops: ["sign"],
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto ECDSA already produces the raw r||s form JWS/VAPID wants.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(signingInput),
    ),
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${publicKey}`;
}

// --- aes128gcm content encoding ----------------------------------------------

async function encryptPayload(
  plaintext: string,
  p256dh: string,
  authSecret: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlToBytes(p256dh); // 65 bytes
  const auth = b64urlToBytes(authSecret); // 16 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const local = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", local.publicKey),
  );
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      local.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.4: IKM is derived from the ECDH secret keyed by the auth secret
  const ikm = await hkdf(
    auth,
    shared,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublic),
    32,
  );
  const cek = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );

  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  // 0x02 is the last-record padding delimiter (single-record message)
  const body = concat(enc.encode(plaintext), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, body),
  );

  // header = salt(16) || rs(4) || idlen(1) || keyid(as_public, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// --- delivery ----------------------------------------------------------------

interface Sub {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
}

// A push service that accepts the connection and never answers would otherwise hold the whole pass.
const PUSH_TIMEOUT_MS = 10_000;

// Only a server operator running against a local Supabase can enable a capture
// server. Nothing in the request, subscription or database can enable this.
function isLocalCaptureEndpoint(endpoint: string): boolean {
  const origin = Deno.env.get("PUSH_LOCAL_CAPTURE_ORIGIN");
  if (!origin || Deno.env.has("DENO_DEPLOYMENT_ID")) return false;
  try {
    const backend = new URL(Deno.env.get("SUPABASE_URL") ?? "");
    const url = new URL(endpoint);
    return backend.protocol === "http:" && ["127.0.0.1", "localhost", "kong"].includes(backend.hostname) &&
      url.protocol === "http:" && url.hostname === "127.0.0.1" && url.origin === origin &&
      !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export async function sendPush(
  sub: Sub,
  payload: string,
  cfg: { vapid_public: string; vapid_private: string; vapid_subject: string },
): Promise<number | "invalid"> {
  if (!isBrowserPushEndpoint(sub.endpoint) && !isLocalCaptureEndpoint(sub.endpoint)) return "invalid";
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await encryptPayload(payload, sub.p256dh, sub.auth);
  } catch {
    // Malformed subscription keys can never receive a push.
    return "invalid";
  }
  const authorization = await vapidAuthorization(
    sub.endpoint,
    cfg.vapid_public,
    cfg.vapid_private,
    cfg.vapid_subject,
  );
  const res = await fetch(sub.endpoint, {
    method: "POST",
    redirect: "manual", // Never follow an allowed provider to an unchecked destination.
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  // Drain so the connection can be reused / released.
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

// --- handler -----------------------------------------------------------------

interface DueReminder {
  id: string;
  user_id: string;
  page_id: string | null;
  body: string;
  // Set only for an agent notification. A reminder's id is free text its author picks, so the id never tells the two apart.
  notificationId?: string;
  push?: PushPayload;
}

const serviceKey = (() => {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  // newer projects expose a JSON map of secret keys instead
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      return parsed["default"] ?? Object.values(parsed)[0];
    } catch {
      /* fall through */
    }
  }
  return "";
})();

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, {
    auth: { persistSession: false },
  });

  const { data: cfgRows, error: cfgErr } = await supabase.rpc("push_config");
  const cfg = (cfgRows as
    | {
      vapid_public: string;
      vapid_private: string;
      cron_secret: string;
      vapid_subject: string;
    }[]
    | null)?.[0];
  if (cfgErr || !cfg?.cron_secret || !cfg.vapid_private) {
    console.error("push_config unavailable", cfgErr);
    return new Response("Server misconfigured", { status: 500 });
  }

  const presented = req.headers.get("x-push-secret") ?? "";
  if (!secretEquals(presented, cfg.cron_secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { data: dueRows, error: dueErr } = await supabase.rpc("due_push_reminders");
  if (dueErr) {
    console.error("due query failed", dueErr);
    return new Response("Query failed", { status: 500 });
  }

  const due = (dueRows ?? []) as DueReminder[];
  const pending = await supabase.rpc("pending_push_notifications");
  if (pending.error) return new Response("Query failed", { status: 500 });
  const agentRows = (pending.data ?? []) as (AgentNotification & { user_id: string; created_at: string })[];
  const approvalIds = [...new Set(agentRows.map((r) => r.approval_id).filter((id): id is string => !!id))];
  const taskIds = [...new Set(agentRows.map((r) => r.task_id).filter((id): id is string => !!id))];
  const approvals = new Map<string, PushApproval>();
  const titles = new Map<string, string>();
  if (approvalIds.length) {
    const { data, error } = await supabase.from("agent_approvals").select("id,action,params,artifact_version,question,kind,blocking,status").in("id", approvalIds);
    if (error) console.error("approval lookup failed", error); // The push still goes out with a generic text.
    for (const a of (data ?? []) as (PushApproval & { id: string })[]) approvals.set(a.id, a);
  }
  if (taskIds.length) {
    const { data, error } = await supabase.from("agent_tasks").select("id,title").in("id", taskIds);
    if (error) console.error("task lookup failed", error);
    for (const t of (data ?? []) as { id: string; title: string }[]) titles.set(t.id, t.title);
  }
  // Rows that need no push: their approval was already decided, or they outlived the push TTL. Marked now,
  // so they never hold the queue.
  const settled: string[] = [];
  const now = Date.now();
  for (const row of agentRows) {
    const approval = row.approval_id ? (approvals.get(row.approval_id) ?? null) : null;
    if (!shouldPush(row, approval) || tooOldToPush(row.created_at, now)) {
      settled.push(row.id);
      continue;
    }
    const p = agentPush(row, row.task_id ? (titles.get(row.task_id) ?? null) : null, approval);
    due.push({ id: p.id, user_id: row.user_id, page_id: row.page_id, body: p.body, notificationId: row.id, push: p });
  }
  if (settled.length) {
    const { error } = await supabase.from("notifications").update({ pushed_at: new Date().toISOString() }).in("id", settled);
    if (error) console.error("marking settled notifications failed", error);
  }
  if (due.length === 0) {
    return Response.json({ due: 0, sent: 0, notified: 0, removed: 0 });
  }

  const userIds = [...new Set(due.map((r) => r.user_id))];
  const { data: subRows, error: subErr } = await supabase
    .from("push_subscriptions")
    .select("endpoint, user_id, p256dh, auth")
    .in("user_id", userIds);
  if (subErr) {
    console.error("subscription query failed", subErr);
    return new Response("Query failed", { status: 500 });
  }

  const byUser = new Map<string, Sub[]>();
  for (const s of (subRows ?? []) as Sub[]) {
    const list = byUser.get(s.user_id);
    if (list) list.push(s);
    else byUser.set(s.user_id, [s]);
  }

  const expired = new Set<string>();
  // Endpoints that threw (timeout, network) or answered 429/5xx: skipped for the rest of the pass.
  const unreachable = new Set<string>();
  // The cron call gives up after 30 s: the pass stops starting sends after 15 s (plus at most one timeout),
  // so it always reaches the marking below; the rest waits for the next minute.
  const deadline = Date.now() + 15_000;
  const deliveredIds: string[] = [];
  const reminderIds: string[] = [];
  // Agent notifications that leave the queue: delivered, nobody to push to, or refused for good.
  const notificationIds: string[] = [];
  const statuses: Record<string, number> = {};
  let sent = 0;

  const send = async (reminder: DueReminder) => {
    const subs = byUser.get(reminder.user_id);
    // No push subscription for a reminder: leave `notified` false so the
    // in-app checker still fires the toast next time the app is open.
    if (!subs?.length) {
      // Agent notifications already show in the inbox: mark them so the 200 oldest never block newer ones.
      if (reminder.notificationId) notificationIds.push(reminder.notificationId);
      return;
    }

    const payload = JSON.stringify(reminder.push ?? {
      id: reminder.id,
      title: "Reminder",
      body: reminder.body || "Reminder",
      url: reminder.page_id ? `/p/${reminder.page_id}` : "/",
    });

    // A person's devices are tried together, so one that never answers costs a single timeout.
    const targets = subs.filter((sub) => !expired.has(sub.endpoint) && !unreachable.has(sub.endpoint));
    const results = await Promise.all(targets.map(async (sub): Promise<PushResult> => {
      try {
        return await sendPush(sub, payload, cfg);
      } catch (e) {
        console.error("push send threw", sub.endpoint, e);
        unreachable.add(sub.endpoint);
        return "threw";
      }
    }));
    targets.forEach((sub, i) => {
      const status = results[i];
      if (status === "threw") return;
      statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
      if (status === "invalid" || status === 404 || status === 410) {
        expired.add(sub.endpoint);
      } else if (typeof status === "number" && status >= 200 && status < 300) {
        sent++;
      } else {
        console.error("push rejected", status, sub.endpoint);
        // A service that is overloaded or failing now is tried again next pass, not for every row of this one.
        if (status === 429 || (typeof status === "number" && status >= 500)) unreachable.add(sub.endpoint);
      }
    });
    const outcome = pushOutcome(results);
    if (outcome === "delivered") deliveredIds.push(reminder.id);
    // A reminder that was not delivered keeps `notified` false. An agent notification also leaves the queue
    // when every subscription refused it for good.
    if (reminder.notificationId) {
      if (outcome !== "retry") notificationIds.push(reminder.notificationId);
    } else if (outcome === "delivered") reminderIds.push(reminder.id);
  };
  // Eight people are served at a time, each person's rows in order, and people come in a new random order
  // each pass: a person whose push service is slow holds one worker for one timeout, and nobody is always last.
  const byPerson = new Map<string, DueReminder[]>();
  for (const r of due) {
    const list = byPerson.get(r.user_id);
    if (list) list.push(r);
    else byPerson.set(r.user_id, [r]);
  }
  const people = [...byPerson.values()];
  for (let i = people.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [people[i], people[j]] = [people[j], people[i]];
  }
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < people.length && Date.now() <= deadline) {
      for (const reminder of people[next++]) {
        if (Date.now() > deadline) break;
        await send(reminder);
      }
    }
  }));

  if (notificationIds.length) {
    const { error } = await supabase.from("notifications").update({ pushed_at: new Date().toISOString() }).in("id", notificationIds);
    if (error) console.error("marking pushed failed", error);
  }
  if (reminderIds.length) {
    const { error } = await supabase
      .from("reminders")
      .update({ notified: true })
      .in("id", reminderIds);
    if (error) console.error("marking notified failed", error);
  }

  if (expired.size) {
    const { error } = await supabase
      .from("push_subscriptions")
      .delete()
      .in("endpoint", [...expired]);
    if (error) console.error("pruning subscriptions failed", error);
  }

  return Response.json({
    due: due.length,
    sent,
    notified: deliveredIds.length,
    removed: expired.size,
    statuses,
  });
}

if (import.meta.main) Deno.serve(handleRequest);
