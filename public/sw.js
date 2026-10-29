/*
 * Push service worker for reminders and agent notifications.
 *
 * Registered by lib/push.ts when the user enables reminders. The
 * send-reminders edge function sends encrypted JSON payloads:
 *   reminders: { id, title, body, url }
 *   agents: { id, kind, title, body, url }, where kind is approval_requested,
 *     input_required, ready_for_review or task_failed.
 *
 * Visible app windows receive reminders by message; agent notifications
 * stay in the inbox. Buttons only open the decision in the app: this worker
 * has no session and never approves, answers or sends anything.
 */

const AGENT_ACTIONS = {
  approval_requested: [{ action: "decide", title: "Review and decide" }],
  input_required: [{ action: "answer", title: "Answer" }],
  ready_for_review: [{ action: "review", title: "Review" }],
};

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const visible = windows.some((c) => c.visibilityState === "visible");

  if (typeof data.kind === "string" && data.kind) {
    if (visible) return;
    await self.registration.showNotification(data.title || "colabora.si", {
      body: data.body || "",
      icon: "/favicon.ico",
      tag: data.id ? `agent-${data.id}` : "agent",
      data: { url: data.url || "/", id: data.id, kind: data.kind },
      actions: Object.prototype.hasOwnProperty.call(AGENT_ACTIONS, data.kind) ? AGENT_ACTIONS[data.kind] : [],
      requireInteraction: data.kind === "approval_requested",
    });
    return;
  }

  if (visible) {
    for (const c of windows) {
      c.postMessage({ type: "reminder-push", reminder: data });
    }
    return;
  }

  await self.registration.showNotification(data.title || "Reminder", {
    body: data.body || "Reminder",
    icon: "/favicon.ico",
    // Repeated pushes of the same reminder collapse into one notification.
    tag: data.id ? `reminder-${data.id}` : "reminder",
    data: { url: data.url || "/", id: data.id },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // The body and every button open the same deep link; the decision happens in the app, with a session.
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(openPage(url));
});

async function openPage(url) {
  let target = new URL(url, self.location.origin);
  if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if ("focus" in client) {
      await client.focus();
      if ("navigate" in client) {
        try {
          await client.navigate(target.href);
        } catch {
          /* cross-origin or unsupported: the window stays focused */
        }
      }
      return;
    }
  }
  await self.clients.openWindow(target.href);
}
