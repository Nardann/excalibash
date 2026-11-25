// End-to-end: two users, nested shared folders, encrypted collab + terminal, revoke + rotation,
// third user / admin cannot read. Uses the real web crypto + library code against the real server/agent.
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import WebSocket from "../server/node_modules/ws/index.js";
import * as c from "../web/src/crypto.ts";
import * as lib from "../web/src/library.tsx";
import { solveChallenge } from "../web/src/pow.ts";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createMachine } from "../web/src/vault.ts";
import { encryptEntry, decryptEntry } from "../web/src/board/boardCrypto.ts";

const BASE = process.env.BASE ?? "http://127.0.0.1:6797";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:6799";
const DB = process.env.DB!;
const realFetch = globalThis.fetch;
const jar = { current: "" };
globalThis.fetch = (async (url: string, init: any = {}) => {
  const r = await realFetch(BASE + url, { ...init, headers: { ...(init.headers ?? {}), cookie: jar.current } });
  const sc = r.headers.get("set-cookie");
  if (sc) jar.current = sc.split(";")[0];
  return r;
}) as any;

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`/api${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined } as any);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j as any };
}

type U = { user: any; keys: c.KeyPair; cookie: string; recovery: string };

const pow = async () => solveChallenge((await api("GET", "/auth/challenge")).body);

/** Last verification code emailed to `email`, read from the server log (SMTP_TRANSPORT=log). */
function mailCode(email: string): string {
  const lines = readFileSync(`${dirname(DB)}/server.log`, "utf8").split("\n").filter((l) => l.startsWith(`[mail] to=${email} `));
  return lines.at(-1)?.match(/code=(\d{6})/)?.[1] ?? "";
}

/** Subjects of the emails sent to `email`, read from the server log. */
function mails(email: string): string[] {
  return readFileSync(`${dirname(DB)}/server.log`, "utf8")
    .split("\n")
    .filter((l) => l.startsWith(`[mail] to=${email} `))
    .map((l) => l.match(/subject=(.*) code=/)?.[1] ?? "");
}

/** Setup code the server prints while it has no account. */
function setupCode(): string {
  return readFileSync(`${dirname(DB)}/server.log`, "utf8").match(/Code d'installation[^:]*: ([A-Z0-9-]+)/)?.[1] ?? "";
}

async function register(email: string, name: string, password: string, invite?: string, setup?: string): Promise<U> {
  jar.current = "";
  const id = c.randomId();
  const salt = c.toB64(c.randomBytes(16));
  const { authKey, masterKey } = await c.deriveAccountKeys(password, salt);
  const kp = await c.generateKeyPair();
  const rraw = c.randomBytes(32);
  const rec = await c.recoveryKeys(rraw);
  const r = await api("POST", "/auth/register", {
    pow: await pow(), website: "",
    id, email, name, invite, setupCode: setup, salt, authKey,
    publicKey: c.toB64(kp.pub),
    encPrivateKey: await c.box(masterKey, kp.pkcs8, c.AAD.priv(id)),
    recoveryEncPrivateKey: await c.box(rec.recoveryEnc, kp.pkcs8, c.AAD.priv(id)),
    recoveryAuth: rec.recoveryAuth,
  });
  if (r.status !== 200) throw new Error(`register ${email}: ${JSON.stringify(r.body)}`);
  let user = r.body.user;
  if (r.body.needsVerification) {
    const v = await api("POST", "/auth/verify", { email, code: mailCode(email) });
    if (v.status !== 200) throw new Error(`verify ${email}: ${JSON.stringify(v.body)}`);
    user = v.body.user;
  }
  return { user, keys: { priv: await c.importPrivateKey(kp.pkcs8), pub: kp.pub }, cookie: jar.current, recovery: c.formatRecoveryKey(rraw) };
}

async function as<T>(u: U, fn: () => Promise<T>): Promise<T> {
  jar.current = u.cookie;
  return fn();
}

async function tree(u: U) {
  return as(u, async () => {
    const r = await api("GET", "/tree");
    // Re-use the provider's decryption by calling the same logic through a tiny shim.
    const nodes: Map<string, lib.Node> = await lib.decryptTree(u.user, u.keys, r.body.items, r.body.grants);
    return nodes;
  });
}

const ctxOf = (u: U, nodes: Map<string, lib.Node>) => ({ user: u.user, keys: u.keys, nodes });

function boardSocket(u: U, boardId: string) {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?board=${boardId}`, { headers: { cookie: u.cookie } });
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (raw: any) => {
    const m = JSON.parse(raw.toString());
    const w = waiters.findIndex(() => true);
    queue.push(m);
    waiters.splice(0).forEach((f) => f(m));
  });
  const next = (pred: (m: any) => boolean, ms = 6000) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
      const check = () => {
        const i = queue.findIndex(pred);
        if (i >= 0) {
          clearTimeout(t);
          resolve(queue.splice(i, 1)[0]);
          return true;
        }
        return false;
      };
      if (check()) return;
      const loop = () => {
        if (!check()) waiters.push(loop);
      };
      waiters.push(loop);
    });
  const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
  return { ws, next, closed, open: new Promise((r) => ws.on("open", r)), send: (m: object) => ws.send(JSON.stringify(m)) };
}

const gens = new Map<string, string>();

