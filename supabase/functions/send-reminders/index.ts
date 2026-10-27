// send-reminders — delivers due reminders as Web Push notifications.
//
// Invoked once a minute by pg_cron (see the schedule_send_reminders migration).
// Deployed with verify_jwt = false because the caller is Postgres, not a user:
// authorization is a shared secret in the `x-push-secret` header, compared
// against private.app_secrets via public.push_config() (service_role only).
//
// VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291/8188) are
// implemented directly on WebCrypto — no third-party push library.

import { createClient } from "jsr:@supabase/supabase-js@2";

const enc = new TextEncoder();

// --- byte helpers -----------------------------------------------------------

function b64urlToBytes(s: string): Uint8Array {
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

function concat(...parts: Uint8Array[]): Uint8Array {
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

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
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
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
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
): Promise<Uint8Array> {
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

async function sendPush(
  sub: Sub,
  payload: string,
  cfg: { vapid_public: string; vapid_private: string; vapid_subject: string },
): Promise<number> {
  const body = await encryptPayload(payload, sub.p256dh, sub.auth);
  const authorization = await vapidAuthorization(
    sub.endpoint,
    cfg.vapid_public,
    cfg.vapid_private,
    cfg.vapid_subject,
  );
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
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

Deno.serve(async (req) => {
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

  const { data: dueRows, error: dueErr } = await supabase
    .from("reminders")
    .select("id, user_id, page_id, body")
    .lte("remind_at", new Date().toISOString())
    .eq("notified", false)
    .is("deleted_at", null)
    .order("remind_at", { ascending: true })
    .limit(200);
  if (dueErr) {
    console.error("due query failed", dueErr);
    return new Response("Query failed", { status: 500 });
  }

  const due = (dueRows ?? []) as DueReminder[];
  const pending = await supabase.from("notifications").select("id,user_id,page_id,kind,payload").is("pushed_at", null).in("kind", ["input_required", "ready_for_review", "task_failed", "approval_requested"]).order("created_at", { ascending: true }).limit(200);
  if (pending.error && pending.error.code !== "42P01" && pending.error.code !== "PGRST205") return new Response("Query failed", { status: 500 });
  for (const notification of pending.data ?? []) due.push({ id: "notification:" + notification.id, user_id: notification.user_id, page_id: notification.page_id, body: notification.payload?.body || notification.payload?.message || notification.kind.replace(/_/g, " ") });
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
  const deliveredIds: string[] = [];
  const statuses: Record<string, number> = {};
  let sent = 0;

  for (const reminder of due) {
    const subs = byUser.get(reminder.user_id);
    // No push subscription for this user: leave `notified` false so the
    // in-app checker still fires the toast next time the app is open.
    if (!subs?.length) continue;

    const payload = JSON.stringify({
      id: reminder.id,
      title: "Reminder",
      body: reminder.body || "Reminder",
      url: reminder.page_id ? `/p/${reminder.page_id}` : "/",
    });

    let anyDelivered = false;
    for (const sub of subs) {
      if (expired.has(sub.endpoint)) continue;
      let status: number;
      try {
        status = await sendPush(sub, payload, cfg);
      } catch (e) {
        console.error("push send threw", sub.endpoint, e);
        continue;
      }
      statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
      if (status === 404 || status === 410) {
        expired.add(sub.endpoint);
      } else if (status >= 200 && status < 300) {
        anyDelivered = true;
        sent++;
      } else {
        console.error("push rejected", status, sub.endpoint);
      }
    }
    if (anyDelivered) deliveredIds.push(reminder.id);
  }

  const notificationIds = deliveredIds.filter((id) => id.startsWith("notification:")).map((id) => id.slice(13));
  const reminderIds = deliveredIds.filter((id) => !id.startsWith("notification:"));
  if (notificationIds.length) await supabase.from("notifications").update({ pushed_at: new Date().toISOString() }).in("id", notificationIds);
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
});
