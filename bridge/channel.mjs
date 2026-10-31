// The `claude/channel` side of the bridge: learns that one of the agent's
// tasks changed and turns it into a one-line channel event for Claude Code.
//
// Primary source: Supabase Realtime `postgres_changes` INSERT on
// `public.agent_events` filtered to this agent (channel `agent-<agent_id>`).
// Fallback when Realtime is unavailable or drops: a local loop of the remote
// tool `wait_for_my_tasks`, which keeps a cursor so nothing is lost.

const META_KEY = /^[A-Za-z0-9_]+$/;
// Meta values are ids, enums and short refs: anything else is dropped rather than injected into the tag.
const META_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_CONTENT = 300;

/**
 * Free text that came from the workspace (titles, summaries, feedback) is data
 * for the session, never markup or instructions: strip the characters that
 * could close or open a tag and flatten it.
 * @param {unknown} value
 */
export function untrustedText(value) {
  return String(value ?? "").replace(/[<>"&`]/g, " ").replace(/\s+/g, " ").trim();
}

/** Reason reported to the session for each `agent_events.type`. */
const REASON_BY_TYPE = /** @type {Record<string, string>} */ ({
  "task.start": "queued",
  "task.continue": "continue",
  "task.feedback": "feedback",
  "task.stop": "stop",
  "approval.decided": "approval_decided",
  "brief.updated": "brief",
  "task.updated": "updated",
});

/**
 * Keeps only meta keys made of letters, digits and underscores, with string
 * values (numbers and booleans are stringified; anything else is dropped).
 * @param {Record<string, unknown>} meta
 * @returns {Record<string, string>}
 */
export function sanitizeMeta(meta) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!META_KEY.test(key)) continue;
    const text = typeof value === "number" || typeof value === "boolean" ? String(value) : value;
    if (typeof text === "string" && META_VALUE.test(text)) out[key] = text;
  }
  return out;
}

/** @param {string} text */
export function oneLine(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_CONTENT ? `${flat.slice(0, MAX_CONTENT - 1)}…` : flat;
}

/**
 * Converts an `agent_events` row into a channel event.
 * @param {{ type: string, task_id: string, run_id?: string | null, agent_id?: string, payload?: any, event_id?: string }} event
 * @returns {{ content: string, meta: Record<string, string> }}
 */
export function eventToChannel(event) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  // Only the delivery notification to the Lead redirects from parent to child.
  // A reviewer's start must claim its review task; a verdict updates the parent.
  const reviewOf = event.type === "task.continue" && typeof payload.review_of === "string" ? payload.review_of : null;
  // A decision with no run waiting for it was taken after a handover: the session claims the task, it has no run to continue.
  const handover = payload.handover === true || (event.type === "approval.decided" && event.run_id == null);
  const reason = handover ? "handover" : reviewOf && payload.review_task_id ? "under_review" : reviewOf ? "ready_for_review" : (REASON_BY_TYPE[event.type] ?? event.type.replace(/\W+/g, "_"));
  const taskId = reviewOf ?? event.task_id;
  const ref = payload.task_ref ?? payload.review_of_ref;
  const label = typeof ref === "string" && META_VALUE.test(ref) ? ref : taskId;
  const decision = typeof payload.decision === "string" && META_VALUE.test(payload.decision) ? `decision ${payload.decision}` : null;
  const artifacts = Array.isArray(payload.artifact_ids) ? `${payload.artifact_ids.length} artifact(s)` : null;
  const free = untrustedText(payload.summary ?? payload.text ?? payload.title ?? "");
  // Free text from the workspace is quoted as data; the session reads the task itself before acting.
  const detail = free ? `untrusted text: "${free}"` : (decision ?? artifacts);
  const environment = Array.isArray(payload.environment_release) && payload.environment_release.length
    ? `; environment_release (untrusted text): "${untrustedText(payload.environment_release.map((item) => `${item?.kind}: ${item?.value}`).join(", "))}"` : "";
  const minors = Array.isArray(payload.minor_findings) && payload.minor_findings.length ? `; ${payload.minor_findings.length} minor finding(s)` : "";
  const subtask = typeof payload.subtask_id === "string" && META_VALUE.test(payload.subtask_id) ? payload.subtask_id : null;
  const subject = typeof payload.review_of === "string" && META_VALUE.test(payload.review_of) ? payload.review_of : null;
  const verdict = typeof payload.verdict === "string" && META_VALUE.test(payload.verdict) ? payload.verdict : null;
  const prefix = environment && subtask ? `${subtask} environment_release; get_task(${subtask}) has the full environment`
    : verdict && subject ? `${subject} ${verdict}; get_task(${subject}) has the full review` : `${label} ${reason}`;
  const content = oneLine(`${prefix}${minors}${environment}${detail ? `: ${detail}` : ""}`);
  return {
    content,
    meta: sanitizeMeta({
      task_id: taskId,
      parent_task_id: reviewOf ? event.task_id : undefined,
      subtask_id: subtask ?? undefined,
      review_of: verdict ? subject ?? undefined : undefined,
      verdict: verdict ?? undefined,
      run_id: event.run_id ?? undefined,
      reason,
      state: payload.state,
      event_id: event.event_id,
    }),
  };
}

