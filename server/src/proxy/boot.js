// Boot page of a web tunnel (proxy origin): installs the service worker, then asks the
// Excalibash page that opened or embeds us for the tunnel key. The key never goes into a URL.
"use strict";

const MAIN_ORIGIN = "__MAIN_ORIGIN__";
const status = document.getElementById("status");
const say = (t) => (status.textContent = t);
const id = (location.pathname.match(/^\/t\/([A-Za-z0-9_-]{16,43})/) || [])[1];

(async () => {
  if (!id) return say("Lien de tunnel invalide.");
  if (!("serviceWorker" in navigator)) return say("Ce navigateur ne permet pas les tunnels chiffrés (Service Worker indisponible).");
  await navigator.serviceWorker.register("/eb-proxy/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  }
  const peer = window.opener || (window.parent !== window ? window.parent : null);
  if (!peer) return say("Ouvre ce site depuis son tableau Excalibash (la clé de chiffrement vient de là).");

  let done = false;
  window.addEventListener("message", (e) => {
    if (done || e.origin !== MAIN_ORIGIN || !e.data || e.data.type !== "eb-proxy-key" || e.data.tunnelId !== id) return;
    done = true;
    say("Déchiffrement…");
    navigator.serviceWorker.addEventListener("message", (m) => {
      if (m.data && m.data.type === "key-ok" && m.data.tunnelId === id) {
        try {
          window.opener = null; // the site must not get a handle on Excalibash
        } catch {
          /* not an opened tab */
        }
        location.reload();
      }
    });
    navigator.serviceWorker.controller.postMessage({ type: "key", tunnelId: id, key: e.data.key, target: e.data.target });
  });
  say("Connexion sécurisée au tunnel…");
  // The opener may still be attaching its listener: ask a few times.
  for (let i = 0; i < 40 && !done; i++) {
    peer.postMessage({ type: "eb-proxy-ready", tunnelId: id }, MAIN_ORIGIN);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!done) say("Pas de réponse d'Excalibash : rouvre ce site depuis le tableau.");
})().catch((e) => say(`Erreur : ${e.message}`));