async function termOutput(sock: ReturnType<typeof boardSocket>, kt: c.SymKey, tid: string, needle: string) {
  let acc = "";
  for (let i = 0; i < 50; i++) {
    const m = await sock.next((x) => x.t === "term.data" && x.id === tid, 8000);
    acc += c.fromUtf8(await c.unbox(kt, m.d, c.AAD.termOut(tid, m.gen, m.seq)));
    gens.set(tid, m.gen);
    if (acc.includes(needle)) return acc;
  }
  return acc;
}

/** Subscribes and learns the current gen (from the replay or the agent's announce). */
async function subscribe(sock: ReturnType<typeof boardSocket>, tid: string) {
  sock.send({ t: "term.sub", id: tid });
  const r = await sock.next((x) => x.t === "term.replay" && x.id === tid);
  if (r.chunks.length) gens.set(tid, r.chunks.at(-1).gen);
  else gens.set(tid, (await sock.next((x) => x.t === "term.data" && x.id === tid)).gen);
}

let counter = 0;
async function sendInput(sock: ReturnType<typeof boardSocket>, kt: c.SymKey, tid: string, s: string, text: string) {
  const k = ++counter;
  const ts = Date.now();
  const gen = gens.get(tid)!;
  const frame = { t: "term.input", id: tid, s, k, ts, d: await c.box(kt, c.utf8(text), c.AAD.termIn(tid, gen, s, k, ts)) };
  sock.send(frame);
  return frame;
}

// ---------------------------------------------------------------------------------------