/**
 * Converts one task of a `wait_for_my_tasks` answer into a channel event.
 * @param {{ task_id: string, title?: string, state?: string, reason?: string, pending_prompts?: number, active_run_id?: string }} task
 */
export function taskToChannel(task) {
  const reason = typeof task.reason === "string" && META_VALUE.test(task.reason) ? task.reason : "changed";
  const cleanTitle = untrustedText(task.title);
  const title = cleanTitle ? ` "${cleanTitle}"` : "";
  const prompts = task.pending_prompts ? ` (${task.pending_prompts} pending message(s))` : "";
  return {
    content: oneLine(`${task.task_id}${title} ${reason}${task.state ? `, state ${task.state}` : ""}${prompts}`),
    meta: sanitizeMeta({ task_id: task.task_id, run_id: task.active_run_id, reason, state: task.state }),
  };
}

/**
 * @typedef {{ content: string, meta: Record<string, string> }} ChannelEvent
 * @typedef {{ callTool: (name: string, args: Record<string, unknown>) => Promise<any> }} ToolCaller
 * @typedef {(opts: { supabaseUrl: string, jwt: string }) => any} RealtimeFactory
 */

/**
 * @param {{
 *   agentId: string,
 *   supabaseUrl?: string,
 *   jwt?: string,
 *   remote: ToolCaller,
 *   emit: (event: ChannelEvent) => void,
 *   realtimeFactory?: RealtimeFactory | null,
 *   log?: (message: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollTimeoutS?: number,
 * }} options
 */
export function createChannel(options) {
  const { agentId, remote, emit } = options;
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollTimeoutS = options.pollTimeoutS ?? 120;

  let stopped = false;
  let polling = false;
  let live = false;
  /** @type {string | undefined} */ let cursor;
  /** @type {any} */ let client = null;
  /** @type {any} */ let subscription = null;
  /** @type {Set<string>} */ const seenEvents = new Set();
  /** @type {Map<string, string>} */ const lastTaskSignature = new Map();

  /** @param {any} event */
  function handleEvent(event) {
    if (!event || event.agent_id !== agentId) return;            // another agent's event: ignore
    if (event.event_id) {
      if (seenEvents.has(event.event_id)) return;
      seenEvents.add(event.event_id);
      if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value);
    }
    emit(eventToChannel(event));
  }

  /** @param {any} task */
  function handleTask(task) {
    if (!task?.task_id) return;
    const signature = [task.reason, task.state, task.review_state, task.brief_version, task.pending_prompts].join("|");
    if (lastTaskSignature.get(task.task_id) === signature) return;
    lastTaskSignature.set(task.task_id, signature);
    emit(taskToChannel(task));
  }

  async function pollLoop() {
    if (polling || stopped) return;
    polling = true;
    log("channel: waiting with wait_for_my_tasks");
    let failures = 0;
    while (!stopped && !live) {                                   // ends if Realtime reconnects
      try {
        /** @type {Record<string, unknown>} */
        const args = { timeout_s: pollTimeoutS };
        if (cursor) args.after = cursor;
        const result = await remote.callTool("wait_for_my_tasks", args);
        if (stopped) break;
        for (const task of result?.tasks ?? []) handleTask(task);
        if (typeof result?.next_cursor === "string") cursor = result.next_cursor;
        failures = 0;
      } catch (error) {
        if (stopped) break;
        failures++;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
        log(`channel: wait_for_my_tasks failed (${error instanceof Error ? error.message : String(error)}); retrying in ${delay} ms`);
        await sleep(delay);
      }
    }
    polling = false;
  }

  /** @param {string} reason */
  function fallBack(reason) {
    if (stopped) return;
    if (live) log(`channel: realtime ${reason}`);
    live = false;
    void pollLoop();
  }

  async function start() {
    if (!options.realtimeFactory || !options.supabaseUrl || !options.jwt) {
      fallBack("not configured");
      return;
    }
    try {
      client = await options.realtimeFactory({ supabaseUrl: options.supabaseUrl, jwt: options.jwt });
      subscription = client
        .channel(`agent-${agentId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "agent_events", filter: `agent_id=eq.${agentId}` },
          (/** @type {any} */ change) => handleEvent(change?.new),
        )
        .subscribe((/** @type {string} */ status, /** @type {any} */ error) => {
          if (stopped) return;
          if (status === "SUBSCRIBED") {
            live = true;
            log(`channel: realtime subscribed to agent-${agentId}`);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            fallBack(`${status}${error ? ` (${error.message ?? error})` : ""}`);
          }
        });
    } catch (error) {
      log(`channel: realtime unavailable (${error instanceof Error ? error.message : String(error)})`);
      fallBack("unavailable");
    }
  }

  return {
    start,
    handleEvent,
    /** New JWT after a token exchange. @param {string} token */
    setAuth(token) {
      try { client?.realtime?.setAuth?.(token); } catch { /* the poll loop uses the remote's own token */ }
    },
    stop() {
      stopped = true;
      try { if (subscription && client?.removeChannel) void client.removeChannel(subscription); } catch { /* closing */ }
    },
    get mode() { return live ? "realtime" : polling ? "poll" : "idle"; },
    get cursor() { return cursor; },
  };
}
