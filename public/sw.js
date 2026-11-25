"use strict";
// Keeps the app shell available so the icon opens instantly. Game traffic runs over the
// WebSocket and is never cached. Files are fetched fresh when online, so updates arrive on their own.
const VERSION = "oowl-v2";
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/qr.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin || u.pathname === "/healthz") return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(r, copy));
        }
        return res;
      })
      .catch(() => caches.match(r).then((hit) => hit || caches.match("/index.html")))
  );
});
