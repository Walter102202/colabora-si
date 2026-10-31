// Beta access from the landing: the waitlist request and the words each outcome shows.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const LOGIN_MISMATCH = "That email and password don’t match.";
export const LOGIN_UNREACHABLE = "We couldn’t reach the server. Check your connection and try again.";
export const TOO_MANY_TRIES = "Too many tries. Wait a while and try again.";
export const WAITLIST_FAILED = "We couldn’t save your email. Please try again.";

export type WaitlistResult = "joined" | "rate_limited" | "failed";

export function emailProblem(value: string): string {
  const email = value.trim();
  if (!email) return "Enter your email so we can send your invite.";
  return EMAIL.test(email) ? "" : "Check your email. It should look like name@company.com.";
}

export async function joinWaitlist(backendUrl: string | undefined, email: string, company: string, send: typeof fetch = fetch): Promise<WaitlistResult> {
  if (!backendUrl) return "failed";
  try {
    const res = await send(`${backendUrl.replace(/\/+$/, "")}/functions/v1/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), company }),
    });
    if (res.ok) return "joined";
    return res.status === 429 ? "rate_limited" : "failed";
  } catch {
    return "failed";
  }
}

// supabase-js reports an unreachable server as a retryable error with status 0 or 5xx.
export function loginProblem(error: { name?: string; status?: number }): string {
  const status = error.status ?? 0;
  if (status === 429) return TOO_MANY_TRIES;
  if (error.name === "AuthRetryableFetchError" || status === 0 || status >= 500) return LOGIN_UNREACHABLE;
  return LOGIN_MISMATCH;
}
