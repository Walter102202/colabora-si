import { useState, type FormEvent, type RefObject } from "react";
import { LOGIN_MISMATCH, LOGIN_UNREACHABLE, loginProblem } from "@/lib/landingAccess";
import { HOME_URL } from "@/lib/routes";
import { LandingDialog } from "./LandingDialog";

export function LoginDialog({ dialogRef, emailRef, onWaitlist }: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  emailRef: RefObject<HTMLInputElement | null>;
  onWaitlist: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function logIn(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) { setError(LOGIN_MISMATCH); return; }
    setError("");
    setBusy(true);
    try {
      // The client loads on submit, so it stays out of the landing's first download.
      const { getSupabase } = await import("@/lib/supabase");
      const supabase = getSupabase();
      if (!supabase) { setError(LOGIN_UNREACHABLE); return; }
      const { error: failure } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (failure) { setError(loginProblem(failure)); return; }
      location.assign(HOME_URL);
    } catch {
      setError(LOGIN_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <LandingDialog dialogRef={dialogRef} className="cs-dlg" bodyClassName="cs-dlg__in" labelledBy="cs-login-t">
      <h2 className="cs-dlg__t" id="cs-login-t">Log in</h2>
      <form onSubmit={(event) => void logIn(event)} noValidate>
        <div className="cs-field"><label htmlFor="cs-li-email">Email</label><input ref={emailRef} id="cs-li-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></div>
        <div className="cs-field"><label htmlFor="cs-li-pass">Password</label><input id="cs-li-pass" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
        <p className="cs-err" role="alert">{error}</p>
        <button className="cs-primary" type="submit" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
      </form>
      <p className="cs-alt">No invite yet? <button className="cs-linkbtn" type="button" onClick={() => { dialogRef.current?.close(); onWaitlist(email.trim()); }}>Join the waitlist</button></p>
    </LandingDialog>
  );
}
