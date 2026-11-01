// Sends a Supabase invitation to each row the owner marked Invite in Notion. Sign-up stays closed: this is the only way
// an address gets an account without the owner creating it by hand. A row leaves the query when it gets a date or an
// error, so a refusal is not repeated until the owner clears it; only a failure that may pass waits for the next minute.
// The log carries status codes, never an address.
import { jsonResponse } from '../_shared/errors.ts';
import { timingSafeEqual } from '../_shared/hmac.ts';
import { NotionError } from './notion.ts';

const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ALREADY_REGISTERED = new Set(['email_exists', 'user_already_exists']);
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

export interface InviteRow { id: string; email: string }
/** What Auth answered when the invitation did not leave. */
export interface InviteFailure { status?: number; code?: string }
export interface InvitesList {
  pending(): Promise<InviteRow[]>;
  markInvited(pageId: string, at: Date): Promise<void>;
  markError(pageId: string, message: string): Promise<void>;
}
export interface InvitesDeps {
  secret: string;
  /** Absent without the Notion secrets or the app URL. */
  list?: InvitesList;
  /** Resolves to null when the invitation left. */
  invite(email: string): Promise<InviteFailure | null>;
  now(): Date;
}

type Verdict = 'invited' | 'already' | 'failed' | 'retry' | 'stop';

const status = (e: unknown) => e instanceof NotionError ? e.status : 'unreachable';

async function record(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (e) {
    console.error('waitlist invites: notion update failed:', status(e));
  }
}

function invalid(email: string): boolean {
  return email.length > MAX_EMAIL || !EMAIL.test(email);
}

async function inviteRow(row: InviteRow, list: InvitesList, deps: InvitesDeps): Promise<Verdict> {
  const email = row.email.trim().toLowerCase();
  if (invalid(email)) {
    await record(() => list.markError(row.id, 'Not a valid email'));
    return 'failed';
  }
  let failure: InviteFailure | null;
  try {
    failure = await deps.invite(email);
  } catch {
    return 'retry';
  }
  if (!failure) {
    await record(() => list.markInvited(row.id, deps.now()));
    return 'invited';
  }
  const { status: code, code: reason } = failure;
  if (reason && ALREADY_REGISTERED.has(reason)) {
    await record(() => list.markError(row.id, 'Already has an account'));
    return 'already';
  }
  if (code === 429) return 'stop';
  if (!code || code >= 500) return 'retry';
  const detail = reason && SAFE_CODE.test(reason) ? reason : code;
  await record(() => list.markError(row.id, `Could not send the invite (${detail})`));
  return 'failed';
}

export async function handleWaitlistInvites(req: Request, deps: InvitesDeps): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
  const supplied = req.headers.get('x-dispatch-secret') ?? '';
  if (!deps.secret || supplied.length > 256 || !timingSafeEqual(supplied, deps.secret)) return jsonResponse(401, { error: 'unauthorized' });
  const { list } = deps;
  if (!list) return jsonResponse(200, { skipped: true });

  const counts = { invited: 0, already: 0, failed: 0, retry: 0 };
  let rows: InviteRow[];
  try {
    rows = await list.pending();
  } catch (e) {
    console.error('waitlist invites: notion query failed:', status(e));
    return jsonResponse(200, { ...counts, list_failed: true });
  }
  for (const row of rows) {
    const verdict = await inviteRow(row, list, deps);
    if (verdict === 'stop') {
      counts.retry++;
      break;
    }
    counts[verdict]++;
  }
  return jsonResponse(200, counts);
}
