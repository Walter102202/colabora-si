#!/usr/bin/env node
// End-to-end check of voice and notes against a served stack and a stand-in provider. Not part of the unit suites: it
// needs a running stack, `supabase functions serve` with META_API_BASE pointing at the stand-in, the seeded agents and
// ffmpeg, and it leaves its rows in the local database.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=... SMOKE_EMAIL=... SMOKE_PASSWORD=... PLATFORM_PAT=agt_... \
//   SMOKE_PROVIDER_PORT=60985 node tests/agents/voice-notes-smoke.mjs
//
// SMOKE_STAGE=notes runs only written notes. SMOKE_STAGE=voice adds voice. Without it, the agent's answer too.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramChannel } from "../../agent/channels/telegram.mjs";
import { createInbox } from "../../agent/inbox.mjs";
import { createMcpClient } from "../../agent/mcpClient.mjs";
import { runRequest } from "../../agent/requests.mjs";
import { createStubModel } from "../../agent/test/stub-model.mjs";
import { createVoiceClient } from "../../agent/voice.mjs";
import { startStubProvider } from "./voice-stub-provider.mjs";

const env = process.env;
const needed = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SMOKE_EMAIL", "SMOKE_PASSWORD", "PLATFORM_PAT", "SMOKE_PROVIDER_PORT"];
const missing = needed.filter((name) => !env[name]);
if (missing.length) {
  console.error(`voice-notes-smoke: set ${missing.join(", ")} (see the header of this file).`);
  process.exit(2);
}
const BASE = env.SUPABASE_URL.replace(/\/$/, "");
const VOICE_URL = `${BASE}/functions/v1/voice-transcribe`;
const stage = env.SMOKE_STAGE ?? "all";
const run = Date.now();
let messageId = Math.floor(run / 1000) % 1_000_000_000;
let workspace = "";

function check(condition, message) {
  if (!condition) throw new Error(`failed: ${message}`);
  console.log(`ok - ${message}`);
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
const pageText = async (id) => JSON.stringify((await person("get_page_bundle", { p_page_id: id })).page.blocks ?? []);
const say = (body, extra = {}) => person("post_agent_message", { p_workspace_id: workspace, p_body: body, p_client_id: crypto.randomUUID(), ...extra });

function wav(seconds = 1) {
  const data = 48000 * seconds;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8, "latin1"); b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "latin1"); b.writeUInt32LE(data, 40);
  return b;
}
const clip = (body, query, headers = personHeaders) => fetch(`${VOICE_URL}?${query}`, { method: "POST", headers: { ...headers, "Content-Type": "audio/wav" }, body });

