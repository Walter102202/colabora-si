import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createTelegramChannel, readMessage } from "../../agent/channels/telegram.mjs";
import { createInbox, flushPersonReplies, type ChannelMessage } from "../../agent/inbox.mjs";
import { createVoiceClient, oggToWav } from "../../agent/voice.mjs";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const chat = { id: 5, type: "private" };
const from = { id: 5, language_code: "es" };

it("keeps a failed channel reply pending and acknowledges it only after retry", async () => {
  const queued = [{ message_id: "m", chat_id: "5", text: "Guardado.", note_page_id: "p" }];
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (args.ack_message_id) queued.splice(0);
    return { isError: false, text: "", data: { messages: [...queued] } };
  });
  const reply = vi.fn(async () => {});
  reply.mockRejectedValueOnce(new Error("offline"));
  await flushPersonReplies({ call, reply, appUrl: "http://app.test" });
  expect(queued).toHaveLength(1);
  expect(call.mock.calls.some(([, args]) => args.ack_message_id)).toBe(false);
  await flushPersonReplies({ call, reply, appUrl: "http://app.test" });
  expect(queued).toHaveLength(0);
  expect(reply).toHaveBeenLastCalledWith("5", "Guardado.\nhttp://app.test/p/p");
});

describe("readMessage", () => {
  it("reads text, and the language of the sender", () => {
    expect(readMessage({ message_id: 1, chat, from, text: " hola " })).toEqual({ chatId: "5", messageId: 1, lang: "es", forwarded: false, text: "hola" });
    expect(readMessage({ message_id: 1, chat, from: { language_code: "en-US" }, text: "hi" }).lang).toBe("en");
  });
  it("reads a voice note", () => {
    expect(readMessage({ message_id: 2, chat, from, voice: { file_id: "f", duration: 9, file_size: 100 } }).voice).toEqual({ fileId: "f", seconds: 9, bytes: 100 });
  });
  it.each([
    [{ forward_origin: { type: "user" } }], [{ forward_origin: { type: "hidden_user" } }], [{ forward_origin: { type: "chat" } }],
    [{ forward_origin: { type: "channel" } }], [{ forward_date: 1 }],
  ])("marks %j as forwarded, whatever it says", (fields) => {
    expect(readMessage({ message_id: 3, chat, from, text: "guarda en notas: x", ...fields }).forwarded).toBe(true);
    expect(readMessage({ message_id: 3, chat, from, voice: { file_id: "f" }, ...fields }).forwarded).toBe(true);
  });
  it("keeps what a reply points at", () => {
    expect(readMessage({ message_id: 4, chat, from, text: "guarda esto en notas", reply_to_message: { message_id: 2, text: "el texto" } })).toMatchObject({ quoteMessageId: 2, quoteText: "el texto" });
    expect(readMessage({ message_id: 4, chat, from, text: "guarda esto en notas", quote: { text: "un trozo" }, reply_to_message: { message_id: 2, text: "el texto completo" } }).quoteText).toBe("un trozo");
    const voice = readMessage({ message_id: 4, chat, from, text: "guarda esto en notas", reply_to_message: { message_id: 2, voice: {} } });
    expect(voice.quoteMessageId).toBe(2);
    expect(voice.quoteText).toBeUndefined();
  });
  it("takes the transcript out of the bot's echo", () => {
    expect(readMessage({ message_id: 4, chat, from, text: "guarda esto en notas", reply_to_message: { message_id: 2, from: { is_bot: true }, text: 'Entendí: "comprar pan"\n\nGuardado.' } }).quoteText).toBe("comprar pan");
    expect(readMessage({ message_id: 4, chat, from, text: "guarda esto en notas", reply_to_message: { message_id: 2, from: { is_bot: false }, text: 'Entendí: "x"' } }).quoteText).toBe('Entendí: "x"');
  });
  it.each([[{ audio: { file_id: "a" } }], [{ document: { file_id: "d" } }], [{ video_note: { file_id: "v" } }], [{ photo: [] }]])("does not take %j", (fields) => {
    expect(readMessage({ message_id: 6, chat, from, ...fields }).unsupported).toBe(true);
  });
});

