// The page an invitation opens. Nothing runs when it loads: the token is spent only when the person submits, so a mail
// scanner opening the link spends nothing and closing the page leaves the link usable.
import { LOGIN_UNREACHABLE, TOO_MANY_TRIES } from "@/lib/landingAccess";

export const SET_PASSWORD_MIN = 8;

export interface InviteLink {
  tokenHash: string;
  email: string;
  type: "invite" | "recovery";
  invite: string | null;
}

interface AuthProblem {
  name?: string;
  status?: number;
  code?: string;
}

export interface PasswordAuth {
  verifyOtp(params: { token_hash: string; type: "invite" | "recovery" }): Promise<{ error: AuthProblem | null }>;
  updateUser(attrs: { password: string }): Promise<{ error: AuthProblem | null }>;
  mfa?: {
    getAuthenticatorAssuranceLevel(): Promise<{ data: { currentLevel: string | null; nextLevel: string | null } | null; error: AuthProblem | null }>;
    listFactors(): Promise<{ data: { totp: { id: string; status: string }[] } | null; error: AuthProblem | null }>;
  };
}

export type SubmitResult =
  | { kind: "done" }
  | { kind: "expired" }
  | { kind: "mfa"; factorId: string }
  | { kind: "problem"; message: string; verified: boolean };

export function fragmentEmail(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

export function parseInviteLink(search: string, hash: string): InviteLink | null {
  const query = new URLSearchParams(search);
  const tokenHash = query.get("token_hash");
  const type = query.get("type");
  if (!tokenHash || (type !== "invite" && type !== "recovery")) return null;
  return { tokenHash, email: fragmentEmail(hash), type, invite: query.get("invite") };
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
export async function submitPassword(auth: PasswordAuth, tokenHash: string, password: string, verified: boolean, type: "invite" | "recovery" = "invite"): Promise<SubmitResult> {
  if (!verified) {
    const { error } = await auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) return unreachable(error) ? { kind: "problem", message: retryable(error), verified: false } : { kind: "expired" };
  }
  if (auth.mfa) {
    const { data, error } = await auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return { kind: "problem", message: retryable(error), verified: true };
    if (data?.nextLevel === "aal2" && data.currentLevel !== "aal2") {
      const factors = await auth.mfa.listFactors();
      const factor = factors.data?.totp.find((item) => item.status === "verified");
      if (factor) return { kind: "mfa", factorId: factor.id };
      return { kind: "problem", message: "Two-factor authentication is required to change your password.", verified: true };
    }
  }
  const { error } = await auth.updateUser({ password });
  if (!error) return { kind: "done" };
  const message = error.code === "insufficient_aal" ? "Two-factor authentication is required to change your password." : error.code === "same_password" ? "Choose a password different from your current one." : unreachable(error) ? retryable(error) : "Choose a stronger password.";
  return { kind: "problem", message, verified: true };
}
