import { Input } from "@/components/FormControls";
import { useState } from "react";
import { LogOut, MailCheck } from "lucide-react";
import Modal from "@/components/Modal";
import { signOut, useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

type Mode = "signin" | "signup" | "magic";
const TITLE = { signin: "Log in", signup: "Create an account", magic: "Magic link" };
const SUBMIT_LABEL = { signin: "Sign in", signup: "Create account", magic: "Send magic link" };
const ALT_MODES: Record<Mode, [Mode, string][]> = {
  signin: [["signup", "Create an account"], ["magic", "Email me a magic link"]],
  signup: [["signin", "I already have an account"], ["magic", "Email me a magic link"]],
  magic: [["signin", "Log in with a password"], ["signup", "Create an account"]],
};
function friendlyAuthError(message: string, status?: number): string {
  const m = message.toLowerCase();
  if (status === 429 || m.includes("rate limit")) return "Too many attempts. Please wait a moment and try again.";
  if (m.includes("invalid login credentials")) return "Wrong email or password.";
  if (m.includes("email not confirmed")) return "Your email isn't confirmed yet — check your inbox for the confirmation link.";
  if (m.includes("user already registered")) return "An account with this email already exists. Try signing in instead.";
  if (m.includes("password should be")) return message;
  if (m.includes("unable to validate email") || m.includes("invalid email")) return "That doesn't look like a valid email address.";
  if (m.includes("signups not allowed")) return "Sign-ups are currently disabled.";
  if (m.includes("failed to fetch") || m.includes("network")) return "Network error — check your connection and try again.";
  return message;
}
export default function AuthModal({ onClose }: { onClose: () => void }) {
  const { user, loading } = useAuth(), supabase = getSupabase();
  const [mode, setMode] = useState<Mode>("signin"), [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [emailSent, setEmailSent] = useState<"confirm" | "magic" | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!supabase || busy) return;
    setError(null); setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setError(friendlyAuthError(error.message, error.status)); else onClose();
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) setError(friendlyAuthError(error.message, error.status));
        else if (data.session) onClose();
        else if (data.user?.identities?.length === 0) setError("An account with this email already exists. Try signing in instead.");
        else setEmailSent("confirm");
      } else {
        const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
        if (error) setError(friendlyAuthError(error.message, error.status)); else setEmailSent("magic");
      }
    } catch { setError("Something went wrong. Please try again."); }
    finally { setBusy(false); }
  };
  return <div className="auth-modal"><Modal title={!supabase || user ? "Account" : emailSent ? "Check your email" : TITLE[mode]} onClose={onClose}>
    <div className="space-y-4 p-6"><span className="workspace-avatar h-8 w-8 rounded-lg text-white">C</span>
      {!supabase ? <p className="text-sm text-text-secondary">Sync isn&apos;t configured for this build. The app keeps working fully offline — everything is stored in your browser.</p>
        : user ? <><div className="flex items-center gap-3"><span className="workspace-avatar h-9 w-9">{(user.email ?? "U")[0].toUpperCase()}</span><span className="truncate text-sm">{user.email}</span></div><p className="text-xs text-text-tertiary">Signed in — your workspace syncs to the cloud.</p><button className="action-button w-full justify-center" disabled={busy} onClick={async () => { setBusy(true); try { await signOut(); onClose(); } catch { setError("Could not log out. Please try again."); } finally { setBusy(false); } }}><LogOut size={16} />Log out</button></>
        : emailSent ? <div className="space-y-4 text-center"><MailCheck size={28} className="mx-auto text-accent" /><p className="text-sm text-text-secondary">{emailSent === "confirm" ? `We sent a confirmation link to ${email}. Click it to finish creating your account, then come back and sign in.` : `We sent a magic sign-in link to ${email}. Click it to log in here.`}</p><button className="text-sm text-accent" onClick={() => setEmailSent(null)}>Back</button></div>
        : <><p className="text-xs text-text-tertiary">Logging in syncs your workspace across devices. Without an account everything stays on this device.</p><form className="space-y-3" onSubmit={submit}><Input label="Email" className="auth-input" type="email" required focusOnMount placeholder="Email" aria-label="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />{mode !== "magic" && <Input label="Password" className="auth-input" type="password" required minLength={6} placeholder="Password" aria-label="Password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} />}<button type="submit" className="action-button auth-submit w-full justify-center" disabled={busy || loading}>{busy ? "…" : SUBMIT_LABEL[mode]}</button></form><div className="flex flex-wrap justify-center gap-x-2 gap-y-1 text-xs text-accent">{ALT_MODES[mode].map(([next, label], i) => <span key={next}>{i > 0 && <span className="mr-2 text-text-tertiary">·</span>}<button onClick={() => { setMode(next); setError(null); setEmailSent(null); }}>{label}</button></span>)}</div></>}
      {error && <p role="alert" className="danger text-xs">{error}</p>}
    </div>
  </Modal></div>;
}