function telegram(updates: object[]) {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const controller = new AbortController();
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() as string;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ method, body });
    if (method === "getUpdates") {
      if (sent.filter((s) => s.method === "getUpdates").length > 1) controller.abort();
      return Response.json({ ok: true, result: sent.filter((s) => s.method === "getUpdates").length === 1 ? updates : [] });
    }
    return Response.json({ ok: true, result: { file_path: "voice/f.oga", file_size: 3 } });
  });
  const channel = createTelegramChannel({ token: "SECRET", ownerChatId: "5", fetchImpl: fetchImpl as unknown as typeof fetch });
  return { sent, channel, controller, fetchImpl };
}

describe("the Telegram channel", () => {
  it.each([false, true])("does not acknowledge pending/failed ingestion (reject=%s) and still answers status", async (rejects) => {
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    const offsets: number[] = [];
    const sent: string[] = [];
    const update = { update_id: 1, message: { message_id: 1, chat, from, text: "hola" } };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("sendMessage")) { sent.push(body.text); return Response.json({ ok: true, result: {} }); }
      offsets.push(body.offset);
      if (offsets.length === 1) return Response.json({ ok: true, result: [update, { update_id: 2, message: { message_id: 2, chat, from, text: "/status" } }] });
      if (offsets.length === 2) { release(); return Response.json({ ok: true, result: [] }); }
      if (rejects && offsets.length === 3) return Response.json({ ok: true, result: [update] });
      controller.abort();
      return Response.json({ ok: true, result: [] });
    });
    const onMessage = vi.fn(async () => { if (onMessage.mock.calls.length === 1) { await pending; if (rejects) throw new Error("retry"); } });
    const channel = createTelegramChannel({ token: "stub", ownerChatId: "5", fetchImpl: fetchImpl as unknown as typeof fetch });
    await channel.start({ signal: controller.signal, onMessage, status: () => "busy" });
    expect(offsets).toEqual(rejects ? [0, 0, 0, 3] : [0, 0, 3]);
    expect(onMessage).toHaveBeenCalledTimes(rejects ? 2 : 1);
    expect(sent).toEqual(["Status: busy"]);
  });
  it("gives the inbox what the owner sends in a private chat", async () => {
    const h = telegram([{ update_id: 1, message: { message_id: 1, chat, from, text: "hola" } }]);
    const onMessage = vi.fn();
    await h.channel.start({ signal: h.controller.signal, onMessage });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "hola" }));
  });
  it("ignores another chat, a group with the owner's id and a bot", async () => {
    const h = telegram([
      { update_id: 1, message: { message_id: 1, chat: { id: 6, type: "private" }, from, text: "x" } },
      { update_id: 2, message: { message_id: 2, chat: { id: 5, type: "group" }, from: { id: 9 }, text: "guarda en notas: x" } },
      { update_id: 3, message: { message_id: 3, chat, from: { is_bot: true }, text: "x" } },
    ]);
    const onMessage = vi.fn();
    await h.channel.start({ signal: h.controller.signal, onMessage });
    expect(onMessage).not.toHaveBeenCalled();
    expect(h.sent.filter((s) => s.method === "sendMessage")).toEqual([]);
  });
  it("answers /status itself", async () => {
    const h = telegram([{ update_id: 1, message: { message_id: 1, chat, from, text: "/status" } }]);
    const onMessage = vi.fn();
    await h.channel.start({ signal: h.controller.signal, status: () => "busy", onMessage });
    expect(onMessage).not.toHaveBeenCalled();
    expect(h.sent.find((s) => s.method === "sendMessage")?.body.text).toBe("Status: busy");
  });
  it("without an inbox it still points to the app", async () => {
    const h = telegram([{ update_id: 1, message: { message_id: 1, chat, from, text: "hola" } }]);
    await h.channel.start({ signal: h.controller.signal });
    expect(String(h.sent.find((s) => s.method === "sendMessage")?.body.text)).toContain("in the app");
  });
  it("never puts the file URL in an error", async () => {
    const h = telegram([]);
    h.fetchImpl.mockImplementation(async (url: string) => (String(url).includes("/file/") ? new Response("no", { status: 404 }) : Response.json({ ok: true, result: { file_path: "voice/f.oga", file_size: 3 } })));
    const error = await h.channel.download("f").catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("SECRET");
  });
  it("refuses a file over the limit before downloading it", async () => {
    const h = telegram([]);
    h.fetchImpl.mockImplementation(async () => Response.json({ ok: true, result: { file_path: "voice/f.oga", file_size: 99 } }));
    await expect(h.channel.download("f", 10)).rejects.toThrow("too_long");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function inbox(over: Partial<Parameters<typeof createInbox>[0]> = {}) {
  const said: string[] = [];
  const calls: Record<string, unknown>[] = [];
  const box = createInbox({
    call: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { isError: false, text: "", data: { message_id: "m", duplicate: false, outcome: { kind: "for_agent" } } };
    }),
    transcribe: async () => ({ clip_id: "c", transcript: "hola" }),
    send: async (_chat, text) => { said.push(text); },
    ...over,
  });
  return { box, said, calls };
}
const text = (t: string, id = 1): ChannelMessage => ({ chatId: "5", messageId: id, lang: "es", forwarded: false, text: t });
const voice = (id = 1, seconds = 5, forwarded = false): ChannelMessage => ({ chatId: "5", messageId: id, lang: "es", forwarded, voice: { fileId: "f", seconds, bytes: 100 } });

