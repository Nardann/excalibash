// Excalibash web-tunnel service worker (runs on the proxy origin, never on Excalibash's own).
// Every request of a tunnelled site is encrypted here with the tunnel key, relayed by the server
// to the agent, and the encrypted answer is decrypted back here. The server sees neither.
/* global self, clients, indexedDB, crypto */
"use strict";

const MAIN_ORIGIN = "__MAIN_ORIGIN__";
const ID = /^[A-Za-z0-9_-]{16,43}$/;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- tiny crypto (same formats as the app: box = 0x01 ‖ iv ‖ AES-256-GCM) -------------

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function box(key, pt, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, pt));
  const out = new Uint8Array(13 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return b64(out);
}

async function unbox(key, data, aad) {
  const b = unb64(data);
  if (b[0] !== 1) throw new Error("bad box");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(1, 13), additionalData: enc.encode(aad) }, key, b.subarray(13)));
}

// ---- tunnel keys and cookie jars (IndexedDB of the proxy origin) ----------------------

const db = new Promise((resolve, reject) => {
  const r = indexedDB.open("excalibash-proxy", 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("tunnels");
    r.result.createObjectStore("cookies");
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const idb = async (store, mode, fn) => {
  const d = await db;
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

const tunnels = new Map(); // id -> { key: CryptoKey, target: URL }

async function getTunnel(id) {
  if (tunnels.has(id)) return tunnels.get(id);
  const saved = await idb("tunnels", "readonly", (s) => s.get(id));
  if (!saved) return null;
  const t = { key: await crypto.subtle.importKey("raw", unb64(saved.key), "AES-GCM", false, ["encrypt", "decrypt"]), target: new URL(saved.target) };
  tunnels.set(id, t);
  return t;
}

async function cookiesOf(id) {
  return (await idb("cookies", "readonly", (s) => s.get(id))) || {};
}

async function storeCookies(id, setCookies) {
  if (!setCookies.length) return;
  const jar = await cookiesOf(id);
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const expired = attrs.some((a) => {
      const [k, v] = a.trim().split("=");
      if (/^max-age$/i.test(k)) return Number(v) <= 0;
      if (/^expires$/i.test(k)) return Date.parse(v) < Date.now();
      return false;
    });
    if (expired) delete jar[name];
    else jar[name] = value;
  }
  await idb("cookies", "readwrite", (s) => s.put(jar, id));
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Keys arrive from the boot page, which got them from Excalibash by postMessage.
self.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.type !== "key" || !ID.test(m.tunnelId)) return;
  e.waitUntil(
    (async () => {
      await idb("tunnels", "readwrite", (s) => s.put({ key: m.key, target: m.target }, m.tunnelId));
      tunnels.delete(m.tunnelId);
      e.source && e.source.postMessage({ type: "key-ok", tunnelId: m.tunnelId });
    })(),
  );
});

// ---- routing ----------------------------------------------------------------------------

const clientTunnel = new Map(); // clientId -> tunnel id

function prefixed(url) {
  const m = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
  return m && ID.test(m[1]) ? { id: m[1], path: (m[2] || "/") + url.search } : null;
}

async function tunnelOf(e, url) {
  const p = prefixed(url);
  if (p) return p;
  // An absolute path used by the site: it belongs to the tunnel of the page that asked.
  let id = e.clientId && clientTunnel.get(e.clientId);
  if (!id && e.clientId) {
    const c = await self.clients.get(e.clientId);
    if (c) id = prefixed(new URL(c.url))?.id;
  }
  if (!id && e.request.referrer) id = prefixed(new URL(e.request.referrer))?.id;
  return id ? { id, path: url.pathname + url.search, unprefixed: true } : null;
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "cookie"]);

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/eb-proxy/")) return;
  e.respondWith(handle(e, url));
});

async function handle(e, url) {
  const route = await tunnelOf(e, url);
  if (!route) return fetch(e.request); // boot page
  // Keep navigations under /t/<id>/ so every page knows its tunnel.
  if (route.unprefixed && e.request.mode === "navigate") return Response.redirect(`/t/${route.id}${route.path}`, 302);
  const t = await getTunnel(route.id);
  if (!t) return fetch(e.request); // no key yet: the boot page will fetch it
  if (e.request.mode === "navigate" && e.resultingClientId) clientTunnel.set(e.resultingClientId, route.id);

  const headers = {};
  for (const [k, v] of e.request.headers) if (!HOP.has(k)) headers[k] = [v];
  const jar = await cookiesOf(route.id);
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers.cookie = [cookie];
  // The site sees itself, not the proxy origin.
  if (headers.origin) headers.origin = [t.target.origin];
  if (headers.referer) headers.referer = [headers.referer[0].replace(new RegExp(`^${self.location.origin}/t/${route.id}`), t.target.origin)];
  const body = ["GET", "HEAD"].includes(e.request.method) ? new Uint8Array() : new Uint8Array(await e.request.arrayBuffer());

  const rid = b64(crypto.getRandomValues(new Uint8Array(16)));
  const ts = Date.now();
  const d = await box(t.key, enc.encode(JSON.stringify({ m: e.request.method, p: route.path, h: headers, b: b64(body) })), `eb:http-req:${route.id}:${rid}:${ts}`);
  let reply;
  try {
    const r = await fetch(`/eb-proxy/req/${route.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid, ts, d }) });
    if (!r.ok) return errorPage(r.status === 404 ? "Ce tunnel n'existe plus." : "La machine est hors ligne ou ne répond pas.");
    reply = await r.json();
  } catch {
    return errorPage("Impossible de joindre Excalibash.");
  }
  let res;
  try {
    res = JSON.parse(dec.decode(await unbox(t.key, reply.d, `eb:http-res:${route.id}:${rid}`)));
  } catch {
    return errorPage("Réponse refusée : elle n'est pas authentique.");
  }

  const out = new Headers();
  const setCookies = [];
  for (const [k, vs] of Object.entries(res.h || {})) {
    const lk = k.toLowerCase();
    if (lk === "set-cookie") setCookies.push(...vs);
    else if (lk === "x-frame-options" || lk === "content-encoding" || lk === "content-length") continue;
    else if (lk === "location") out.set(k, rewriteLocation(vs[0], route.id, t.target));
    else if (lk === "content-security-policy") out.set(k, vs.map((v) => v.replace(/frame-ancestors[^;]*;?/gi, "")).join(", "));
    else for (const v of vs) out.append(k, v);
  }
  await storeCookies(route.id, setCookies);
  // Only Excalibash may frame a tunnelled page.
  if (e.request.mode === "navigate") out.append("Content-Security-Policy", `frame-ancestors 'self' ${MAIN_ORIGIN}`);
  const status = res.s >= 200 && res.s <= 599 ? res.s : 502;
  const noBody = e.request.method === "HEAD" || [204, 205, 304].includes(status);
  return new Response(noBody ? null : unb64(res.b), { status, headers: out });
}

function rewriteLocation(loc, id, target) {
  try {
    const u = new URL(loc, target);
    if (u.origin !== target.origin) return loc;
    return `/t/${id}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return loc;
  }
}

function errorPage(text) {
  const html = `<!doctype html><meta charset="utf-8"><title>Excalibash</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0b1020;color:#e2e8f0"><p>${text.replace(/</g, "&lt;")}</p>`;
  return new Response(html, { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
}
