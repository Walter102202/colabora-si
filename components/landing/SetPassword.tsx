import { useEffect, useRef, useState, type FormEvent } from "react";
import { LOGIN_UNREACHABLE } from "@/lib/landingAccess";
import { HOME_URL, LANDING_LOGIN_URL, LANDING_URL } from "@/lib/routes";
import { SET_PASSWORD_MIN, parseInviteLink, passwordProblem, submitPassword } from "@/lib/setPassword";
import { TramaImage } from "./TramaImage";
import "./landing.css";

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="landing cs-solo">
      <main className="cs-solo__sheet">
        {children}
        <footer className="cs-solo__foot">
          <a href={LANDING_URL} className="cs-wordmark">colabora<span>.si</span></a>
          <TramaImage px={64} />
        </footer>
      </main>
    </div>
  );
}

function Expired() {
  return (
    <Page>
      <h1 className="cs-solo__t">This link has expired.</h1>
      <p className="cs-solo__p">Write to <a className="cs-solo__a" href="mailto:hello@colabora.si">hello@colabora.si</a> and we’ll send you a new one.</p>
      <p className="cs-solo__note">Already set your password? <a className="cs-solo__a" href={LANDING_LOGIN_URL}>Log in</a></p>
    </Page>
  );
}

export default function SetPassword() {
  const [link] = useState(() => parseInviteLink(location.search, location.hash));
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const verified = useRef(false);
  const field = useRef<HTMLInputElement>(null);

  // The only thing to do on this page is to type in this field.
  useEffect(() => { field.current?.focus(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !link) return;
    const problem = passwordProblem(password);
    if (problem) { setError(problem); return; }
    setError("");
    setBusy(true);
    try {
      const { getSupabase } = await import("@/lib/supabase");
      const supabase = getSupabase();
      if (!supabase) { setError(LOGIN_UNREACHABLE); return; }
      const result = await submitPassword(supabase.auth, link.tokenHash, password, verified.current);
      if (result.kind === "done") { location.assign(HOME_URL); return; }
      if (result.kind === "expired") { setExpired(true); return; }
      verified.current = result.verified;
      setError(result.message);
    } catch {
      setError(LOGIN_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }

  if (!link || expired) return <Expired />;
  return (
    <Page>
      <h1 className="cs-solo__t">Set your password.</h1>
      <form onSubmit={(event) => void save(event)} noValidate>
        {link.email && <div className="cs-field"><label htmlFor="cs-sp-email">Email</label><input id="cs-sp-email" type="email" autoComplete="username" value={link.email} readOnly /></div>}
        <div className="cs-field">
          <label htmlFor="cs-sp-pass">Password</label>
          <input ref={field} id="cs-sp-pass" type="password" autoComplete="new-password" minLength={SET_PASSWORD_MIN} aria-describedby="cs-sp-error" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <p className="cs-err" id="cs-sp-error" role="alert">{error}</p>
        <button className="cs-primary" type="submit" disabled={busy}>{busy ? "Getting started…" : "Get started"}</button>
      </form>
    </Page>
  );
}
