/*
 * Service worker de notificaciones push de recordatorios.
 *
 * Lo registra lib/push.ts cuando el usuario activa los recordatorios. La
 * carga la envía la función edge `send-reminders` como JSON cifrado:
 *   { id, title, body, url }
 *
 * Si una ventana de la app está visible, el recordatorio se entrega a la
 * página en lugar de mostrar una notificación del sistema: la campana
 * renderiza su toast in-app y ambos caminos se deduplican por id.
 */

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

  if (visible) {
    for (const c of windows) {
      c.postMessage({ type: "reminder-push", reminder: data });
    }
    return;
  }

  await self.registration.showNotification(data.title || "Reminder", {
    body: data.body || "Reminder",
    icon: "/favicon.ico",
    // agrupa repeticiones del mismo recordatorio en una sola notificación
    tag: data.id ? `reminder-${data.id}` : "reminder",
    data: { url: data.url || "/", id: data.id },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(openPage(url));
});

async function openPage(url) {
  const target = new URL(url, self.location.origin).href;
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if ("focus" in client) {
      await client.focus();
      if ("navigate" in client) {
        try {
          await client.navigate(target);
        } catch {
          /* cross-origin o no soportado: la ventana queda enfocada igual */
        }
      }
      return;
    }
  }
  await self.clients.openWindow(target);
}
