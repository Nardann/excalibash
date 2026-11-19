// End-to-end: two users, nested shared folders, encrypted collab + terminal, revoke + rotation,
// third user / admin cannot read. Uses the real web crypto + library code against the real server/agent.
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "../server/node_modules/ws/index.js";
import * as c from "../web/src/crypto.ts";
import * as lib from "../web/src/library.tsx";
import { createMachine } from "../web/src/vault.ts";
import { encryptEntry, decryptEntry } from "../web/src/board/boardCrypto.ts";

const BASE = process.env.BASE ?? "http://127.0.0.1:6797";
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

async function register(email: string, name: string, password: string, invite?: string): Promise<U> {
  jar.current = "";
  const id = c.randomId();
  const salt = c.toB64(c.randomBytes(16));
  const { authKey, masterKey } = await c.deriveAccountKeys(password, salt);
  const kp = await c.generateKeyPair();
  const rraw = c.randomBytes(32);
  const rec = await c.recoveryKeys(rraw);
  const r = await api("POST", "/auth/register", {
    id, email, name, invite, salt, authKey,
    publicKey: c.toB64(kp.pub),
    encPrivateKey: await c.box(masterKey, kp.pkcs8, c.AAD.priv(id)),
    recoveryEncPrivateKey: await c.box(rec.recoveryEnc, kp.pkcs8, c.AAD.priv(id)),
    recoveryAuth: rec.recoveryAuth,
  });
  if (r.status !== 200) throw new Error(`register ${email}: ${JSON.stringify(r.body)}`);
  return { user: r.body.user, keys: { priv: await c.importPrivateKey(kp.pkcs8), pub: kp.pub }, cookie: jar.current, recovery: c.formatRecoveryKey(rraw) };
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

async function termOutput(sock: ReturnType<typeof boardSocket>, kt: c.SymKey, tid: string, needle: string) {
  let acc = "";
  for (let i = 0; i < 50; i++) {
    const m = await sock.next((x) => x.t === "term.data" && x.id === tid, 8000);
    acc += c.fromUtf8(await c.unbox(kt, m.d, c.AAD.termOut(tid, m.gen, m.seq)));
    if (acc.includes(needle)) return acc;
  }
  return acc;
}

let counter = 0;
async function sendInput(sock: ReturnType<typeof boardSocket>, kt: c.SymKey, tid: string, s: string, text: string) {
  const k = ++counter;
  const ts = Date.now();
  const frame = { t: "term.input", id: tid, s, k, ts, d: await c.box(kt, c.utf8(text), c.AAD.termIn(tid, s, k, ts)) };
  sock.send(frame);
  return frame;
}

// ---------------------------------------------------------------------------------------

const alice = await register("alice@test.local", "Alice", "alice-password-1");
ok(alice.user.isAdmin, "le premier compte est admin");

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
await as(alice, () => api("PATCH", "/admin/settings", { registrationOpen: false }));
const bobPub = (await as(alice, () => api("GET", "/auth/lookup?email=bob@test.local"))).body.user;
nA = await tree(alice);
await as(alice, () => lib.shareItem(ctxOf(alice, nA), F, bobPub, "editor"));
let nB = await tree(bob);
ok(nB.get(F)?.name === "Projet secret" && nB.get(F)?.root, "Bob voit le dossier partagé à la racine de ses partages");
ok(nB.get(S)?.name === "Sous-dossier infra", "le sous-dossier est partagé par héritage");
ok(nB.get(B)?.name === "Tableau confidentiel" && nB.get(B)?.role === "editor", "le tableau du sous-dossier est accessible en éditeur");
const bobContent = await as(bob, () => lib.fetchBoardContent(nB.get(B)!.key!, B));
ok(bobContent.elements[0]?.label === "TOP_SECRET_DIAGRAM", "Bob déchiffre le contenu du tableau");

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
  keyForAgent: await c.seal(mAlice.pub, kt.raw, c.AAD.termAgent(tid2)),
  encLabel: await c.boxText(keyB, "laptop-alice", c.AAD.termLabel(B, tid2)),
});
const created = await sa.next((m) => m.t === "term.created" && m.reqId === "r2");
const termB = await sb.next((m) => m.t === "term" && m.terminal.id === tid2 && m.terminal.status === "running", 8000);
const ktBob = await c.unwrapKey(nB.get(B)!.key!, termB.terminal.keyForBoard, c.AAD.termKey(B, tid2));
ok(c.toB64(ktBob.raw) === c.toB64(kt.raw), "Bob récupère la clé du terminal via la clé du tableau");

sb.send({ t: "term.sub", id: tid2 });
const frame = await sendInput(sb, ktBob, tid2, "bobtab", "echo CLEAR_$((6*7))\n");
const out = await termOutput(sb, ktBob, tid2, "CLEAR_42");
ok(out.includes("CLEAR_42"), "Bob tape dans le terminal d'Alice, sortie chiffrée bout en bout");

// Replay attack: the server re-sends the exact same input frame.
sb.send(frame);
const out2 = await termOutput(sb, ktBob, tid2, "CLEAR_42").catch(() => "");
ok(!out2.includes("CLEAR_42"), "le rejeu d'une frappe par le serveur est ignoré par l'agent");

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
sa2.send({ t: "term.sub", id: tid2 });
await sendInput(sa2, kt2, tid2, "alicetab", "echo ROTATED_$((7*7))\n");
ok((await termOutput(sa2, kt2, tid2, "ROTATED_49")).includes("ROTATED_49"), "le terminal fonctionne avec la nouvelle clé");

// Nothing sensitive in the database.
await new Promise((r) => setTimeout(r, 2000));
const dump = JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM items").all()) +
  JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM boards").all()) +
  JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM machines").all());
ok(!/Projet secret|Sous-dossier|confidentiel|TOP_SECRET|laptop-alice|CLEAR_42/.test(dump), "aucun nom ni contenu en clair dans la base");

agent.kill();
sa.ws.close();
sa2.ws.close();
console.log(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
