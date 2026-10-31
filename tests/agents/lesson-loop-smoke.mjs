#!/usr/bin/env node
// End-to-end check of the learning loop against a served stack. Not part of the unit suites: it needs a running stack,
// `supabase functions serve` and the seeded agents, and it leaves its tasks in the local database.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=... \
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... \
//   LEAD_PAT=agt_... CODEX_PAT=agt_... PLATFORM_PAT=agt_... \
//   SMOKE_DB_CONTAINER=supabase_db_<project> \
//   node tests/agents/lesson-loop-smoke.mjs
//
// A correction proposes a lesson, a person accepts it, the next agent receives it with its reason and cites it. Then a
// source changes, a check finds a contradiction and a person settles it. SMOKE_DB_CONTAINER runs the one step HTTP cannot
// reach: it skips the quiet window and fires the tick. SMOKE_SKIP_SOURCES=1 stops before the sources.
import { execFileSync } from "node:child_process";

const env = process.env;
const needed = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SMOKE_EMAIL", "SMOKE_PASSWORD", "LEAD_PAT", "CODEX_PAT", "PLATFORM_PAT", "SMOKE_DB_CONTAINER"];
const missing = needed.filter((name) => !env[name]);
if (missing.length) {
  console.error(`lesson-loop-smoke: set ${missing.join(", ")} (see the header of this file).`);
  process.exit(2);
}
const BASE = env.SUPABASE_URL.replace(/\/$/, "");
const MCP_URL = `${BASE}/functions/v1/mcp`;
const stamp = Date.now();
let nextId = 1;

function check(condition, message) {
  if (!condition) throw new Error(`failed: ${message}`);
  console.log(`ok - ${message}`);
}

async function exchange(token) {
  const res = await fetch(`${BASE}/functions/v1/agent-token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`agent-token ${res.status}: ${body.error ?? res.statusText}`);
  return body.access_token;
}

function agent(jwt) {
  return async (name, args = {}) => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${jwt}`, "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
    if (body.result.isError) throw new Error(`${name} failed: ${JSON.stringify(body.result.structuredContent ?? body.result.content)}`);
    return { ...(body.result.structuredContent ?? {}), _text: body.result.content?.[0]?.text ?? "" };
  };
}

