import { useRef, useState, type FormEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { emailProblem, joinWaitlist, TOO_MANY_TRIES, WAITLIST_FAILED } from "@/lib/landingAccess";

export function WaitlistForm({ emailRef, email, onEmail }: { emailRef: RefObject<HTMLInputElement | null>; email: string; onEmail: (email: string) => void }) {
  const [problem, setProblem] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const trap = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);

  async function join(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setTouched(true);
    const found = emailProblem(email);
    setProblem(found);
    if (found) { emailRef.current?.focus(); return; }
    setBusy(true);
    const result = await joinWaitlist(import.meta.env.VITE_SUPABASE_URL, email, trap.current?.value ?? "");
    setBusy(false);
    if (result === "joined") {
      flushSync(() => setJoined(true));
      confirmation.current?.focus({ preventScroll: true });
    } else {
      setProblem(result === "rate_limited" ? TOO_MANY_TRIES : WAITLIST_FAILED);
    }
  }

  if (joined) return <div className="cs-accepted cs-joined" ref={confirmation} tabIndex={-1} role="status"><strong>You’re on the list.</strong>We’ll write to you when your invite is ready.</div>;

  return (
    <>
      <form onSubmit={(event) => void join(event)} noValidate>
        <label htmlFor="cs-email">Email</label>
        <input ref={emailRef} id="cs-email" type="email" autoComplete="email" placeholder="you@company.com" aria-describedby="cs-email-err cs-waitlist-note" aria-invalid={problem ? true : undefined} value={email}
          onChange={(event) => { onEmail(event.target.value); if (touched) setProblem(emailProblem(event.target.value)); }}
          onBlur={() => { if (email.trim()) { setTouched(true); setProblem(emailProblem(email)); } }} />
        <button type="submit" className="cs-primary" disabled={busy}>{busy ? "Joining…" : "Join the waitlist →"}</button>
        <div className="cs-hp" aria-hidden="true"><label htmlFor="cs-hp">Leave this empty</label><input ref={trap} id="cs-hp" name="hp_field" tabIndex={-1} autoComplete="off" /></div>
      </form>
      <p className="cs-err" id="cs-email-err" role="alert">{problem}</p>
      <p className="cs-privacy" id="cs-waitlist-note">We use your email for your invite. We don’t sell it.</p>
    </>
  );
}