const badCode = await register("mallory@test.local", "Mallory", "mallory-password-1", undefined, "AAAA-AAAA").then(() => true, () => false);
ok(!badCode, "sans le bon code d'installation, personne ne peut prendre le premier compte (admin)");
const alice = await register("alice@test.local", "Alice", "alice-password-1", undefined, setupCode());
ok(alice.user.isAdmin, "le premier compte, créé avec le code d'installation, est admin");
const unknownTunnel = await realFetch(`${PROXY}/eb-proxy/req/${c.randomId()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid: "x", ts: Date.now(), d: "x".repeat(1_000_000) }) });
ok(unknownTunnel.status === 404, "un tunnel inconnu est refusé avant la lecture du corps");

// Alice: F / S / B (nested), with one encrypted element on B.
let nA = await tree(alice);
const F = await lib.createItem(ctxOf(alice, nA), "folder", null, "Projet secret");
nA = await tree(alice);
const S = await lib.createItem(ctxOf(alice, nA), "folder", F, "Sous-dossier infra");
nA = await tree(alice);
const rect = { id: "rect1", type: "rectangle", version: 3, versionNonce: 111, x: 0, y: 0, width: 10, height: 10, isDeleted: false, label: "TOP_SECRET_DIAGRAM" };
const B = await lib.createItem(ctxOf(alice, nA), "board", S, "Tableau confidentiel", { elements: [rect], files: {} });
nA = await tree(alice);
ok(nA.get(B)?.name === "Tableau confidentiel", "Alice déchiffre le nom du tableau imbriqué");

// Machine + agent.
const machine = await as(alice, () => createMachine(alice.keys, "laptop-alice"));
const agent = spawn(new URL(`../agent/dist/excalibash-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`, import.meta.url).pathname, ["--server", BASE], {
  env: { ...process.env, EXCALIBASH_TOKEN: machine.token, EXCALIBASH_KEY: machine.privateKey },
  stdio: ["ignore", "ignore", "pipe"],
});
let agentLog = "";
agent.stderr.on("data", (d) => (agentLog += d));
await new Promise((r) => setTimeout(r, 1200));
ok(agentLog.includes(machine.fingerprint), "l'agent affiche la même empreinte que le navigateur");

// Bob + share F.
await as(alice, () => api("PATCH", "/admin/settings", { registrationOpen: true }));
const bob = await register("bob@test.local", "Bob", "bob-password-12");
// Anti-bot and email verification (registrations are open here).
{
  const noPow = await api("POST", "/auth/register", { email: "x@test.local", name: "X" });
  ok(noPow.status === 400 && /anti-robot/.test(noPow.body.error), "inscription sans preuve de travail refusée");
  const trap = await api("POST", "/auth/register", { pow: await pow(), website: "http://spam", email: "x@test.local", name: "X" });
  ok(trap.status === 400, "champ piège rempli refusé");
  const badSig = await api("POST", "/auth/register", { pow: { ...(await pow()), signature: "00" }, website: "", email: "x@test.local", name: "X" });
  ok(badSig.status === 400, "signature de défi invalide refusée");

  const id = c.randomId();
  const b64 = "AAAAAAAAAAAAAAAA";
  const dave = "dave@test.local";
  jar.current = "";
  const usedPow = await pow();
  const reg = await api("POST", "/auth/register", {
    pow: usedPow, website: "", id, email: dave, name: "Dave", salt: b64, authKey: b64,
    publicKey: b64, encPrivateKey: b64, recoveryEncPrivateKey: b64, recoveryAuth: b64,
  });
  ok(reg.status === 200 && reg.body.needsVerification && !reg.body.user && !jar.current, "inscription : en attente de vérification, sans session");
  const replay = await api("POST", "/auth/register", { pow: usedPow, website: "", email: "x@test.local", name: "X" });
  ok(replay.status === 400 && /anti-robot/.test(replay.body.error), "preuve de travail rejouée refusée");
  const dup = await api("POST", "/auth/register", {
    pow: await pow(), website: "", id: c.randomId(), email: dave, name: "Dave", salt: b64, authKey: b64,
    publicKey: b64, encPrivateKey: b64, recoveryEncPrivateKey: b64, recoveryAuth: b64,
  });
  ok(dup.status === 409 && /renvoyer/i.test(dup.body.error), "email non vérifié déjà inscrit : 409 avec invitation à renvoyer le code");
  const early = await api("POST", "/auth/login", { email: dave, authKey: b64 });
  ok(early.status === 403 && early.body.code === "EMAIL_NOT_VERIFIED", "connexion avant vérification : EMAIL_NOT_VERIFIED");
  const code = mailCode(dave);
  ok(/^\d{6}$/.test(code), "un code à 6 chiffres est envoyé par email");
  const wrong = await api("POST", "/auth/verify", { email: dave, code: code === "000000" ? "111111" : "000000" });
  ok(wrong.status === 400 && !jar.current, "mauvais code refusé");
  const resend = await api("POST", "/auth/resend", { email: dave });
  const ghost = await api("POST", "/auth/resend", { email: "personne@test.local" });
  ok(resend.status === 200 && ghost.status === 200 && JSON.stringify(resend.body) === JSON.stringify(ghost.body), "renvoi du code : même réponse si le compte existe ou non");
  const oldCode = await api("POST", "/auth/verify", { email: dave, code });
  ok(oldCode.status === 400 || mailCode(dave) === code, "un code remplacé n'est plus accepté");
  const good = await api("POST", "/auth/verify", { email: dave, code: mailCode(dave) });
  ok(good.status === 200 && good.body.user?.email === dave && !!jar.current, "bon code accepté : session ouverte");
  const after = await api("POST", "/auth/login", { email: dave, authKey: b64 });
  ok(after.status === 200, "connexion possible après vérification");
}
await as(alice, () => api("PATCH", "/admin/settings", { registrationOpen: false }));
// Findable by name (default) and by email (off by default); a hidden account answers like a missing one.
{
  const look = (q: string) => as(alice, () => api("GET", `/auth/lookup?q=${encodeURIComponent(q)}`));
  const settings = (await as(bob, () => api("GET", "/account"))).body;
  ok(settings.findableName === true && settings.findableEmail === false, "visibilité par défaut : trouvable par nom, pas par email");
  const byName = await look("bob");
  ok(byName.status === 200 && byName.body.users.length === 1 && byName.body.users[0].id === bob.user.id, "recherche par nom (insensible à la casse) : Bob trouvé");
  ok(!("email" in byName.body.users[0]), "la recherche par nom ne renvoie pas l'email");
  ok((await look("Bo")).body.users.some((u: any) => u.id === bob.user.id), "recherche par préfixe du nom");
  ok((await look("b")).body.users.length === 0, "recherche par nom : 2 caractères minimum");
  ok((await look("alice")).body.users.length === 0, "la recherche par nom exclut soi-même");
  const hidden = await look("bob@test.local");
  const missing = await look("personne@test.local");
  ok(hidden.status === 404 && JSON.stringify(hidden.body) === JSON.stringify(missing.body), "email non trouvable : même réponse qu'un compte inexistant");
  await as(bob, () => api("PUT", "/account/visibility", { findableName: false, findableEmail: false }));
  ok((await look("bob")).body.users.length === 0, "compte non trouvable par nom : absent des résultats");
  ok((await as(bob, () => api("GET", "/account"))).body.findableName === false, "le réglage de visibilité est enregistré");
  await as(bob, () => api("PUT", "/account/visibility", { findableName: true, findableEmail: true }));
  const byMail = await look("bob@test.local");
  ok(byMail.status === 200 && byMail.body.users[0]?.email === "bob@test.local", "email trouvable une fois activé, et renvoyé");
  ok((await as(bob, () => api("PUT", "/account/visibility", { findableName: true }))).status === 400, "réglages de visibilité invalides refusés");
}
// SMTP status and test email (admin), email notifications (all off by default).
{
  const status = await as(alice, () => api("GET", "/admin/smtp"));
  ok(status.status === 200 && status.body.mode === "log" && !JSON.stringify(status.body).match(/pass/i), "admin : état du SMTP (mode log), sans mot de passe");
  ok((await as(bob, () => api("GET", "/admin/smtp"))).status === 403, "état du SMTP réservé aux admins");
  ok((await as(bob, () => api("POST", "/admin/smtp/test", {}))).status === 403, "email de test réservé aux admins");
  ok((await as(alice, () => api("POST", "/admin/smtp/test", { to: "pas-un-email" }))).status === 400, "email de test : adresse invalide refusée");
  const test = await as(alice, () => api("POST", "/admin/smtp/test", {}));
  ok(test.status === 200 && mails("alice@test.local").some((m) => m.startsWith("Test d'envoi")), "email de test envoyé à l'admin par défaut");
  const acc = (await as(bob, () => api("GET", "/account"))).body;
  const n = acc.notifications;
  ok(acc.emailEnabled === true && Object.keys(n).length === 5 && n.itemShared === true && !n.itemDeleted && !n.accessRevoked && !n.itemTransferred && !n.newLogin, "notifications : seuls les partages sont activés par défaut");
  ok((await as(alice, () => api("GET", "/admin"))).body.emailVerification === true, "vérification de l'email à l'inscription activée par défaut");
  await as(alice, () => api("PATCH", "/admin/settings", { emailVerification: false }));
  ok((await as(alice, () => api("GET", "/admin"))).body.emailVerification === false, "l'admin peut couper la vérification de l'email");
  await as(alice, () => api("PATCH", "/admin/settings", { emailVerification: true }));
  ok((await as(bob, () => api("PUT", "/account/notifications", { itemShared: true }))).status === 400, "réglages de notification incomplets refusés");
  await as(alice, () => api("PUT", "/account/notifications", { itemDeleted: false, itemShared: false, accessRevoked: false, itemTransferred: false, newLogin: false }));
  const prefs = { itemDeleted: true, itemShared: true, accessRevoked: false, itemTransferred: true, newLogin: false };
  ok((await as(bob, () => api("PUT", "/account/notifications", prefs))).status === 200, "Bob active des notifications");
  ok(JSON.stringify((await as(bob, () => api("GET", "/account"))).body.notifications) === JSON.stringify(prefs), "les notifications choisies sont enregistrées");
}
const bobPub = (await as(alice, () => api("GET", "/auth/lookup?email=bob@test.local"))).body.users[0];
nA = await tree(alice);
const aliceMails = mails("alice@test.local").length;
await as(alice, () => lib.shareItem(ctxOf(alice, nA), F, bobPub, "editor"));
ok(mails("bob@test.local").some((m) => m.includes("Alice t'a partagé un dossier")), "notification : Bob est prévenu du partage");
await as(bob, () => api("PUT", "/account/visibility", { findableName: false, findableEmail: false }));
ok((await as(alice, () => api("GET", "/auth/lookup?q=bob@test.local"))).body.users?.[0]?.id === bob.user.id, "compte masqué : toujours trouvable (email compris) par qui partage déjà avec lui");
ok((await as(alice, () => api("GET", "/auth/lookup?q=bob"))).body.users?.[0]?.email === "bob@test.local", "idem par nom, avec son email");
await as(bob, () => api("PUT", "/account/visibility", { findableName: true, findableEmail: false }));
let nB = await tree(bob);
ok(nB.get(F)?.name === "Projet secret" && nB.get(F)?.root, "Bob voit le dossier partagé à la racine de ses partages");
ok(nB.get(S)?.name === "Sous-dossier infra", "le sous-dossier est partagé par héritage");
ok(nB.get(B)?.name === "Tableau confidentiel" && nB.get(B)?.role === "editor", "le tableau du sous-dossier est accessible en éditeur");
const bobContent = await as(bob, () => lib.fetchBoardContent(nB.get(B)!.key!, B));
ok(bobContent.elements[0]?.label === "TOP_SECRET_DIAGRAM", "Bob déchiffre le contenu du tableau");

// Giving a root item away.
{
  const G = await as(alice, () => lib.createItem(ctxOf(alice, nA), "folder", null, "Cadeau"));
  nA = await tree(alice);
  await as(alice, () => lib.shareItem(ctxOf(alice, nA), G, bobPub, "viewer"));
  const give = (u: U, id: string, userId: string) => as(u, () => api("POST", `/items/${id}/transfer`, { userId }));
  ok((await give(bob, G, bob.user.id)).status === 403, "transfert : refusé à qui n'est pas propriétaire");
  ok((await give(alice, G, "personne")).status === 400, "transfert : refusé vers quelqu'un sans accès");
  ok((await give(alice, G, alice.user.id)).status === 400, "transfert : refusé vers soi-même");
  ok((await give(alice, S, bob.user.id)).status === 400, "transfert : refusé pour un élément qui n'est pas à la racine");
  const done = await give(alice, G, bob.user.id);
  ok(done.status === 200, "transfert : propriété donnée à Bob");
  nA = await tree(alice);
  nB = await tree(bob);
  ok(nB.get(G)?.role === "owner" && nB.get(G)?.ownerId === bob.user.id, "après le transfert, Bob est propriétaire");
  ok(nA.get(G)?.role === "editor" && nA.get(G)?.ownerId === bob.user.id, "après le transfert, Alice est éditrice");
  ok((await give(alice, G, bob.user.id)).status === 403, "transfert : l'ancien propriétaire ne peut plus rien donner");
  const alicePub = { id: alice.user.id, email: "alice@test.local", publicKey: alice.user.publicKey };
  await as(bob, () => lib.shareItem(ctxOf(bob, nB), G, alicePub, "viewer"));
  ok((await tree(alice)).get(G)?.role === "viewer", "le nouveau propriétaire peut partager");
  ok(mails("bob@test.local").some((m) => m.includes("Alice t'a donné un dossier")), "notification : Bob est prévenu du transfert");
}
// Deletion notifies those who turned it on (Bob), not the others (Alice: everything off).
{
  const D = await as(alice, () => lib.createItem(ctxOf(alice, nA), "board", null, "À jeter"));
  nA = await tree(alice);
  await as(alice, () => lib.shareItem(ctxOf(alice, nA), D, bobPub, "viewer"));
  const before = mails("bob@test.local").length;
  ok((await as(alice, () => api("DELETE", `/items/${D}`))).status === 200, "Alice met un tableau partagé à la corbeille");
  const after = mails("bob@test.local").slice(before);
  ok(after.length === 1 && after[0].includes("un tableau a été mis à la corbeille"), "notification : Bob est prévenu de la suppression");
  ok(mails("alice@test.local").length === aliceMails, "sans notification activée, aucun email n'est envoyé");
}

// Live collab + encrypted terminal.
const sa = boardSocket(alice, B);
const sb = boardSocket(bob, B);
await Promise.all([sa.open, sb.open]);
const initB = await sb.next((m) => m.t === "init");
await sa.next((m) => m.t === "init");
ok(initB.elements.length === 1 && !JSON.stringify(initB.elements).includes("TOP_SECRET"), "le serveur n'envoie que du chiffré");

const keyB = nA.get(B)!.key!;
const moved = { ...rect, x: 42, version: 4, versionNonce: 222 };
sb.send({ t: "scene", epoch: initB.epoch, elements: [await encryptEntry(nB.get(B)!.key!, B, moved)] });
const sceneA = await sa.next((m) => m.t === "scene");
ok((await decryptEntry(keyB, B, sceneA.elements[0])).x === 42, "modif de Bob reçue et déchiffrée par Alice");

// Tampering: server-side swap of the clear version must be rejected by the client.
const tampered = { ...sceneA.elements[0], v: 99 };
let rejected = false;
await decryptEntry(keyB, B, tampered).catch(() => (rejected = true));
ok(rejected, "un élément dont la version en clair est falsifiée est rejeté");

// Terminal created by Alice on her machine, sealed to its vault-authenticated public key.
const { listMachines } = await import("../web/src/vault.ts");
const mAlice = (await as(alice, () => listMachines(alice.keys)))[0];
ok(mAlice?.fingerprint === machine.fingerprint, "clé publique de la machine authentifiée via le coffre");
const tid2 = c.randomId();
const kt = await c.newSymKey();
sa.send({
  t: "term.create", reqId: "r2", id: tid2, machineId: machine.id, cols: 80, rows: 24,
  keyForBoard: await c.wrapKey(keyB, kt, c.AAD.termKey(B, tid2)),
  keyForAgent: await c.box(mAlice.auth, kt.raw, c.AAD.termAgent(tid2)),
  encLabel: await c.boxText(keyB, "laptop-alice", c.AAD.termLabel(B, tid2)),
});
const created = await sa.next((m) => m.t === "term.created" && m.reqId === "r2");
const termB = await sb.next((m) => m.t === "term" && m.terminal.id === tid2 && m.terminal.status === "running", 8000);
const ktBob = await c.unwrapKey(nB.get(B)!.key!, termB.terminal.keyForBoard, c.AAD.termKey(B, tid2));
ok(c.toB64(ktBob.raw) === c.toB64(kt.raw), "Bob récupère la clé du terminal via la clé du tableau");

await subscribe(sb, tid2);
const frame = await sendInput(sb, ktBob, tid2, "bobtab", "echo CLEAR_$((6*7))\n");
const out = await termOutput(sb, ktBob, tid2, "CLEAR_42");
ok(out.includes("CLEAR_42"), "Bob tape dans le terminal d'Alice, sortie chiffrée bout en bout");

// Replay attack: the server re-sends the exact same input frame.
sb.send(frame);
const out2 = await termOutput(sb, ktBob, tid2, "CLEAR_42").catch(() => "");
ok(!out2.includes("CLEAR_42"), "le rejeu d'une frappe par le serveur est ignoré par l'agent");

// Telnet to a device reachable from the machine (a fake switch): the target is sealed with the key.
const IAC = 255, DO = 253, WILL = 251, ECHO = 1, SGA = 3;
let switchGotNaws = false;
const fakeSwitch = createTcpServer((sock) => {
  sock.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, 31]));
  sock.write("\r\nSwitch-TP>");
  sock.on("data", (d) => {
    if (d.includes(Buffer.from([IAC, 250, 31]))) switchGotNaws = true;
    const text = d.toString("latin1").replace(/\xff[\xfb-\xfe]./g, "").replace(/\xff\xfa[\s\S]*?\xff\xf0/g, "");
    if (text.includes("show version")) sock.write("\r\nIOS 12.2(55)SE TELNET_OK\r\nSwitch-TP>");
  });
});
await new Promise<void>((r) => fakeSwitch.listen(0, "127.0.0.1", () => r()));
const switchPort = (fakeSwitch.address() as any).port;
const tid3 = c.randomId();
const kt3 = await c.newSymKey();
sa.send({
  t: "term.create", reqId: "r3", id: tid3, machineId: machine.id, cols: 80, rows: 24,
  keyForBoard: await c.wrapKey(keyB, kt3, c.AAD.termKey(B, tid3)),
  keyForAgent: await c.boxJson(mAlice.auth, { k: c.toB64(kt3.raw), target: { kind: "telnet", host: "127.0.0.1", port: switchPort } }, c.AAD.termAgent(tid3)),
  encLabel: await c.boxText(keyB, `telnet 127.0.0.1:${switchPort} via laptop-alice`, c.AAD.termLabel(B, tid3)),
});
await sa.next((m) => m.t === "term.created" && m.reqId === "r3");
await subscribe(sa, tid3);
await termOutput(sa, kt3, tid3, "Switch-TP>");
await sendInput(sa, kt3, tid3, "alicetab", "show version\r");
const telnetOut = await termOutput(sa, kt3, tid3, "TELNET_OK");
ok(telnetOut.includes("TELNET_OK") && switchGotNaws, "telnet vers un équipement depuis la machine, négocié et chiffré jusqu'à l'agent");
const dbTelnet = new DatabaseSync(DB, { readOnly: true });
const tRow = JSON.stringify(dbTelnet.prepare("SELECT * FROM terminals WHERE id = ?").get(tid3) ?? {});
dbTelnet.close();
ok(!tRow.includes("127.0.0.1") && !tRow.includes("telnet"), "le serveur ne voit ni l'équipement ni le protocole");
fakeSwitch.close();

// Web tunnel: HTTP to a service on the machine, end-to-end encrypted through the agent.
const site = createServer((req, res) => res.end(`site:${req.method}:${req.url}:${req.headers["x-t"]}`));
await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
const sitePort = (site.address() as any).port;
const wid = c.randomId();
const kwA = await c.newSymKey();
const siteUrl = `http://127.0.0.1:${sitePort}`;
sa.send({
  t: "web.create", reqId: "w1", id: wid, machineId: machine.id,
  keyForBoard: await c.wrapKey(keyB, kwA, c.AAD.webKey(B, wid)),
  keyForAgent: await c.boxJson(mAlice.auth, { k: c.toB64(kwA.raw), url: siteUrl, insecure: false }, c.AAD.webAgent(wid)),
  encLabel: await c.boxJson(keyB, { url: siteUrl, insecure: false, machine: "laptop-alice" }, c.AAD.webLabel(B, wid)),
});
await sa.next((m) => m.t === "web.created" && m.reqId === "w1");
const webForBob = await sb.next((m) => m.t === "web" && m.web.id === wid);
const kwB = await c.unwrapKey(nB.get(B)!.key!, webForBob.web.keyForBoard, c.AAD.webKey(B, wid));
await new Promise((r) => setTimeout(r, 300));
async function tunnelGet(kw: c.SymKey, path: string) {
  const rid = c.randomId();
  const ts = Date.now();
  const d = await c.box(kw, c.utf8(JSON.stringify({ m: "GET", p: path, h: { "x-t": ["ok"] }, b: "" })), `eb:http-req:${wid}:${rid}:${ts}`);
  const r = await realFetch(`${PROXY}/eb-proxy/req/${wid}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid, ts, d }) });
  const j: any = await r.json();
  const res = JSON.parse(c.fromUtf8(await c.unbox(kw, j.d, `eb:http-res:${wid}:${rid}`)));
  return { status: res.s, body: c.fromUtf8(c.fromB64(res.b)) };
}
const got = await tunnelGet(kwB, "/hello?x=1");
ok(got.status === 200 && got.body === "site:GET:/hello?x=1:ok", "Bob consulte le site de la machine d'Alice via le tunnel chiffré");

// Cable state: Alice's machine pings addresses for her, sealed both ways under the machine auth key.
async function probe(who: any, targets: string[]) {
  const rid = c.randomId();
  const ts = Date.now();
  const d = await c.boxJson(mAlice.auth, { targets }, c.AAD.probe(rid, ts));
  const r = await as(who, () => api("POST", `/machines/${machine.id}/probe`, { rid, ts, d }));
  return { ...r, rid };
}
const pr = await probe(alice, ["127.0.0.1", "not-an-ip"]);
const pres = pr.status === 200 ? await c.unboxJson<{ r: Record<string, { up: boolean }> }>(mAlice.auth, pr.body.d, c.AAD.probeRes(pr.rid)) : null;
ok(!!pres && "127.0.0.1" in pres.r && !("not-an-ip" in pres.r), "sonde d'un câble : l'agent d'Alice répond pour les adresses IP seulement");
ok(pres?.r["127.0.0.1"]?.up === true, "127.0.0.1 joignable depuis la machine d'Alice");
const misbound = pr.status === 200 ? await c.unboxJson(mAlice.auth, pr.body.d, c.AAD.probeRes(c.randomId())).then(() => true, () => false) : true;
ok(!misbound, "la réponse de la sonde est liée à sa requête");
ok((await probe(alice, ["127.0.0.1"])).status === 429, "sondes trop rapprochées refusées par le serveur");
ok((await probe(bob, ["127.0.0.1"])).status === 404, "Bob ne peut pas sonder depuis la machine d'Alice");

// Third user / admin cannot read.
const inv = await as(alice, () => api("POST", "/admin/invites", { note: "carol" }));
const carol = await register("carol@test.local", "Carol", "carol-password-1", new URL(inv.body.url).searchParams.get("invite")!);
const carolRead = await as(carol, () => api("GET", `/items/${B}/content`));
ok(carolRead.status === 404, "un tiers ne peut pas lire le tableau");
const carolGrant = await as(carol, () => api("PUT", `/items/${B}/grants/${carol.user.id}`, { role: "editor", wrappedKey: "AAAA" }));
ok(carolGrant.status === 404 || carolGrant.status === 403, "un tiers ne peut pas s'ajouter un partage");
const adminSelf = await as(alice, () => api("PUT", `/items/${B}/grants/${carol.user.id}`, { role: "editor", wrappedKey: "AAAA" }));
ok(adminSelf.status === 200, "(le propriétaire, lui, peut partager)");
await as(alice, () => api("POST", `/items/${B}/revoke`, {})).catch(() => {});
// Admin endpoints never expose content or credentials.
const adminView = await as(alice, () => api("GET", "/admin"));
ok(!JSON.stringify(adminView.body).match(/enc_|auth_hash|private/i), "l'API admin n'expose ni clés ni hash");
const resetOther = await as(alice, () => api("PATCH", `/admin/users/${bob.user.id}`, { password: "hacked" }));
ok(resetOther.status === 400, "un admin ne peut pas changer le mot de passe d'un autre");

// Revoke Bob on F: rotation.
nA = await tree(alice);
// clean the bogus Carol grant via a proper revoke as well (exercises rotation twice)
await as(alice, () => lib.revokeAccess(ctxOf(alice, nA), B, carol.user.id));
nA = await tree(alice);
const oldKeyB = keyB;

// Malicious server: slips a fake member (its own key) into the folder before the rotation.
const evil = await c.generateKeyPair();
const rw = new DatabaseSync(DB);
rw.prepare("INSERT INTO users (id, email, name, auth_hash, kdf_salt, public_key, enc_private_key, recovery_enc_private_key, recovery_auth_hash, color, created_at) VALUES ('evilevilevilevilevil', 'evil@x.y', 'Evil', 'x', 'x', ?, 'x', 'x', 'x', '#000', 0)").run(c.toB64(evil.pub));
rw.prepare("INSERT INTO grants (item_id, user_id, role, wrapped_key, created_at) VALUES (?, 'evilevilevilevilevil', 'viewer', 'AAAA', 0)").run(F);
let injected = "";
await as(alice, () => lib.revokeAccess(ctxOf(alice, nA), F, bob.user.id)).catch((e) => (injected = String(e)));
ok(/non vérifiée/.test(injected), "rotation refusée si le serveur glisse un membre non vérifié");
rw.prepare("DELETE FROM grants WHERE user_id = 'evilevilevilevilevil'").run();

// Malicious server: swaps Bob's public key, then Alice changes Bob's role.
const realBobKey = rw.prepare("SELECT public_key AS k FROM users WHERE id = ?").get(bob.user.id) as any;
rw.prepare("UPDATE users SET public_key = ? WHERE id = ?").run(c.toB64(evil.pub), bob.user.id);
let swapped = "";
const bobMember = { id: bob.user.id, email: "bob@test.local", publicKey: c.toB64(evil.pub) };
await as(alice, () => lib.shareItem(ctxOf(alice, nA), F, bobMember, "viewer")).catch((e) => (swapped = String(e)));
ok(/a changé/.test(swapped), "partage refusé si la clé d'un contact a été substituée");
rw.prepare("UPDATE users SET public_key = ? WHERE id = ?").run(realBobKey.k, bob.user.id);

const sb2 = boardSocket(bob, B);
await sb2.open;
await sb2.next((m) => m.t === "init");
await as(alice, () => lib.revokeAccess(ctxOf(alice, nA), F, bob.user.id, (m) => console.log("   ↳", m)));
const codeB = await sb2.closed;
ok(codeB === 4409, "les sessions ouvertes sont coupées après rotation (4409)");
nB = await tree(bob);
ok(!nB.has(F) && !nB.has(S) && !nB.has(B), "Bob ne voit plus rien du dossier");
const bobAfter = await as(bob, () => api("GET", `/items/${B}/content`));
ok(bobAfter.status === 404, "le serveur refuse le contenu à Bob");
nA = await tree(alice);
const newKeyB = nA.get(B)!.key!;
ok(c.toB64(newKeyB.raw) !== c.toB64(oldKeyB.raw), "la clé du tableau a changé");
ok(nA.get(B)!.name === "Tableau confidentiel" && nA.get(S)!.name === "Sous-dossier infra", "Alice déchiffre tout avec les nouvelles clés");
const fresh = await as(alice, () => lib.fetchBoardContent(newKeyB, B));
ok(fresh.elements[0]?.x === 42, "contenu re-chiffré intact");
const rawAfter = (await as(alice, () => api("GET", `/items/${B}/content`))).body.elements[0];
let oldKeyWorks = true;
await decryptEntry(oldKeyB, B, rawAfter).catch(() => (oldKeyWorks = false));
ok(!oldKeyWorks, "l'ancienne clé (connue de Bob) ne déchiffre plus rien");

// Terminal was re-keyed (on Alice's machine): new key works, old doesn't.
const sa2 = boardSocket(alice, B);
await sa2.open;
const init2 = await sa2.next((m) => m.t === "init");
const t2 = init2.terminals.find((t: any) => t.id === tid2);
const kt2 = await c.unwrapKey(newKeyB, t2.keyForBoard, c.AAD.termKey(B, tid2));
ok(c.toB64(kt2.raw) !== c.toB64(kt.raw), "le terminal a reçu une nouvelle clé");
const w2 = init2.webs.find((w: any) => w.id === wid);
const kw2 = await c.unwrapKey(newKeyB, w2.keyForBoard, c.AAD.webKey(B, wid));
ok(c.toB64(kw2.raw) !== c.toB64(kwA.raw), "le tunnel web a reçu une nouvelle clé");
await new Promise((r) => setTimeout(r, 300));
ok((await tunnelGet(kw2, "/after")).body === "site:GET:/after:ok", "le tunnel fonctionne avec la nouvelle clé");
await subscribe(sa2, tid2);
await sendInput(sa2, kt2, tid2, "alicetab", "echo ROTATED_$((7*7))\n");
ok((await termOutput(sa2, kt2, tid2, "ROTATED_49")).includes("ROTATED_49"), "le terminal fonctionne avec la nouvelle clé");

// Nothing sensitive in the database.
await new Promise((r) => setTimeout(r, 2000));
const dump = JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM items").all()) +
  JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM boards").all()) +
  JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM machines").all()) +
  JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM tunnels").all());
ok(!/Projet secret|Sous-dossier|confidentiel|TOP_SECRET|laptop-alice|CLEAR_42|127\.0\.0\.1/.test(dump), "aucun nom, contenu ni adresse en clair dans la base");
site.close();

// Pairing with a short code (no copy-paste): the agent makes its key on the machine.
{
  const { approvePairing, listMachines: lm } = await import("../web/src/vault.ts");
  const pr = (await as(alice, () => api("POST", "/machines/pairings"))).body;
  const cfgPath = `${process.env.DB}.agent-pair.json`;
  const agentBin = new URL(`../agent/dist/excalibash-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`, import.meta.url).pathname;
  const pairProc = spawn(agentBin, ["--server", BASE, "--pair", pr.code.toLowerCase(), "--pair-only", "--config", cfgPath, "--name", "vm-tp"], { stdio: ["ignore", "ignore", "pipe"] });
  let pairOut = "";
  pairProc.stderr.on("data", (d) => (pairOut += d));
  let claim: any = null;
  for (let i = 0; i < 30 && !claim; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const st = (await as(alice, () => api("GET", `/machines/pairings/${pr.code}`))).body;
    if (st.status === "claimed") claim = st;
  }
  const fp = await c.fingerprint(c.fromB64(claim.agentPub));
  ok(pairOut.includes(fp), "l'empreinte affichée sur la machine est celle montrée dans le navigateur");
  await as(alice, () => approvePairing(alice.keys, pr.code, claim.agentPub, "vm-tp"));
  const exit = await new Promise<number>((r) => pairProc.on("exit", (code) => r(code ?? -1)));
  ok(exit === 0, "l'agent est appairé et sa configuration enregistrée");
  const reuse = await realFetch(`${BASE}/api/pair/${pr.code.replace("-", "")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pub: c.toB64(c.randomBytes(32)) }) });
  ok(reuse.status === 404, "un code déjà utilisé est refusé");
  const paired = spawn(agentBin, ["--config", cfgPath], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
  const pm = (await as(alice, () => lm(alice.keys))).find((m) => m.name === "vm-tp");
  ok(pm?.online, "la machine appairée se connecte avec sa configuration");
  const pt = c.randomId();
  const pk = await c.newSymKey();
  const sp = boardSocket(alice, B);
  await sp.open;
  await sp.next((m) => m.t === "init");
  const nowKeyB = (await tree(alice)).get(B)!.key!;
  sp.send({
    t: "term.create", reqId: "p1", id: pt, machineId: pm!.id, cols: 80, rows: 24,
    keyForBoard: await c.wrapKey(nowKeyB, pk, c.AAD.termKey(B, pt)),
    keyForAgent: await c.box(pm!.auth, pk.raw, c.AAD.termAgent(pt)),
    encLabel: await c.boxText(nowKeyB, "vm-tp", c.AAD.termLabel(B, pt)),
  });
  await sp.next((m) => m.t === "term" && m.terminal.id === pt && m.terminal.status === "running", 8000);
  await subscribe(sp, pt);
  await sendInput(sp, pk, pt, "pairtab", "echo PAIRED_$((5*5))\n");
  ok((await termOutput(sp, pk, pt, "PAIRED_25")).includes("PAIRED_25"), "un shell s'ouvre sur la machine appairée");
  paired.kill();
  sp.ws.close();
  // Removing the machine hands back the command that removes its agent from the machine itself.
  ok((await as(bob, () => api("DELETE", `/machines/${pm!.id}`))).status === 404, "Bob ne peut pas supprimer la machine d'Alice");
  const del = await as(alice, () => api("DELETE", `/machines/${pm!.id}`));
  ok(del.status === 200 && /^curl .*\/uninstall\.sh \| sh$/.test(del.body.uninstall ?? ""), "suppression d'une machine : commande de désinstallation de l'agent fournie");
  const script = await (await realFetch(`${BASE}/uninstall.sh`)).text();
  ok(script.startsWith("#!/bin/sh") && script.includes(".config/excalibash") && script.includes("systemctl --user disable"), "/uninstall.sh retire le service, le programme et la configuration");
}

// Unauthenticated hardening.
const nullOrigin = await new Promise<number>((resolve) => {
  const w = new WebSocket(`${BASE.replace("http", "ws")}/ws?board=${B}`, { headers: { cookie: alice.cookie, origin: "null" } });
  w.on("unexpected-response", (_q: any, r: any) => resolve(r.statusCode));
  w.on("error", () => {});
});
ok(nullOrigin === 403 && (await api("GET", "/auth/status")).status === 200, "Origin: null refusé sans faire tomber le serveur");
jar.current = "";
const big = await realFetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x", authKey: "y".repeat(600_000) }) });
ok(big.status === 413, "corps énorme refusé avant authentification");
let limited = 0;
for (let i = 0; i < 12; i++) {
  const r = await realFetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `9.9.9.${i}` }, body: JSON.stringify({ email: "alice@test.local", authKey: "nope" }) });
  if (r.status === 429) limited++;
}
ok(limited > 0, "limitation des tentatives de connexion par compte, même en changeant X-Forwarded-For");

agent.kill();
sa.ws.close();
sa2.ws.close();
console.log(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
