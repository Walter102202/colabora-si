// The page an invitation opens. Nothing runs when it loads: the token is spent only when the person submits, so a mail
// scanner opening the link spends nothing and closing the page leaves the link usable.
import { LOGIN_UNREACHABLE, TOO_MANY_TRIES } from "@/lib/landingAccess";

export const SET_PASSWORD_MIN = 8;

export interface InviteLink {
  tokenHash: string;
  email: string;
}

interface AuthProblem {
  name?: string;
  status?: number;
  code?: string;
}

export interface PasswordAuth {
  verifyOtp(params: { token_hash: string; type: "invite" }): Promise<{ error: AuthProblem | null }>;
  updateUser(attrs: { password: string }): Promise<{ error: AuthProblem | null }>;
}

export type SubmitResult =
  | { kind: "done" }
  | { kind: "expired" }
  | { kind: "problem"; message: string; verified: boolean };

function fragmentEmail(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

export function parseInviteLink(search: string, hash: string): InviteLink | null {
  const query = new URLSearchParams(search);
  const tokenHash = query.get("token_hash");
  if (!tokenHash || query.get("type") !== "invite") return null;
  return { tokenHash, email: fragmentEmail(hash) };
}

export function passwordProblem(password: string): string {
  return password.length < SET_PASSWORD_MIN ? `Use at least ${SET_PASSWORD_MIN} characters.` : "";
}

function retryable(error: AuthProblem): string {
  return error.status === 429 ? TOO_MANY_TRIES : LOGIN_UNREACHABLE;
}

function unreachable({ name, status = 0 }: AuthProblem): boolean {
  return name === "AuthRetryableFetchError" || status === 0 || status === 429 || status >= 500;
}

// `verified` survives a refused password: the token is already spent and the session it opened is the one that may set it.
export async function submitPassword(auth: PasswordAuth, tokenHash: string, password: string, verified: boolean): Promise<SubmitResult> {
  if (!verified) {
    const { error } = await auth.verifyOtp({ token_hash: tokenHash, type: "invite" });
    if (error) return unreachable(error) ? { kind: "problem", message: retryable(error), verified: false } : { kind: "expired" };
  }
  const { error } = await auth.updateUser({ password });
  if (!error) return { kind: "done" };
  return { kind: "problem", message: unreachable(error) ? retryable(error) : "Choose a stronger password.", verified: true };
}
