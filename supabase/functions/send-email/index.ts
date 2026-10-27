import { createClient } from "jsr:@supabase/supabase-js@2";
const encoder = new TextEncoder();
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function equal(a: string, b: string): boolean { const x = encoder.encode(a), y = encoder.encode(b); let diff = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0); return diff === 0; }
async function verifyHook(req: Request, raw: string, secrets: string): Promise<boolean> {
  const id = req.headers.get("webhook-id"), timestamp = req.headers.get("webhook-timestamp"), signatures = req.headers.get("webhook-signature") ?? "";
  if (!id || !timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  for (const value of secrets.split("|")) {
    const secret = value.replace(/^v1,/, "").replace(/^whsec_/, ""); if (!secret) continue;
    try { const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(id + "." + timestamp + "." + raw))); const signature = btoa(String.fromCharCode(...bytes)); if (signatures.split(" ").some((candidate) => candidate.startsWith("v1,") && equal(candidate.slice(3), signature))) return true; } catch {}
  }
  return false;
}
function serviceKey(): string { const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (direct) return direct; try { const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return keys.default ?? Object.values(keys)[0] ?? ""; } catch { return ""; } }
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey(), { auth: { persistSession: false } });
  const config = await sb.rpc("email_config"), cfg = config.data;
  if (config.error || !cfg?.resend_api_key || !cfg?.email_from || !cfg?.app_url) return new Response("Server misconfigured", { status: 500 });
  const raw = await req.text(); let input; try { input = JSON.parse(raw); } catch { return new Response("Invalid request", { status: 400 }); }
  let to: string, title: string, text: string, url: string, key: string;
  try {
    if (input.invitation_id) {
      if (!cfg.cron_secret || !equal(req.headers.get("x-push-secret") ?? "", cfg.cron_secret)) return new Response("Unauthorized", { status: 401 });
      const { data: invitation, error } = await sb.from("workspace_invitations").select("email,workspace_id,invited_by,token_hash,expires_at,accepted_at").eq("id", input.invitation_id).maybeSingle();
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(input.token ?? ""))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (error || !invitation || invitation.accepted_at || Date.parse(invitation.expires_at) <= Date.now() || !equal(digest, invitation.token_hash)) return new Response("Invalid invitation", { status: 400 });
      const [workspace, inviter] = await Promise.all([sb.from("workspaces").select("name").eq("id", invitation.workspace_id).single(), sb.auth.admin.getUserById(invitation.invited_by)]);
      const name = inviter.data.user?.user_metadata?.full_name || inviter.data.user?.email || "Someone";
      to = invitation.email; title = "Invitation to " + (workspace.data?.name || "colabora.si"); text = name + " invited you to " + (workspace.data?.name || "a workspace") + " on colabora.si."; url = new URL("/?invite=" + encodeURIComponent(input.token), cfg.app_url).href; key = "invitation/" + input.invitation_id;
    } else {
      if (!(await verifyHook(req, raw, cfg.send_email_hook_secret || Deno.env.get("SEND_EMAIL_HOOK_SECRET") || ""))) return new Response("Unauthorized", { status: 401 });
      const data = input.email_data, kind = data?.email_action_type;
      if (!input.user?.email || !data?.token_hash || !["signup", "invite", "magiclink", "recovery"].includes(kind)) return new Response("Unsupported email action", { status: 400 });
      to = input.user.email; title = kind === "recovery" ? "Reset your password" : kind === "invite" ? "You are invited to colabora.si" : "Sign in to colabora.si"; text = title + ". Use the link below to continue.";
      const verify = new URL("/auth/v1/verify", cfg.project_url || Deno.env.get("SUPABASE_URL")); verify.searchParams.set("token", data.token_hash); verify.searchParams.set("type", kind);
      let redirect = cfg.app_url; if (data.redirect_to && new URL(data.redirect_to).origin === new URL(cfg.app_url).origin) redirect = data.redirect_to;
      verify.searchParams.set("redirect_to", redirect); url = verify.href; key = "auth/" + req.headers.get("webhook-id");
    }
    const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + cfg.resend_api_key, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ from: cfg.email_from, to: [to], subject: title, text: text + "\n\n" + url, html: "<p>" + escapeHtml(text) + '</p><p><a href="' + escapeHtml(url) + '">Continue to colabora.si</a></p>' }) });
    await response.arrayBuffer(); if (!response.ok) return new Response("Email delivery failed", { status: 502 });
    return Response.json({});
  } catch { return new Response("Email delivery failed", { status: 500 }); }
});
