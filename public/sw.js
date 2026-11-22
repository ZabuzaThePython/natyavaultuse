/**
 * NatyaVault service worker.
 *
 * Its only jobs are the two a page cannot do while closed: receive a push
 * from the deployment and show the notification, then open the right chat when
 * it is tapped. It deliberately does not cache anything, so a redeploy can
 * never serve a stale app.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === "string" ? payload.title : "NatyaVault";
  const body =
    typeof payload.body === "string" ? payload.body : "New message in your chat.";
  const url = typeof payload.url === "string" ? payload.url : "/dashboard/messages";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag:
        typeof payload.tag === "string"
          ? payload.tag
          : payload.chatId
            ? `chat-${payload.chatId}`
            : "natyavault",
      renotify: true,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    event.notification.data?.url || "/dashboard/messages",
    self.location.origin,
  ).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (!client.url.startsWith(self.location.origin)) continue;
        await client.focus();
        try {
          await client.navigate(target);
        } catch {
          // An old browser may refuse navigate(); focus is still useful.
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
