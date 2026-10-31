#!/usr/bin/env node
// Served-local-stack integration check. All external actions and resource names are test data.
// Uses the four local seed agents and the seed owner; never sends a Codex message or performs a merge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRemote } from "../../bridge/remote.mjs";
import { eventToChannel } from "../../bridge/channel.mjs";
import { buildReason, feedbackExcerpt } from "../../connect/codex/on-stop.mjs";

const rootFile = (path) => new URL(`../../${path}`, import.meta.url);
function localEnv() {
  try { return Object.fromEntries(readFileSync(rootFile(".env.local"), "utf8").split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")];
  })); } catch { return {}; }
}
const configured = localEnv();
const config = readFileSync(rootFile("supabase/config.toml"), "utf8");
const project = config.match(/^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/m)?.[1];
const apiPort = config.match(/\[api\][\s\S]*?^port\s*=\s*(\d+)/m)?.[1] ?? "54321";
const base = new URL(process.env.SUPABASE_URL || configured.VITE_SUPABASE_URL || `http://127.0.0.1:${apiPort}`);
const mcp = new URL(process.env.MCP_URL || "/functions/v1/mcp", base);
assert.ok(project && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && base.protocol === "http:", "Use a local stack only");
assert.equal(base.port, apiPort, "The API must belong to this worktree's configured stack");
assert.equal(mcp.origin, base.origin, "MCP must use the same local stack");
const anonKey = process.env.SUPABASE_ANON_KEY || configured.VITE_SUPABASE_PUBLISHABLE_KEY;
assert.ok(anonKey, "Set the local VITE_SUPABASE_PUBLISHABLE_KEY in .env.local or SUPABASE_ANON_KEY");
const seed = readFileSync(rootFile("supabase/seeds/02_agents.sql"), "utf8");
const client = (name) => {
  const pat = process.env[`P11_${name}_PAT`] || seed.match(new RegExp(`'(agt_LOCALDEV${name}[0-9]+)'`))?.[1];
  assert.ok(pat, `Missing local ${name} seed credential`);
  return createRemote({ mcpUrl: mcp.href, pat, clientInfo: { name: "colabora-loop-e2e", version: "1" } });
};
const lead = client("LEAD"), worker = client("CODEX"), platform = client("COLABORA"), reviewer = client("REVIEWER");
const workerId = "00000000-0000-4000-8000-000000000022";
const reviewerId = "00000000-0000-4000-8000-000000000024";
const session = process.env.P11_TEST_THREAD_ID || randomUUID();
const repo = "p11/local-loop";
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sql = (query, service = false) => {
  const role = service ? "set local role service_role; set local request.jwt.claims = '{\"role\":\"service_role\"}';" : "";
  const text = execFileSync("docker", ["exec", "-i", `supabase_db_${project}`, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1"], {
    input: `begin; ${role}\n${query}\ncommit;`, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  return text ? JSON.parse(text) : null;
};
const event = (parentId, predicate) => sql(`select row_to_json(e) from public.agent_events e where task_id=${quote(parentId)}::uuid and ${predicate} order by seq desc limit 1;`);
const ok = (step) => console.log(`ok ${step}`);
let ownedEnvironment = null;

async function main() {
  const auth = await fetch(new URL("/auth/v1/token?grant_type=password", base), {
    method: "POST", headers: { "Content-Type": "application/json", apikey: anonKey },
    body: JSON.stringify({ email: "owner@demo.local", password: "demo-password" }),
  });
  assert.ok(auth.ok, `Local seed owner login failed (${auth.status})`);
  const { access_token: humanToken } = await auth.json();
  const human = async (name, params) => {
    const response = await fetch(new URL(`/rest/v1/rpc/${name}`, base), {
      method: "POST", headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${humanToken}` }, body: JSON.stringify(params),
    });
    const result = await response.json();
    assert.ok(response.ok, `${name} failed (${response.status}): ${result.message ?? "RPC error"}`);
    return result;
  };
  const parent = await lead.callTool("create_task", { title: "P11 whole loop", reviewer: reviewerId,
    brief: { goal: "Complete two dependent test deliveries", done_when: ["The local loop completes"] } });
  const currentParent = await lead.callTool("get_task", { task_id: parent.task_id });
  const connection = await human("create_ci_connection", { p_workspace_id: currentParent.task.workspace_id, p_repo: repo });
  const plan = await lead.callTool("import_plan", { parent_task_id: parent.task_id, idempotency_key: `loop-${randomUUID()}`, subtasks: [
    { key: "second", delegate_agent_id: workerId, depends_on: ["first"], brief: { objective: "Follow the first delivery", done_when: [{ id: "done", text: "Follow-up ready", check: "lead" }] } },
    { key: "first", delegate_agent_id: workerId, brief: { objective: "Deliver a reviewed commit", done_when: [{ id: "ci", text: "The check passes", check: "ci", command: "check" }] } },
  ] });
  const first = plan.created.first, second = plan.created.second;
  ownedEnvironment = first;
  ok("1 parent policy and two imported subtasks with a dependency");

  const resources = [{ kind: "ports", value: "60990-60999" }, { kind: "stack", value: `loop-test-${first}` }, { kind: "migration", value: "0035" }];
  await lead.callTool("reserve_environment", { task_id: first, items: resources });
  await assert.rejects(() => lead.callTool("reserve_environment", { task_id: second, items: resources }), (error) => error.code === "resource_taken");
  const visible = await platform.callTool("list_environments", {});
  assert.equal(visible.environments.filter((r) => r.task_id === first).length, 0);
  await assert.rejects(() => platform.callTool("reserve_environment", { task_id: first, items: resources }), (error) => error.code === "forbidden");
  ok("2 reservation conflict and isolation from the unrelated fourth seed agent");

  const listed = await worker.callTool("list_my_tasks", {});
  const available = listed.tasks.filter((t) => [first, second].includes(t.task_id) && t.state === "queued" && !t.blocked_by.length);
  assert.deepEqual(available.map((t) => t.task_id), [first]);
  await assert.rejects(() => worker.callTool("claim_task", { task_id: second, harness: "codex" }), (error) => error.code === "dependency_open");
  const run = await worker.callTool("claim_task", { task_id: first, harness: "codex", external_session_id: session });
  const artifact = await worker.callTool("add_artifact", { run_id: run.run_id, kind: "diff", ref: `${repo}@${"a".repeat(40)}`, title: "First commit", satisfies: ["ci"] });
  const delivered = await worker.callTool("submit_for_review", { run_id: run.run_id, summary: "First delivery", artifact_ids: [artifact.artifact_id] });
  ok("3 only the first task is claimable; worker delivers");

  assert.ok(delivered.review_task_id);
  const deliveryEvent = event(parent.task_id, "type='task.continue' and payload ? 'review_task_id'");
  assert.equal(eventToChannel(deliveryEvent).meta.reason, "under_review");
  const reviewRun = await reviewer.callTool("claim_task", { task_id: delivered.review_task_id, harness: "claude_code" });
  ok("4 review task opens automatically and Lead receives under_review");

  const blocking = "Fix the missing assertion";
  const minor = "Optional helper rename";
  await reviewer.callTool("review_task", { task_id: first, run_id: reviewRun.run_id, artifact_id: artifact.artifact_id, verdict: "changes_requested", findings: [
    { criterion_id: "ci", status: "contradicted", note: blocking }, { severity: "minor", status: "unverified", note: minor },
  ] });
  ok("5 reviewer records blocking and minor findings");

  const waited = await worker.callTool("wait_for_my_tasks", { timeout_s: 0 });
  const feedback = waited.tasks.find((t) => t.task_id === first);
  assert.equal(feedback.reason, "feedback"); assert.equal(feedback.session_id, session);
  const detail = await worker.callTool("get_task", { task_id: first, activities_limit: 10 });
  const message = buildReason(feedback, feedbackExcerpt(detail));
  assert.ok(message.includes(blocking)); assert.ok(!message.includes(minor));
  ok("6 feedback targets the worker session and excludes the minor finding");

  const resumed = await worker.callTool("claim_task", { task_id: first, harness: "codex", external_session_id: session });
  const fixed = await worker.callTool("add_artifact", { run_id: resumed.run_id, kind: "diff", ref: `${repo}@${"b".repeat(40)}`, title: "Fixed commit", satisfies: ["ci"] });
  const redelivered = await worker.callTool("submit_for_review", { run_id: resumed.run_id, summary: "Fixed", artifact_ids: [fixed.artifact_id] });
  assert.notEqual(redelivered.review_task_id, delivered.review_task_id);
  const reviewTask = await reviewer.callTool("get_task", { task_id: redelivered.review_task_id });
  assert.match(reviewTask.brief.constraints, /round 2.*Confirm only/s);
  assert.ok(reviewTask.brief.constraints.includes(blocking)); assert.ok(!reviewTask.brief.constraints.includes(minor));
  const secondReview = await reviewer.callTool("claim_task", { task_id: redelivered.review_task_id, harness: "claude_code" });
  await reviewer.callTool("review_task", { task_id: first, run_id: secondReview.run_id, artifact_id: fixed.artifact_id, verdict: "approved", findings: [
    { criterion_id: "ci", status: "verified", note: "The requested correction is present" }, { severity: "minor", status: "unverified", note: minor },
  ] });
  ok("7 redelivery opens a narrow second review and is approved");

  const verdictEvent = event(parent.task_id, "type='task.updated' and payload->>'verdict'='approved'");
  assert.equal(verdictEvent.payload.minor_findings.length, 1);
  assert.equal(eventToChannel(verdictEvent).meta.reason, "updated");
  assert.ok(eventToChannel(verdictEvent).content.includes("1 minor finding(s)"));
  ok("8 the Lead receives minor findings");

  await human("update_brief", { p_task_id: parent.task_id, p_patch: { policies: { ...currentParent.brief.policies, preapproved_if: { "git.merge": ["review_approved", "ci_green"] } } } });
  const ci = { id: Date.now(), name: "check", head_sha: "b".repeat(40), conclusion: "success", html_url: "https://github.com/p11/local-loop/actions/runs/1", head_branch: "a/p11", completed_at: new Date().toISOString() };
  sql(`select public.record_ci_check(${quote(connection.id)}::uuid, ${quote(repo)}, ${quote(JSON.stringify(ci))}::jsonb);`, true);
  const approved = await lead.callTool("request_approval", { run_id: parent.run_id, action: "git.merge", params: { subtask_id: first }, question: "Merge the test delivery?" });
  assert.equal(approved.status, "approved"); assert.equal(approved.auto_approved.by, "condition");
  ok("9 human rule plus recorded CI grants conditional approval");

  await lead.callTool("close_subtask", { task_id: first });
  const after = await worker.callTool("list_my_tasks", {});
  assert.deepEqual(after.tasks.find((t) => t.task_id === second).blocked_by, []);
  const released = event(parent.task_id, "type='task.updated' and payload ? 'environment_release'");
  assert.equal(released.payload.environment_release.length, 2);
  assert.ok(eventToChannel(released).content.includes("environment_release"));
  ok("10 closing the task releases its dependent and requests environment shutdown");

  // These are synthetic resource records; the real test stack stays up until its caller stops it.
  const confirmed = await lead.callTool("release_environment", { task_id: eventToChannel(released).meta.subtask_id });
  assert.equal(confirmed.released, 2);
  assert.deepEqual((await worker.callTool("get_task", { task_id: first })).environment, []);
  ownedEnvironment = null;
  ok("11 Lead confirms release of the synthetic environment");
  console.log("loop-e2e: all 11 steps passed");
}

main().catch((error) => { console.error(`loop-e2e: FAILED - ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; })
  .finally(async () => {
    if (ownedEnvironment) {
      try { await lead.callTool("release_environment", { task_id: ownedEnvironment }); }
      catch { console.error("loop-e2e: could not release this run's synthetic environment"); process.exitCode = 1; }
    }
  });