describe("the inbox", () => {
  it("hands a text over and says nothing if the agent will answer", async () => {
    const h = inbox();
    await h.box.deliver(text("hola"));
    expect(h.calls[0]).toMatchObject({ chat_id: "5", message_id: 1, text: "hola", kind: "text", forwarded: false });
    expect(h.said).toEqual([]);
  });
  it("leaves note confirmation to Trama even if an old relay response supplies one", async () => {
    const h = inbox({ appUrl: "https://app.test", call: async () => ({ isError: false, text: "", data: { reply: "Guardado en tus notas. Para deshacer: /deshacer", outcome: { kind: "note_saved", page_id: "np" } } }) });
    await h.box.deliver(text("guarda en notas: x"));
    expect(h.said).toEqual([]);
  });
  it("stays quiet on a delivery it already saw", async () => {
    const h = inbox({ call: async () => ({ isError: false, text: "", data: { duplicate: true, reply: "no" } }) });
    await h.box.deliver(text("x"));
    expect(h.said).toEqual([]);
  });
  it("tells the person when a message did not land", async () => {
    const h = inbox({ call: async () => ({ isError: true, text: "x", data: { code: "not_linked" } }) });
    await h.box.deliver(text("x"));
    expect(h.said).toEqual(["No pude entregar tu mensaje. Inténtalo de nuevo."]);
  });
  it("echoes what it heard", async () => {
    const h = inbox();
    await h.box.deliver(voice());
    expect(h.calls[0]).toMatchObject({ kind: "voice", voice_clip_id: "c", text: "hola" });
    expect(h.said).toEqual(['Entendí: "hola"']);
  });
  it("says that a forwarded audio is a forwarded audio", async () => {
    const h = inbox();
    await h.box.deliver(voice(1, 5, true));
    expect(h.calls[0]).toMatchObject({ forwarded: true });
    expect(h.said).toEqual(['Audio reenviado: "hola"']);
  });
  it("keeps the order of one chat: a text waits for the voice note before it", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const h = inbox({ transcribe: async () => { await gate; return { clip_id: "c", transcript: "primero" }; } });
    const first = h.box.deliver(voice(1));
    const second = h.box.deliver(text("segundo", 2));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.calls).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(h.calls.map((c) => c.text)).toEqual(["primero", "segundo"]);
  });
  it("one failure does not stop the chat", async () => {
    const transcribe = vi.fn().mockRejectedValueOnce(new Error("voice_quota")).mockResolvedValue({ clip_id: "c", transcript: "ok" });
    const h = inbox({ transcribe });
    await h.box.deliver(voice(1));
    await h.box.deliver(voice(2));
    expect(h.said[0]).toContain("límite de voz");
    expect(h.said[1]).toBe('Entendí: "ok"');
  });
  it.each([["voice_too_long", "No pude"], ["budget_exceeded", "presupuesto"], ["no_ffmpeg", "convertir"], ["whatever", "No pude"]])("explains %s", async (code, words) => {
    const h = inbox({ transcribe: async () => { throw new Error(code); } });
    await h.box.deliver(voice());
    expect(h.said[0]).toContain(words);
  });
  it("refuses a long voice note before any cost", async () => {
    const transcribe = vi.fn();
    const h = inbox({ transcribe });
    await h.box.deliver(voice(1, 601));
    expect(transcribe).not.toHaveBeenCalled();
    expect(h.said[0]).toContain("10 minutos");
  });
  it("an audio that says nothing does not become a message", async () => {
    const h = inbox({ transcribe: async () => ({ clip_id: "c", transcript: "" }) });
    await h.box.deliver(voice());
    expect(h.calls).toEqual([]);
    expect(h.said).toEqual(["No escuché nada en ese audio."]);
  });
  it("a repeated voice note is not relayed", async () => {
    const h = inbox({ transcribe: async () => ({ duplicate: true }) });
    await h.box.deliver(voice());
    expect(h.calls).toEqual([]);
    expect(h.said).toEqual([]);
  });
  it("stops typing whatever happens", async () => {
    const stop = vi.fn();
    const h = inbox({ typing: () => stop, transcribe: async () => { throw new Error("failed"); } });
    await h.box.deliver(voice());
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("the voice client", () => {
  const options = { url: "http://x/voice", accessToken: async () => "t", download: async () => new Uint8Array(1), convert: async () => new Uint8Array(44) };
  const json = (body: object, status = 200) => Response.json(body, { status });
  it("sends a WAV with what the server must know", async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => json({ clip_id: "c", transcript: "hola" }));
    const out = await createVoiceClient({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch })(voice(9, 5, true));
    expect(out).toEqual({ clip_id: "c", transcript: "hola" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/voice?channel=telegram&chat_id=5&message_id=9&forwarded=1&lang=es");
    expect(init.headers).toMatchObject({ Authorization: "Bearer t", "Content-Type": "audio/wav" });
  });
  it("gets a fresh token once on a 401", async () => {
    const accessToken = vi.fn(async (fresh?: boolean) => (fresh ? "new" : "old"));
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (...[, init]) => ((init?.headers as Record<string, string>).Authorization === "Bearer new" ? json({ transcript: "ok" }) : json({ error: "unauthorized" }, 401)));
    expect(await createVoiceClient({ ...options, accessToken, fetchImpl: fetchImpl as unknown as typeof fetch })(voice())).toEqual({ transcript: "ok" });
  });
  it("waits once when the provider is busy", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "voice_busy" }, 503)).mockResolvedValueOnce(json({ error: "voice_busy" }, 503)).mockResolvedValueOnce(json({ transcript: "ok" }));
    expect(await createVoiceClient({ ...options, retryMs: 1, fetchImpl: fetchImpl as unknown as typeof fetch })(voice())).toEqual({ transcript: "ok" });
  });
  it("gives the server's code to the inbox", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "voice_quota" }, 429));
    await expect(createVoiceClient({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch })(voice())).rejects.toThrow("voice_quota");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.runIf(hasFfmpeg)("ffmpeg refuses what is not Ogg", async () => {
    await expect(oggToWav(new TextEncoder().encode("#EXTM3U\nfile:///etc/passwd\n"))).rejects.toThrow("failed");
  });
  it("a host with no ffmpeg says so", async () => {
    await expect(oggToWav(new Uint8Array(1), { ffmpeg: "no-such-binary-here" })).rejects.toThrow("no_ffmpeg");
  });
});

