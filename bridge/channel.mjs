// The `claude/channel` side of the bridge: learns that one of the agent's
// tasks changed and turns it into a one-line channel event for Claude Code.
//
// Primary source: Supabase Realtime `postgres_changes` INSERT on
// `public.agent_events` filtered to this agent (channel `agent-<agent_id>`).
// Fallback when Realtime is unavailable or drops: a local loop of the remote
// tool `wait_for_my_tasks`, which keeps a cursor so nothing is lost.

import { eventToChannel, taskToChannel } from "../agent/taskEvent.mjs";

export { eventToChannel, oneLine, sanitizeMeta, taskToChannel, untrustedText } from "../agent/taskEvent.mjs";

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
  const acknowledging = new Map();
  const acknowledge = (id, after) => {
    if (acknowledging.has(id)) return acknowledging.get(id);
    // Realtime supplies the event UUID directly; this is the same opaque acknowledgement envelope as polling.
    after ??= btoa(JSON.stringify({ t: "1970-01-01T00:00:00Z", k: [], a: [id] })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const pending = remote.callTool("wait_for_my_tasks", { after, timeout_s: 0 }).finally(() => acknowledging.delete(id));
    acknowledging.set(id, pending);
    return pending;
  };

  /** @param {any} event */
  function handleEvent(event) {
    if (!event || event.agent_id !== agentId) return;            // another agent's event: ignore
    try {
      if (!event.event_id || !seenEvents.has(event.event_id)) {
        emit(eventToChannel(event));
        if (event.event_id) seenEvents.add(event.event_id);
      }
    } catch (error) {
      log(`channel: delivery failed (${error.message})`);
      fallBack("delivery failed");
      return;
    }
    if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value);
    const payload = event.payload ?? {};
    if (event.event_id && ((event.type === "task.continue" && payload.review_of) ||
        (event.type === "task.updated" && ["verdict", "minor_findings", "environment_release", "review_timeout"].some(key => key in payload)))) {
      void acknowledge(event.event_id).catch(error => {
        log(`channel: notice acknowledgement failed (${error.message})`);
        fallBack("notice acknowledgement failed");
      });
    }
  }

  /** @param {any} task */
  async function handleTask(task) {
    if (!task?.task_id) return;
    if (task.notice?.event_id) {
      if (!seenEvents.has(task.notice.event_id)) {
        emit(taskToChannel(task));
        seenEvents.add(task.notice.event_id);
      }
      if (task.notice.ack_cursor) await acknowledge(task.notice.event_id, task.notice.ack_cursor);
      return;
    }
    const signature = [task.reason, task.state, task.review_state, task.brief_version, task.pending_prompts, task.notice?.event_id].join("|");
    if (lastTaskSignature.get(task.task_id) === signature) return;
    emit(taskToChannel(task));
    lastTaskSignature.set(task.task_id, signature);
    if (task.notice?.event_id) seenEvents.add(task.notice.event_id);
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
        for (const task of result?.tasks ?? []) await handleTask(task);
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
