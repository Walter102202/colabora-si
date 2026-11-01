import { useState, type FormEvent } from "react";
import { emailProblem, LOGIN_UNREACHABLE } from "@/lib/landingAccess";

export function AccountLinkForm({ initialEmail = "", invite = null }: { initialEmail?: string; invite?: string | null }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problem = emailProblem(email);
    if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try {
      const backend = import.meta.env.VITE_SUPABASE_URL;
      if (!backend) throw new Error();
      const response = await fetch(`${backend.replace(/\/+$/, "")}/functions/v1/account-link`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim(), invite }),
      });
      if (!response.ok) throw new Error();
      setSent(true);
    } catch { setError(LOGIN_UNREACHABLE); }
    finally { setBusy(false); }
  }
  if (sent) return <p className="cs-solo__p" role="status">If that email has an account, we sent a link.</p>;
  return <form onSubmit={(event) => void send(event)} noValidate>
    <div className="cs-field"><label htmlFor="cs-link-email">Email</label><input id="cs-link-email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></div>
    <p className="cs-err" role="alert">{error}</p>
    <button className="cs-primary" type="submit" disabled={busy}>{busy ? "Sending…" : "Send me a new link"}</button>
  </form>;
}
