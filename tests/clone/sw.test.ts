import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Run the service worker with fake clients, notifications and network access.
const source = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");

interface Shown {
  title: string;
  options: {
    body: string;
    tag: string;
    data: { url: string; id?: string; kind?: string };
    actions?: { action: string; title: string }[];
    requireInteraction?: boolean;
  };
}
interface FakeEvent {
  data?: { json: () => unknown; text: () => string };
  notification?: { data: unknown; close: () => void };
  action?: string;
  waitUntil: (p: Promise<unknown>) => void;
}

function load(opts: { visible?: boolean; existingWindow?: boolean } = {}) {
  const listeners = new Map<string, (event: FakeEvent) => void>();
  const shown: Shown[] = [];
  const messages: unknown[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const fetched: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const focus = vi.fn(async () => undefined);
  const windows = opts.visible || opts.existingWindow ? [{
    visibilityState: opts.visible ? "visible" : "hidden",
    postMessage: (message: unknown) => void messages.push(message),
    focus,
    navigate: async (url: string) => void navigated.push(url),
  }] : [];
  const self = {
    location: { origin: "https://colabora.si" },
    addEventListener: (type: string, fn: (event: FakeEvent) => void) => void listeners.set(type, fn),
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
    registration: {
      showNotification: async (title: string, options: Shown["options"]) => void shown.push({ title, options }),
    },
  };
  const fakeFetch = (...args: unknown[]) => {
    fetched.push(args);
    return Promise.reject(new Error("the service worker has no session"));
  };
  new Function("self", "fetch", source)(self, fakeFetch);
  const fire = async (type: string, event: Omit<FakeEvent, "waitUntil">) => {
    listeners.get(type)?.({ ...event, waitUntil: (p) => void pending.push(p) });
    await Promise.all(pending.splice(0));
  };
  return {
    shown, messages, opened, navigated, fetched, focus,
    push: (payload: unknown) => fire("push", { data: { json: () => payload, text: () => JSON.stringify(payload) } }),
    click: (data: unknown, action = "") => fire("notificationclick", { notification: { data, close: () => undefined }, action }),
  };
}

const approvalPush = {
  id: "notification:n1", kind: "approval_requested", title: "Approval needed: Weekly summary",
  body: "Send an email to team@example.com", url: "/p/row-1?task=t1#approval-ap1",
};

describe("push service worker", () => {
  it("shows an approval with a button that opens the decision and stays until handled", async () => {
    const sw = load();
    await sw.push(approvalPush);
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe("Approval needed: Weekly summary");
    expect(sw.shown[0].options).toMatchObject({
      body: "Send an email to team@example.com", tag: "agent-notification:n1",
      data: { url: "/p/row-1?task=t1#approval-ap1", id: "notification:n1", kind: "approval_requested" },
      actions: [{ action: "decide", title: "Review and decide" }], requireInteraction: true,
    });
  });
  it("names each button by what it opens and ignores inherited action-map keys", async () => {
    const sw = load();
    for (const kind of ["input_required", "ready_for_review", "task_failed"]) {
      await sw.push({ ...approvalPush, id: kind, kind });
    }
    expect(sw.shown.map((s) => [s.options.actions, s.options.requireInteraction])).toEqual([
      [[{ action: "answer", title: "Answer" }], false],
      [[{ action: "review", title: "Review" }], false],
      [[], false],
    ]);
    for (const kind of ["constructor", "__proto__", "toString"]) {
      await sw.push({ ...approvalPush, kind });
      expect(sw.shown.at(-1)?.options).toMatchObject({ actions: [], requireInteraction: false });
    }
  });
  it("leaves agent notifications to the inbox when the app is visible", async () => {
    const sw = load({ visible: true });
    for (const kind of ["approval_requested", "input_required", "ready_for_review", "task_failed"]) {
      await sw.push({ ...approvalPush, kind });
    }
    expect(sw.shown).toEqual([]);
    expect(sw.messages).toEqual([]);
  });
  it("keeps reminders as they were", async () => {
    const visible = load({ visible: true });
    await visible.push({ id: "r1", title: "Reminder", body: "Call Ana", url: "/p/page-1" });
    expect(visible.messages).toEqual([
      { type: "reminder-push", reminder: { id: "r1", title: "Reminder", body: "Call Ana", url: "/p/page-1" } },
    ]);
    const hidden = load();
    await hidden.push({ id: "r1", title: "Reminder", body: "Call Ana", url: "/p/page-1" });
    expect(hidden.shown[0].options).toMatchObject({ tag: "reminder-r1", data: { url: "/p/page-1", id: "r1" } });
    expect(hidden.shown[0].options.actions).toBeUndefined();
  });
  it("opens the same deep link from the body and every button, and never another origin", async () => {
    for (const existingWindow of [false, true]) {
      const sw = load({ existingWindow });
      for (const action of ["", "decide", "answer", "review"]) {
        await sw.click({ url: approvalPush.url }, action);
      }
      for (const url of ["https://evil.example/p/x", "//evil.example/p/x", "javascript:alert(1)"]) {
        await sw.click({ url }, "decide");
      }
      const expected = [
        ...Array<string>(4).fill("https://colabora.si/p/row-1?task=t1#approval-ap1"),
        ...Array<string>(3).fill("https://colabora.si/"),
      ];
      expect(sw.opened).toEqual(existingWindow ? [] : expected);
      expect(sw.navigated).toEqual(existingWindow ? expected : []);
      expect(sw.focus).toHaveBeenCalledTimes(existingWindow ? expected.length : 0);
    }
  });
  it("never reaches the network on a push or tap, so a signed-out phone cannot approve anything", async () => {
    const sw = load();
    for (const kind of ["approval_requested", "input_required", "ready_for_review", "task_failed"]) {
      await sw.push({ ...approvalPush, kind });
      for (const action of ["", "decide", "answer", "review"]) {
        await sw.click({ url: approvalPush.url }, action);
      }
    }
    expect(sw.fetched).toEqual([]);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/decide_approval|rpc\//);
  });
});
