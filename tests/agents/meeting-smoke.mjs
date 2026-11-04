#!/usr/bin/env node
// Local served-backend rehearsal. Set MEETING_STATUS_FILE to `supabase status -o json` output.
// Requires local Functions with META_API_BASE=http://host.docker.internal:61401 and key "stub".
// --keep-provider leaves the fake ASR available for a browser rehearsal after this check.
// --summarize-page=<id> uses that page's queued meeting request without starting another ASR server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createMcpClient } from "../../agent/mcpClient.mjs";
import { runRequest } from "../../agent/requests.mjs";
import { createStubModel } from "../../agent/test/stub-model.mjs";
import { startStubProvider } from "./voice-stub-provider.mjs";

const env = process.env, option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
if (!env.MEETING_STATUS_FILE) throw new Error("Set MEETING_STATUS_FILE to local Supabase status JSON.");
const status = JSON.parse(readFileSync(env.MEETING_STATUS_FILE, "utf8"));
const base = String(status.API_URL ?? "").replace(/\/$/, "");
function local(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("Only loopback HTTP endpoints are allowed.");
  return url;
}
local(base);
const localFetch = (url, init) => fetch(local(String(url)), { ...init, redirect: "error" });
const key = status.ANON_KEY;
if (!key) throw new Error("Local status has no anon key.");
const check = (condition, label) => { assert.ok(condition, label); console.log(`ok - ${label}`); };
const response = await localFetch(`${base}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { "Content-Type": "application/json", apikey: key },
  body: JSON.stringify({ email: env.SMOKE_EMAIL ?? "owner@demo.local", password: env.SMOKE_PASSWORD ?? "demo-password" }),
});
const session = await response.json();
check(response.ok && session.access_token, "local owner signs in");
const headers = { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${session.access_token}` };
async function rpc(name, args) {
  const res = await localFetch(`${base}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} (${body.code ?? "unknown"}/${body.message ?? "refused"})`);
  return body;
}
async function table(path) {
  const res = await localFetch(`${base}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`Local table read: HTTP ${res.status}`);
  return res.json();
}
const mcp = createMcpClient({ url: `${base}/functions/v1/mcp`, tokenUrl: `${base}/functions/v1/agent-token`, fetchImpl: localFetch,
  pat: env.PLATFORM_PAT ?? "agt_LOCALDEVCOLABORA000000000000000000000003", clientName: "meeting-local-smoke" });
async function tool(name, args) {
  const result = await mcp.callTool(name, args);
  if (result.isError) throw new Error(`${name}: ${result.data?.code ?? result.text}`);
  return result.data;
}
function wav(seconds) {
  const data = seconds * 32000, b = Buffer.alloc(44 + data);
  b.write("RIFF"); b.writeUInt32LE(36 + data, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(data, 40); return b;
}
const fixture = "We agree to ship the prototype. Alex will send the checklist tomorrow. The budget remains open.";
const browserPage = option("summarize-page");
let provider;
try {
  let pageId = browserPage, meetingId = option("meeting-id"), workspaceId;
  if (!browserPage) {
    provider = await startStubProvider({ port: Number(env.SMOKE_PROVIDER_PORT ?? 61401), defaultTranscript: fixture });
    const workspaces = await table("workspaces?select=id&order=created_at.asc&limit=1");
    workspaceId = workspaces[0]?.id;
    check(workspaceId, "local workspace exists");
    const page = await rpc("create_page", { p_input: { workspace_id: workspaceId, title: `Meeting smoke ${Date.now()}` }, p_idempotency_key: randomUUID() });
    pageId = page.id; meetingId = randomUUID();
    const block = (type, html, rest = {}) => ({ id: randomUUID(), type, html, indent: 0, ...rest });
    const initial = [block("meeting", "", { id: meetingId, meeting: { state: "stopped", elapsedMs: 180000 } }),
      block("heading2", "Notes", { key: `meeting:notes:${meetingId}` }), block("paragraph", "Focus on the prototype decision and checklist."),
      block("heading2", "Summary", { key: `meeting:summary:${meetingId}` }), block("heading2", "Transcript", { key: `meeting:transcript:${meetingId}` })];
    await rpc("apply_page_ops", { p_page_id: pageId, p_ops: initial.map((b, i) => ({ op: "insert_block", block: b, after: initial[i - 1]?.id ?? null })) });
    let after = initial.at(-1).id;
    const clipIds = [];
    for (let n = 0; n < 3; n++) {
      const query = new URLSearchParams({ channel: "meeting", workspace_id: workspaceId, chat_id: meetingId, session_id: meetingId, mode: "diarization", lang: "en" });
      const res = await localFetch(`${base}/functions/v1/voice-transcribe?${query}`, { method: "POST", headers: { ...headers, "Content-Type": "audio/wav" }, body: wav(60) });
      const heard = await res.json();
      check(res.ok && heard.duration_ms === 60000 && heard.turns?.length === 1, `segment ${n + 1} traverses real voice endpoint and fake ASR`);
      clipIds.push(heard.clip_id);
      const turns = heard.turns.map((turn) => block("paragraph", `<strong>${turn.speaker}</strong> [0${n}:00] ${turn.text}`, {
        turn: { meetingId, tMs: n * 60000 + turn.startMs, speaker: turn.speaker }, attr: { by: "human", id: session.user.id, at: Date.now() },
      }));
      await rpc("apply_page_ops", { p_page_id: pageId, p_ops: turns.map((b, i) => ({ op: "insert_block", block: b, after: turns[i - 1]?.id ?? after })) });
      after = turns.at(-1).id;
      const reloaded = await rpc("get_page_bundle", { p_page_id: pageId });
      check(reloaded.page.blocks.filter((b) => b.turn?.meetingId === meetingId).length === n + 1, `segment ${n + 1} survives a server reload`);
    }
    const clips = await table(`voice_clips?select=status,cost_usd,audio_ms&id=in.(${clipIds.join(",")})`);
    check(clips.length === 3 && clips.every((c) => c.status === "transcribed") && clips.reduce((sum, c) => sum + Number(c.audio_ms), 0) === 180000, "three logical minutes recorded");
    check(Math.abs(clips.reduce((sum, c) => sum + Number(c.cost_usd), 0) - .009) < 1e-8, "voice usage costs exactly $0.009 in local ledger");
  } else if (!meetingId) {
    const bundle = await rpc("get_page_bundle", { p_page_id: pageId });
    meetingId = bundle.page.blocks.find((b) => b.type === "meeting")?.id;
    check(meetingId, "browser meeting block found");
  }
  const queued = await table(`agent_tasks?select=id&row_page_id=eq.${encodeURIComponent(pageId)}&request_kind=eq.meeting&state=eq.queued`);
  const request = queued[0] ?? await rpc("request_meeting_summary", { p_page_id: pageId, p_block_id: meetingId, p_lang: "en" });
  const taskId = request.id ?? request.task_id;
  const claim = await tool("claim_task", { task_id: taskId, harness: "meeting-local-smoke" });
  check(claim.run_id, "platform agent claims meeting request");
  const source = await tool("get_ai_request", { task_id: taskId });
  check(source.kind === "meeting" && source.transcript.length >= 3, "runtime sees three transcript segments and meeting context");
  const evidence = source.transcript[0].t_ms;
  const answer = { summary: "The prototype is ready for the next step.", key_points: ["Prepare the prototype and checklist."],
    decisions: [{ text: "Ship the prototype", evidence: [evidence] }, { text: "UNSUPPORTED DECISION", evidence: [999999999] }],
    action_items: [{ text: "Send the checklist", owner: "Alex", due: "tomorrow", evidence: [evidence] }], open_questions: ["What is the final budget?"] };
  const model = createStubModel([{ content: JSON.stringify(answer), usage: { prompt_tokens: 100, completion_tokens: 50 } }], { name: "muse-wonder-1.0" });
  const outcome = await runRequest({ call: mcp.callTool, model, task: { task_id: taskId, request_kind: "meeting" }, runId: claim.run_id,
    prices: { input: 4, output: 20 }, log: (message) => console.log(`# ${message}`) });
  check(outcome.status === "completed", "real meeting runtime completes with in-process fake Wonder");
  check(model.requests.length === 1 && !model.requests[0].tools && model.requests[0].messages.some((m) => m.content.includes(source.notes_markdown)), "model receives notes/transcript without tools");
  const bundle = await rpc("get_page_bundle", { p_page_id: pageId });
  const summary = bundle.page.blocks.filter((b) => b.attr?.runId === claim.run_id);
  check(summary.length > 0 && summary.some((b) => b.type === "todo"), "summary and action checkboxes carry run attribution");
  check(summary.some((b) => b.html?.includes("[00:00]")) && !JSON.stringify(summary).includes("UNSUPPORTED DECISION"), "summary cites transcript and discards unsupported evidence");
  const [task] = await table(`agent_tasks?select=state,acceptance&id=eq.${taskId}`);
  const [run] = await table(`agent_runs?select=status,cost_usd&id=eq.${claim.run_id}`);
  check(task.state === "done" && task.acceptance === "accepted" && run.status === "completed", "task is done/accepted and run completed");
  check(Math.abs(Number(run.cost_usd) - .0014) < 1e-8, "summary usage costs exactly $0.0014 in local ledger");
  console.log(JSON.stringify({ page_id: pageId, meeting_id: meetingId, task_id: taskId, run_id: claim.run_id, status: "passed" }));
  if (provider && process.argv.includes("--keep-provider")) {
    console.log("meeting-smoke: provider stays on 61401 for browser rehearsal; interrupt when finished.");
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} finally { await provider?.stop(); }
