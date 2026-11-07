importScripts("/vendor/scramjet/scramjet.all.js");
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname.startsWith("/p/")) {
    event.respondWith(
      (async () => {
        await scramjet.loadConfig();
        const response = await scramjet.fetch(event);
        const result = new Response(response.body, response);
        result.headers.set("cache-control", "no-store");
        return result;
      })(),
    );
  }
});
