#!/usr/bin/env node
// Served-local-stack integration check. All external actions and resource names are test data.
// Uses the four local seed agents and the seed owner; never sends a Codex message or performs a merge.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRemote } from "../../bridge/remote.mjs";
import { eventToChannel } from "../../bridge/channel.mjs";
import { codexQueue, fileState, runWatcher } from "../../connect/codex/watch.mjs";
import { fileURLToPath } from "node:url";

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
const tokenFor = (name) => process.env[`P11_${name}_PAT`] || seed.match(new RegExp(`'(agt_LOCALDEV${name}[0-9]+)'`))?.[1];
const client = (name) => {
  const pat = tokenFor(name);
  assert.ok(pat, `Missing local ${name} seed credential`);
  return createRemote({ mcpUrl: mcp.href, pat, clientInfo: { name: "colabora-loop-e2e", version: "1" } });
};
const lead = client("LEAD"), worker = client("CODEX"), platform = client("COLABORA"), reviewer = client("REVIEWER");
const workerId = "00000000-0000-4000-8000-000000000022";
const reviewerId = "00000000-0000-4000-8000-000000000024";
const session = process.env.P11_TEST_THREAD_ID;
assert.match(session ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Set P11_TEST_THREAD_ID to a dedicated disposable Codex test chat");
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
let steps = 0;
const ok = (step) => { steps++; console.log(`ok ${step}`); };
let ownedEnvironment = null;

/** Run the actual watcher and execFile boundary against HTTP, with Node standing in for the Codex CLI. */
async function watchCorrection(taskId, cursor, blocking, minor, agentName = "CODEX") {
  const directory = fileURLToPath(rootFile(`.local/loop-${randomUUID()}/`));
  mkdirSync(directory, { recursive: true });
  const preload = `${directory}/fake-codex.cjs`;
  const capture = `${directory}/queue.jsonl`;
  writeFileSync(preload, String.raw`const {appendFileSync}=require("node:fs");
const {basename}=require("node:path");
const assert=require("node:assert/strict");
const args=[basename(process.argv[1]),...process.argv.slice(2)];
assert.equal(args[0],"queue"); assert.equal(args[1],"--thread"); assert.equal(args[2],process.env.P11_TEST_THREAD_ID);
assert.equal(Object.keys(process.env).some(key=>key.toUpperCase()==="WORKSPACE_AGENT_PAT"),false);
appendFileSync(process.env.P11_CAPTURE_PATH,JSON.stringify(args)+"\n"); process.exit(0);
`);
  const disk = fileState(`${directory}/state.json`);
  disk.save({ cursor });
  const env = { WORKSPACE_MCP_URL: mcp.href, WORKSPACE_AGENT_PAT: tokenFor(agentName) };
  const send = codexQueue(() => process.execPath, undefined, {
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    P11_CAPTURE_PATH: capture, P11_TEST_THREAD_ID: session, WORKSPACE_AGENT_PAT: tokenFor(agentName),
  });
  let queueCalls = 0;
  for (let pass = 0; pass < 2; pass++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      await runWatcher({ env, signal: controller.signal,
        state: { load: () => ({ ...disk.load(), cursor }), save: (value) => { disk.save(value); if (pass === 1) controller.abort(); } },
        fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }),
        queue: async (thread, message) => {
          queueCalls++;
          assert.equal(pass, 0, "Restart must not resend the acknowledged correction");
          assert.equal(thread, session); assert.ok(message.includes(taskId));
          await send(thread, message); controller.abort();
        },
      });
    } finally { clearTimeout(timeout); }
  }
  assert.equal(queueCalls, 1, "Restart must not invoke queue again, including a swallowed callback failure");
  const calls = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ["queue", "--thread", session, "--message"]);
  assert.ok(calls[0][4].includes(blocking)); if (minor) assert.ok(!calls[0][4].includes(minor));
  console.log(`watcher evidence: ${capture}`);
}

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
  let leadCursor = (await lead.callTool("wait_for_my_tasks", { timeout_s: 0 })).next_cursor;
  const workerCursor = (await worker.callTool("wait_for_my_tasks", { timeout_s: 0 })).next_cursor;
  const parent = await lead.callTool("create_task", { title: "P11 whole loop", reviewer: reviewerId, claim: false,
    brief: { goal: "Complete two dependent test deliveries", done_when: ["The local loop completes"] } });
  parent.run_id = (await lead.callTool("claim_task", { task_id: parent.task_id, harness: "codex", external_session_id: session })).run_id;
  const notices = [];
  const leadNotice = async (predicate) => {
    for (let page = 0; page < 20; page++) {
      const result = await lead.callTool("wait_for_my_tasks", { after: leadCursor, timeout_s: 0 });
      leadCursor = result.next_cursor;
      notices.push(...result.tasks.filter(task => task.task_id === parent.task_id && task.notice));
      const hit = notices.find(predicate); if (hit) return hit.notice.payload;
    }
    assert.fail("Expected notice did not reach the Lead without a bridge");
  };
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
  let run = await worker.callTool("claim_task", { task_id: first, harness: "codex", external_session_id: session });
  assert.equal(run.environment.length, resources.length);
  const oldRun = run.run_id;
  await lead.callTool("update_subtask", { task_id: first, delegate_agent_id: "00000000-0000-4000-8000-000000000023" });
  await assert.rejects(() => worker.callTool("add_artifact", { run_id: oldRun, kind: "page", ref: run.row_page_id, title: "Late", satisfies: [] }), error => error.code === "run_not_active");
  const replacement = await platform.callTool("claim_task", { task_id: first, harness: "reference-agent", resume: true });
  assert.ok(replacement.run_id);
  await lead.callTool("update_subtask", { task_id: first, delegate_agent_id: workerId });
  run = await worker.callTool("claim_task", { task_id: first, harness: "codex", external_session_id: session, resume: true });
  ok("3a active reassignment fences the former executor and both replacements can resume");
  const artifact = await worker.callTool("add_artifact", { run_id: run.run_id, kind: "diff", ref: `${repo}@${"a".repeat(40)}`, title: "First commit", satisfies: ["ci"] });
  let watchLeadCursor = (await lead.callTool("wait_for_my_tasks", { timeout_s: 0 })).next_cursor;
  const delivered = await worker.callTool("submit_for_review", { run_id: run.run_id, summary: "First delivery", artifact_ids: [artifact.artifact_id] });
  ok("3 only the first task is claimable; worker delivers");

  assert.ok(delivered.review_task_id);
  const deliveryEvent = event(parent.task_id, "type='task.continue' and payload ? 'review_task_id'");
  assert.equal(eventToChannel(deliveryEvent).meta.reason, "under_review");
  assert.equal((await leadNotice(task => task.reason === "under_review" && task.notice.payload.review_of === first)).review_task_id, delivered.review_task_id);
  const reviewRun = await reviewer.callTool("claim_task", { task_id: delivered.review_task_id, harness: "claude_code" });
  await watchCorrection(parent.task_id, watchLeadCursor, "under_review", null, "LEAD");
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
  await watchCorrection(first, workerCursor, blocking, minor);
  ok("6 actual watcher queues the correction once through a fake CLI, including after restart");

  const resumed = await worker.callTool("claim_task", { task_id: first, harness: "codex", external_session_id: session });
  const fixed = await worker.callTool("add_artifact", { run_id: resumed.run_id, kind: "diff", ref: `${repo}@${"b".repeat(40)}`, title: "Fixed commit", satisfies: ["ci"] });
  const redelivered = await worker.callTool("submit_for_review", { run_id: resumed.run_id, summary: "Fixed", artifact_ids: [fixed.artifact_id] });
  assert.notEqual(redelivered.review_task_id, delivered.review_task_id);
  const reviewTask = await reviewer.callTool("get_task", { task_id: redelivered.review_task_id });
  assert.match(reviewTask.brief.constraints, /round 2.*Confirm only/s);
  assert.ok(reviewTask.brief.constraints.includes(blocking)); assert.ok(!reviewTask.brief.constraints.includes(minor));
  const secondReview = await reviewer.callTool("claim_task", { task_id: redelivered.review_task_id, harness: "claude_code" });
  watchLeadCursor = (await lead.callTool("wait_for_my_tasks", { timeout_s: 0 })).next_cursor;
  await reviewer.callTool("review_task", { task_id: first, run_id: secondReview.run_id, artifact_id: fixed.artifact_id, verdict: "approved", findings: [
    { criterion_id: "ci", status: "verified", note: "The requested correction is present" }, { severity: "minor", status: "unverified", note: minor },
  ] });
  ok("7 redelivery opens a narrow second review and is approved");

  const verdictEvent = event(parent.task_id, "type='task.updated' and payload->>'verdict'='approved'");
  assert.equal(verdictEvent.payload.minor_findings.length, 1);
  assert.equal(eventToChannel(verdictEvent).meta.reason, "updated");
  assert.ok(eventToChannel(verdictEvent).content.includes("1 minor finding(s)"));
  assert.equal((await leadNotice(task => task.notice.payload.verdict === "approved" && task.notice.payload.review_of === first)).minor_findings.length, 1);
  await watchCorrection(parent.task_id, watchLeadCursor, "minor finding", null, "LEAD");
  ok("8 the Lead receives minor findings through the watcher");

  await human("set_merge_rule", { p_task_id: parent.task_id, p_conditions: ["review_approved", "ci_green"] });
  const ci = { id: Date.now(), name: "check", head_sha: "b".repeat(40), conclusion: "success", html_url: "https://github.com/p11/local-loop/actions/runs/1", head_branch: "a/p11", completed_at: new Date().toISOString() };
  sql(`select public.record_ci_check(${quote(connection.id)}::uuid, ${quote(repo)}, ${quote(JSON.stringify(ci))}::jsonb);`, true);
  const approved = await lead.callTool("request_approval", { run_id: parent.run_id, action: "git.merge", params: { subtask_id: first, repo, head_sha: ci.head_sha }, question: "Merge the test delivery?" });
  assert.equal(approved.status, "approved"); assert.equal(approved.auto_approved.by, "condition");
  ok("9 human rule plus recorded CI grants conditional approval");

  const ciBrief = { objective: "Negative proof", done_when: [{ id: "ci", text: "Independent review and CI", check: "ci", command: "check" }] };
  const recordCi = (sha, offset) => sql(`select public.record_ci_check(${quote(connection.id)}::uuid, ${quote(repo)}, ${quote(JSON.stringify({ ...ci, id: ci.id + offset, head_sha: sha, completed_at: new Date().toISOString() }))}::jsonb);`, true);
  const self = await lead.callTool("create_subtask", { parent_task_id: parent.task_id, delegate_agent_id: "00000000-0000-4000-8000-000000000021", brief: ciBrief });
  const selfRun = await lead.callTool("claim_task", { task_id: self.task_id, harness: "claude_code" });
  const selfArtifact = await lead.callTool("add_artifact", { run_id: selfRun.run_id, kind: "diff", ref: `${repo}@${"d".repeat(40)}`, title: "Self authored", satisfies: ["ci"] });
  await lead.callTool("submit_for_review", { run_id: selfRun.run_id, summary: "Self authored", artifact_ids: [selfArtifact.artifact_id] });
  await assert.rejects(() => lead.callTool("review_task", { task_id: self.task_id, run_id: parent.run_id, verdict: "approved", findings: [{ criterion_id: "ci", status: "verified" }] }), error => error.code === "self_review");
  recordCi("d".repeat(40), 1);
  const selfDenied = await lead.callTool("request_approval", { run_id: parent.run_id, action: "git.merge", params: { subtask_id: self.task_id, repo, head_sha: "d".repeat(40) }, question: "Self review must ask a person" });
  assert.equal(selfDenied.status, "pending");
  ok("9a self-review is rejected and its merge waits for a person");

  const fresh = await lead.callTool("create_subtask", { parent_task_id: parent.task_id, delegate_agent_id: workerId, brief: ciBrief });
  const deliverFresh = async (sha) => {
    const run = await worker.callTool("claim_task", { task_id: fresh.task_id, harness: "codex", external_session_id: session });
    const artifact = await worker.callTool("add_artifact", { run_id: run.run_id, kind: "diff", ref: `${repo}@${sha}`, title: "Freshness proof", satisfies: ["ci"] });
    return worker.callTool("submit_for_review", { run_id: run.run_id, summary: "Freshness proof", artifact_ids: [artifact.artifact_id] });
  };
  const reviewed = await deliverFresh(ci.head_sha);
  const freshReviewer = await reviewer.callTool("claim_task", { task_id: reviewed.review_task_id, harness: "reviewer" });
  await reviewer.callTool("review_task", { task_id: fresh.task_id, run_id: freshReviewer.run_id, verdict: "approved", findings: [{ criterion_id: "ci", status: "verified" }] });
  recordCi(ci.head_sha, 3);
  const priorProof = await lead.callTool("request_approval", { run_id: parent.run_id, action: "git.merge", params: { subtask_id: fresh.task_id, repo, head_sha: ci.head_sha }, question: "Previously reviewed commit" });
  assert.equal(priorProof.status, "approved");
  await lead.callTool("review_task", { task_id: fresh.task_id, run_id: parent.run_id, verdict: "changes_requested", findings: [{ criterion_id: "ci", status: "contradicted", note: "A new commit requires a new review" }] });
  await deliverFresh("c".repeat(40)); recordCi("c".repeat(40), 2);
  const freshDenied = await lead.callTool("request_approval", { run_id: parent.run_id, action: "git.merge", params: { subtask_id: fresh.task_id, repo, head_sha: "c".repeat(40) }, question: "Unreviewed commit must ask a person" });
  assert.equal(freshDenied.status, "pending");
  ok("9b green CI on a new unreviewed commit still waits for a person");

  watchLeadCursor = (await lead.callTool("wait_for_my_tasks", { timeout_s: 0 })).next_cursor;
  await lead.callTool("close_subtask", { task_id: first });
  const after = await worker.callTool("list_my_tasks", {});
  assert.deepEqual(after.tasks.find((t) => t.task_id === second).blocked_by, []);
  const released = event(parent.task_id, "type='task.updated' and payload ? 'environment_release'");
  assert.equal(released.payload.environment_release.length, 2);
  assert.ok(eventToChannel(released).content.includes("environment_release"));
  const polledRelease = await leadNotice(task => task.notice.payload.environment_release && task.notice.payload.subtask_id === first);
  assert.equal(polledRelease.environment_release.length, 2);
  await watchCorrection(parent.task_id, watchLeadCursor, "before stopping anything", null, "LEAD");
  ok("10 closing the task releases its dependent and requests environment shutdown");

  // These are synthetic resource records; the real test stack stays up until its caller stops it.
  const confirmed = await lead.callTool("release_environment", { task_id: eventToChannel(released).meta.subtask_id });
  assert.equal(confirmed.released, 2);
  assert.deepEqual((await worker.callTool("get_task", { task_id: first })).environment, []);
  ownedEnvironment = null;
  ok("11 Lead confirms release of the synthetic environment");
  const operation = await lead.callTool("begin_external_op", { run_id: parent.run_id, provider: "github", action: "git.merge",
    params: { subtask_id: first, repo, head_sha: ci.head_sha }, approval_receipt: approved.receipt });
  assert.equal(operation.status, "pending"); assert.ok(operation.op_id);
  const finalParent = await lead.callTool("get_task", { task_id: parent.task_id });
  for (const id of [selfDenied.approval_id, freshDenied.approval_id]) assert.ok(finalParent.approvals_pending.some(approval => approval.id === id));
  ok("12 begin_external_op authorizes only the exact independently reviewed commit; no merge is executed");
  console.log(`loop-e2e: all ${steps} steps passed`);
}

main().catch((error) => { console.error(`loop-e2e: FAILED - ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; })
  .finally(async () => {
    if (ownedEnvironment) {
      try { await lead.callTool("release_environment", { task_id: ownedEnvironment }); }
      catch { console.error("loop-e2e: could not release this run's synthetic environment"); process.exitCode = 1; }
    }
  });