const session = await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { "Content-Type": "application/json", apikey: env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD }),
})).json();
if (!session.access_token) throw new Error("the person could not sign in");
const personHeaders = { "Content-Type": "application/json", apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` };
async function person(fn, args) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: "POST", headers: personHeaders, body: JSON.stringify(args) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
async function table(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, { headers: personHeaders });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", env.SMOKE_DB_CONTAINER, "psql", "-U", "postgres", "-At", "-c", statement], { encoding: "utf8" }).trim();
}

const lead = agent(await exchange(env.LEAD_PAT));
const codex = agent(await exchange(env.CODEX_PAT));
const platform = agent(await exchange(env.PLATFORM_PAT));
const codexId = (await table("agents?select=id&name=eq.Codex"))[0]?.id;
check(codexId, "the seeded Codex agent is visible");

// 1. A delivery, corrected by a person.
const first = await lead("create_task", { title: `Weekly client report ${stamp}`, worker: codexId, idempotency_key: `smoke-${stamp}-1`,
  brief: { goal: "Write the weekly client report", done_when: ["Dates are right"] } });
const claim1 = await codex("claim_task", { task_id: first.task_id, harness: "codex" });
check(claim1.context_package !== undefined, "claim_task returns a context_package");
const artifact = await codex("add_artifact", { run_id: claim1.run_id, kind: "page", ref: first.row_page_id, title: "Report", satisfies: ["c1"] });
await codex("submit_for_review", { run_id: claim1.run_id, summary: "First version", artifact_ids: [artifact.artifact_id] });
await person("review_task", { p_task_id: first.task_id, p_verdict: "changes_requested",
  p_findings: [{ criterion_id: "c1", status: "contradicted", note: "Client reports use dates as DD/MM/YYYY" }] });

// 2. The platform agent proposes; nothing reaches anyone yet.
const mine = await platform("list_my_tasks", { limit: 50 });
const request = (mine.tasks ?? []).find((t) => t.request_kind === "lesson" && t.title === "Learn from a correction" && t.row_page_id === first.row_page_id);
check(request, "the correction queued a lesson request");
const claim2 = await platform("claim_task", { task_id: request.task_id ?? request.id, harness: "platform" });
check(claim2.context_package === undefined, "a request gets no package");
const input = await platform("get_ai_request", { task_id: request.task_id ?? request.id });
check(input.kind === "lesson" && input.corrections.some((c) => c.text.includes("DD/MM/YYYY")), "get_ai_request carries the correction");
const proposed = await platform("propose_lesson", { run_id: claim2.run_id, text: `Client reports use dates as DD/MM/YYYY (${stamp})`, example: "30/10/2026" });
await platform("complete_lesson_request", { run_id: claim2.run_id, summary: "Proposed one lesson" });

const second = await lead("create_task", { title: `Monthly client report ${stamp}`, worker: codexId, idempotency_key: `smoke-${stamp}-2`,
  brief: { goal: "Write the monthly client report", done_when: ["Dates are right"] } });
const before = await codex("claim_task", { task_id: second.task_id, harness: "codex" });
check(!before.context_package.lessons.some((l) => l.id === proposed.lesson_id), "a proposal reaches nobody");
await codex("release_for_handover", { run_id: before.run_id, reason: "smoke" }).catch(() => {});

// 3. A person accepts, and the next agent receives it, says why, and cites it.
await person("decide_lesson", { p_lesson_id: proposed.lesson_id, p_decision: "accept" });
const third = await lead("create_task", { title: `Quarterly client report ${stamp}`, worker: codexId, idempotency_key: `smoke-${stamp}-3`,
  brief: { goal: "Write the quarterly client report", done_when: ["Dates are right"] } });
const claim3 = await codex("claim_task", { task_id: third.task_id, harness: "codex" });
const lesson = claim3.context_package.lessons.find((l) => l.id === proposed.lesson_id);
check(lesson, "the next agent receives the accepted lesson");
check(/^Accepted for/.test(lesson.why), `it says why: ${lesson.why}`);
check(claim3._text.includes("cite_lesson"), "the claim text tells the model to cite it");
console.log(`related pages: ${JSON.stringify(claim3.context_package.related_pages)}`);
check(claim3.context_package.related_pages.some((p) => p.page_id === first.row_page_id), "the earlier report comes as a related page");
await codex("cite_lesson", { run_id: claim3.run_id, lesson_id: lesson.id, note: "Used DD/MM/YYYY" });
const again = await codex("get_context_package", { run_id: claim3.run_id });
check(again.context_package.lessons.some((l) => l.id === lesson.id), "get_context_package reads it again");
const stats = await person("lesson_stats", { p_workspace_id: (await table("workspaces?select=id"))[0].id });
const row = stats.find((s) => s.lesson_id === lesson.id);
check(row.delivered >= 1 && row.cited === 1, `the numbers add up: delivered ${row.delivered}, cited ${row.cited}`);

if (env.SMOKE_SKIP_SOURCES === "1") {
  console.log("lesson-loop-smoke: lessons and context passed, sources skipped");
  process.exit(0);
}

// 4. A source changes.
await codex("declare_sources", { run_id: claim3.run_id, page_id: third.row_page_id, sources: [{ page_id: first.row_page_id }] });
sql(`alter table public.pages disable trigger pages_20_revision;
     update public.pages set data = jsonb_set(data, '{title}', to_jsonb(data->>'title' || ' v2')) where id = '${first.row_page_id}';
     alter table public.pages enable trigger pages_20_revision;`);
const marked = await table(`page_sources?select=id,status&page_id=eq.${third.row_page_id}&source_page_id=eq.${first.row_page_id}`);
check(marked[0]?.status === "changed", "an edit marks the dependent page");
const read = await codex("read_page", { page_id: third.row_page_id });
check(read.changed_sources === 1, "read_page tells the agent");
sql(`update public.page_sources set changed_at = now() - interval '6 minutes' where page_id = '${third.row_page_id}'`);
check(Number(sql("select private.source_tick()")) >= 1, "the tick opens a check");
const checks = await platform("list_my_tasks", { limit: 50 });
const pending = (checks.tasks ?? []).find((t) => t.request_kind === "source_check" && t.row_page_id === third.row_page_id);
check(pending, "the platform agent sees the check");
const claim4 = await platform("claim_task", { task_id: pending.task_id ?? pending.id, harness: "platform" });
const view = await platform("get_ai_request", { task_id: pending.task_id ?? pending.id });
check(view.kind === "source_check" && view.sources[0].text.includes("v2"), "it reads the source as text");
const report = await platform("report_source_check", { run_id: claim4.run_id, verdict: "discrepancy",
  checked: view.sources.map((s) => ({ id: s.id, fingerprint: s.fingerprint, revision: s.revision })),
  summary: "The source was renamed and this page still uses the old name.",
  items: [{ source_id: view.sources[0].id, source_says: view.sources[0].title, page_says: "The old title" }] });
check(report.discrepancy_id, "a contradiction opens a discrepancy");
const settled = await person("resolve_discrepancy", { p_id: report.discrepancy_id, p_resolution: "keep", p_note: "The name does not matter here" });
check(settled.status === "resolved", "a person settles it");
const after = await table(`page_sources?select=status&page_id=eq.${third.row_page_id}&source_page_id=eq.${first.row_page_id}`);
check(after[0].status === "current", "and the source counts as observed");
console.log("lesson-loop-smoke: all checks passed");