it("webhook transport acknowledges only after successful inbox delivery and never polls Telegram", async () => {
  const stop = new AbortController();
  const fetchImpl = vi.fn(async () => { throw new Error("getUpdates must not run"); });
  let delivered = false;
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (args.ack_update_id) { expect(delivered).toBe(true); stop.abort(); return { updates: [] }; }
    return { updates: [{ update_id: 4, message: { message_id: 8, chat, from, text: "hello" } }] };
  });
  const channel = createTelegramChannel({ token: "fake", ownerChatId: "5", transport: "webhook", channelRpc: call, fetchImpl });
  await channel.start({ signal: stop.signal, onMessage: async (m) => { expect(m.text).toBe("hello"); delivered = true; } });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(call).toHaveBeenLastCalledWith("take_channel_updates", { ack_update_id: 4 });
});

it.each([
  { chat: { id: -10, type: "group" }, from: { id: 5 } },
  { chat: { id: 5, type: "private" }, from: { id: 6 } },
])("polling status does not reveal person work to an unverified sender: %j", async (sender) => {
  const stop = new AbortController(); let first = true;
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("getUpdates") && first) { first = false; return Response.json({ ok: true, result: [{ update_id: 1, message: { message_id: 1, ...sender, text: "/status" } }] }); }
    stop.abort(); return Response.json({ ok: true, result: [] });
  });
  const call = vi.fn(async () => ({ running_work: [] }));
  const channel = createTelegramChannel({ token: "fake", ownerChatId: String(sender.chat.id), fetchImpl, channelRpc: call });
  await channel.start({ signal: stop.signal });
  expect(call).not.toHaveBeenCalled();
});