const provider = await startStubProvider({ port: Number(env.SMOKE_PROVIDER_PORT) });
try {
  const [{ id }] = await table("workspaces?select=id&limit=1");
  workspace = id;

  let ogg = Buffer.alloc(0);
  const mcp = createMcpClient({ url: `${BASE}/functions/v1/mcp`, pat: env.PLATFORM_PAT, tokenUrl: `${BASE}/functions/v1/agent-token`, clientName: "voice-smoke" });
  const chatId = String(1000 + (run % 1000));
  const said = [];
  const queue = [];
  const controller = new AbortController();
  const fetchTelegram = async (url, init) => {
    const u = String(url), method = u.split("/").pop();
    if (u.includes("/file/")) return new Response(ogg);
    if (method === "getUpdates") {
      const updates = queue.splice(0);
      if (!updates.length) await new Promise((r) => setTimeout(r, 30));
      return Response.json({ ok: true, result: updates });
    }
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: "voice/n.oga", file_size: ogg.length } });
    if (method === "sendMessage") said.push(JSON.parse(String(init.body)).text);
    return Response.json({ ok: true, result: {} });
  };
  const telegram = createTelegramChannel({ token: "stub", ownerChatId: chatId, fetchImpl: fetchTelegram });
  const inbox = createInbox({
    call: mcp.callTool,
    transcribe: createVoiceClient({ url: VOICE_URL, accessToken: mcp.accessToken, download: telegram.download }),
    send: telegram.reply, typing: telegram.typing, appUrl: "http://app.test", timezone: "America/Santiago", log: (m) => console.log(`# ${m}`),
  });
  const pending = [];
  const polling = telegram.start({ signal: controller.signal, onMessage: (m) => { const p = inbox.deliver(m); pending.push(p); return p; } });
  const push = async (message) => {
    const id = message.message_id ?? ++messageId;
    queue.push({ update_id: id, message: { message_id: id, chat: { id: Number(chatId), type: "private" }, from: { id: Number(chatId), language_code: "es" }, ...message } });
    while (queue.length) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all(pending);
    return id;
  };

  async function trama(steps = [{ content: "Listo." }]) {
    const open = await mcp.callTool("list_my_tasks", { state: ["queued"] });
    const request = (open.data.tasks ?? []).find((t) => t.request_kind === "assist");
    check(Boolean(request), "the person's messages opened an assist request");
    const claim = await mcp.callTool("claim_task", { task_id: request.id ?? request.task_id, harness: "voice-smoke" });
    check(!claim.isError, "Trama claims the request on the private page");
    const model = createStubModel(steps);
    const outcome = await runRequest({ call: mcp.callTool, model, task: { task_id: String(claim.data.task_id), request_kind: "assist" }, runId: String(claim.data.run_id), log: (m) => console.log(`# ${m}`), reply: telegram.reply, appUrl: "http://app.test" });
    check(outcome.status === "completed", "Trama completes the request");
    return model;
  }

  // The first note of a person, sent several times at once, and one send delivered several times.
  const racing = await Promise.all(Array.from({ length: 6 }, (_, i) => say(`guarda en notas: carrera ${run} ${i}`)));
  check((await table("note_pages?select=page_id")).length === 1, "six sends at once find one notes page");
  check(racing.every((r) => r.outcome.kind === "for_agent"), "all six wait for Trama");
  await trama();
  check((await table(`saved_notes?select=id&message_id=in.(${racing.map((r) => r.message_id).join(",")})`)).length === 6, "Trama saves all six notes");
  const sameSend = crypto.randomUUID();
  const doubles = await Promise.all(Array.from({ length: 4 }, () => person("post_agent_message", { p_workspace_id: workspace, p_body: `guarda en notas: doble ${run}`, p_client_id: sameSend })));
  check(doubles.filter((d) => !d.duplicate).length === 1, "one send delivered four times at once saves once");

  // Point 63, written, through Trama with a fake model and no voice provider.
  const saved = await say(`guarda en notas: smoke ${run}`);
  check(saved.outcome.kind === "for_agent", "a written command waits for Trama");
  await trama();
  const [{ page_id: notes }] = await table(`saved_notes?select=page_id&message_id=eq.${saved.message_id}`);
  check((await pageText(notes)).includes(`smoke ${run}`), "the note is on the page");
  const again = await person("post_agent_message", { p_workspace_id: workspace, p_body: `guarda en notas: once ${run}`, p_client_id: "00000000-0000-4000-8000-" + String(run).slice(-12).padStart(12, "0") });
  const twice = await person("post_agent_message", { p_workspace_id: workspace, p_body: `guarda en notas: once ${run}`, p_client_id: "00000000-0000-4000-8000-" + String(run).slice(-12).padStart(12, "0") });
  await trama();
  check(twice.duplicate === true && (await pageText(notes)).split(`once ${run}`).length === 2, "a retry of the same send saves once");
  check((await person("undo_note", { p_note_id: (await table(`saved_notes?select=id&message_id=eq.${again.message_id}`))[0].id })).undone === true && !(await pageText(notes)).includes(`once ${run}`), "undo takes it back");
  check((await say("toma nota mental de esto")).outcome.kind === "for_agent", "a look-alike saves nothing");

  const unasked = await say(`ordinary ${run}`);
  const realRequest = await say(`guarda en notas: authorized ${run}`);
  await trama([{ tool_calls: [{ name: "save_to_notes", arguments: { message_id: unasked.message_id } }] }, { content: "Listo." }]);
  check((await table(`saved_notes?select=id&message_id=eq.${unasked.message_id}`)).length === 0, "key two refuses the model's unrequested message");
  check((await table(`saved_notes?select=id&message_id=eq.${realRequest.message_id}`)).length === 1, "runtime fallback saves the person's real request");

  // Point 62, from the app.
  if (stage !== "notes") {
  check((await clip(wav(), `workspace_id=${workspace}`, {})).status === 401, "no token, no clip");
  check((await clip(Buffer.from("OggS".padEnd(100, "x")), `workspace_id=${workspace}`)).status === 400, "what is not WAV stops at the door");
  check(provider.seen.requests === 0, "and reaches no provider");
  check((await clip(wav(301), `workspace_id=${workspace}`)).status === 413, "over five minutes is refused before any cost");

  provider.script.push({ transcript: `guarda en notas: de voz ${run}` });
  const heard = await (await clip(wav(2), `workspace_id=${workspace}`)).json();
  check(heard.transcript === `guarda en notas: de voz ${run}` && heard.duration_ms === 2000, "the runtime transcribes one real multipart request");
  const [row] = await table(`voice_clips?select=status,cost_usd,audio_ms&id=eq.${heard.clip_id}`);
  check(row.status === "transcribed" && Number(row.cost_usd) === 0.0001 && Number(row.audio_ms) === 2000, "the minutes are recorded as cost");
  check(!(await pageText(notes)).includes(`de voz ${run}`), "a transcript does nothing until the person sends it");
  const voiced = await say(`guarda en notas: de voz corregido ${run}`, { p_voice_clip_id: heard.clip_id });
  await trama();
  check(voiced.outcome.kind === "for_agent" && (await pageText(notes)).includes(`de voz corregido ${run}`), "the corrected text is what gets saved");

  provider.script.push({ status: 500 });
  const down = await clip(wav(), `workspace_id=${workspace}`);
  check(down.status === 502 && !JSON.stringify(await down.json()).includes("scripted"), "a provider failure says nothing about the provider");
  provider.script.push({ status: 429 });
  const busy = await clip(wav(), `workspace_id=${workspace}`);
  check(busy.status === 503 && busy.headers.get("retry-after") === "5", "a busy provider asks to retry");
  const failed = await table(`voice_clips?select=status,cost_usd&order=created_at.desc&limit=2`);
  check(failed.every((c) => c.status === "failed" && Number(c.cost_usd) === 0), "neither was charged");
  }

  // Point 62, from Telegram, with a real voice note through ffmpeg.
  if (stage !== "notes") {
    const dir = mkdtempSync(join(tmpdir(), "voice-smoke-"));
    const oggPath = join(dir, "note.ogg");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", "-f", "ogg", oggPath]);
    ogg = readFileSync(oggPath);
    rmSync(dir, { recursive: true, force: true });
  }

  const voiceNote = { voice: { file_id: "f1", duration: 2, file_size: ogg.length } };

  await push({ text: `guarda en notas: telegram ${run}` });
  await trama();
  check(said.at(-1)?.includes("Guardado") && said.at(-1)?.includes(`http://app.test/p/${notes}`) && said.at(-1)?.includes("/deshacer"), "a written note on Telegram is confirmed with a link and a way to undo");
  await push({ text: "/deshacer" });
  check(!(await pageText(notes)).includes(`telegram ${run}`), "and /deshacer takes it back");

  if (stage !== "notes") {
  provider.script.push({ transcript: `guarda en notas: nota de voz ${run}` });
  const first = await push(voiceNote);
  check(said.at(-1)?.startsWith(`Entendí: "guarda en notas: nota de voz ${run}"`), "Telegram repeats the transcript");
  await trama();
  check((await pageText(notes)).includes(`nota de voz ${run}`), "a real voice note goes through ffmpeg, the model and the note");

  const before = provider.seen.ok;
  await push({ ...voiceNote, message_id: first });
  check(provider.seen.ok === before, "the same voice note delivered again reaches no model");

  provider.script.push({ transcript: `guarda en notas: reenviado ${run}` });
  await push({ ...voiceNote, forward_origin: { type: "user" } });
  check(said.at(-1)?.startsWith("Audio reenviado:") && !(await pageText(notes)).includes(`reenviado ${run}`), "a forwarded audio that says the words saves nothing");

  provider.script.push({ transcript: "apruebo la tarea" });
  await push(voiceNote);
  check(said.at(-1) === 'Entendí: "apruebo la tarea"', "a voice that says approve is only a message");
  }

  if (stage === "all") {
    // The agent's answer, in one turn with no tools, through the real request path.
    const model = await trama([{ content: `Respuesta ${run}`, usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
    check(!JSON.stringify(model.requests[0].tools ?? []).includes("save"), "the model had no tool");
    check(said.at(-1) === `Respuesta ${run}`, "the answer reaches the chat where the person wrote");
    check((await table(`agent_messages?select=body&direction=eq.out&kind=eq.text&body=eq.${encodeURIComponent(`Respuesta ${run}`)}`)).length === 1, "and it stays in the thread");
  }

  controller.abort();
  await Promise.race([polling, new Promise((r) => setTimeout(r, 200))]);
  console.log("voice-notes-smoke: all checks passed");
  process.exit(0);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
} finally {
  await Promise.race([provider.stop(), new Promise((r) => setTimeout(r, 200))]);
}
