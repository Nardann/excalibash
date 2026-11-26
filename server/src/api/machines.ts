import { Router, type Request } from "express";
import { randomBytes } from "node:crypto";
import { db, isClientId } from "../db.ts";
import { getUserRow, requireUser, sha256 } from "../auth.ts";
import { atLeast, getItem, getMachine, isTrashed, linkHolds, machineAccess, roleOn, type MachineRow } from "../access.ts";
import { machineNote, machineSessionCount, parseCaps, disconnectMachine, dropMachine, dropMachineTerminalsWhere, isMachineOnline } from "../terminals.ts";
import { dropMachineTunnels, dropMachineTunnelsWhere } from "../tunnels.ts";
import { notify } from "../notify.ts";
import { probeRefusal, relayProbe } from "../probes.ts";
import { relayUpdate, updateRefusal } from "../agentUpdate.ts";
import { HttpError, blob, mailLink, pid, publicUrl } from "../http.ts";
import { pinFor } from "../tls.ts";

export const machinesApi = Router();
machinesApi.use(requireUser);

function dto(m: MachineRow) {
  return {
    id: m.id,
    encName: m.enc_name,
    encPub: m.enc_pub,
    encAuth: m.enc_auth,
    hostname: m.hostname,
    os: m.os,
    arch: m.arch,
    agentVersion: m.agent_version,
    agentCaps: parseCaps(m.agent_caps),
    agentNote: machineNote(m.id),
    openSessions: machineSessionCount(m.id),
    lastSeen: m.last_seen,
    online: isMachineOnline(m.id),
    shareBoards: !!m.share_boards,
  };
}

/** A machine someone else shared: what the agent reports, and its keys sealed or boxed for us. */
function sharedDto(m: MachineRow & { owner_name: string }, key: string) {
  return {
    id: m.id,
    ownerId: m.owner_id,
    ownerName: m.owner_name,
    key,
    hostname: m.hostname,
    os: m.os,
    arch: m.arch,
    agentVersion: m.agent_version,
    agentCaps: parseCaps(m.agent_caps),
    agentNote: machineNote(m.id),
    openSessions: machineSessionCount(m.id),
    lastSeen: m.last_seen,
    online: isMachineOnline(m.id),
  };
}

/**
 * Access to a machine changed: its shells and sites opened by someone who no longer has access
 * (from that board) are closed. The owner's own sessions always stay.
 */
export function closeLostSessions(machineId: string) {
  const m = getMachine(machineId);
  if (!m) return;
  const lost = (t: { boardId: string; createdBy: string | null }) => !!t.createdBy && !machineAccess(t.createdBy, m, t.boardId);
  dropMachineTerminalsWhere(m.id, lost);
  dropMachineTunnelsWhere(m.id, lost);
}

/**
 * Rights changed on these boards (role change, trash, transfer, key rotation): the sessions
 * opened on them by people who lost access to the machine are closed.
 */
export function recheckBoardSessions(boardIds: Iterable<string>) {
  const ids = [...boardIds];
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(",");
  const machines = db
    .prepare(`SELECT machine_id AS id FROM terminals WHERE board_id IN (${marks}) UNION SELECT machine_id FROM tunnels WHERE board_id IN (${marks})`)
    .all(...ids, ...ids) as { id: string }[];
  for (const { id } of machines) closeLostSessions(id);
}

const newToken = () => "eba_" + randomBytes(24).toString("base64url");

function own(req: Request): MachineRow {
  const m = getMachine(pid(req));
  if (!m || m.owner_id !== req.user!.id) throw new HttpError(404, "Machine introuvable");
  return m;
}

machinesApi.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM machines WHERE owner_id = ? ORDER BY created_at").all(req.user!.id) as MachineRow[];
  const shared = db
    .prepare(
      `SELECT m.*, u.name AS owner_name, s.sealed FROM machine_shares s JOIN machines m ON m.id = s.machine_id JOIN users u ON u.id = m.owner_id
       WHERE s.user_id = ? AND u.suspended = 0 ORDER BY s.created_at`,
    )
    .all(req.user!.id) as (MachineRow & { owner_name: string; sealed: string })[];
  res.json({ machines: rows.map(dto), shared: shared.map((m) => sharedDto(m, m.sealed)) });
});

/**
 * The machines linked to a board (for its editors): their auth key is boxed under the board key.
 * Only links that still grant access are listed (sharing through boards on, owner still editor).
 */
machinesApi.get("/links", (req, res) => {
  const uid = req.user!.id;
  const board = getItem(String(req.query.board ?? ""));
  if (!board || board.kind !== "board" || !atLeast(roleOn(uid, board.id), "editor")) throw new HttpError(404, "Tableau introuvable");
  const rows = db
    .prepare(
      `SELECT m.*, u.name AS owner_name, l.wrapped FROM machine_boards l JOIN machines m ON m.id = l.machine_id JOIN users u ON u.id = m.owner_id
       WHERE l.board_id = ? AND u.suspended = 0 ORDER BY l.created_at`,
    )
    .all(board.id) as (MachineRow & { owner_name: string; wrapped: string })[];
  res.json({ links: rows.filter((m) => linkHolds(m, board.id)).map((m) => sharedDto(m, m.wrapped)) });
});

/**
 * The browser generated the machine's key pair: we only get the public key sealed in the
 * owner's vault, plus an auth token for the agent's connection.
 */
machinesApi.post("/", (req, res) => {
  if (!isClientId(req.body.id) || getMachine(req.body.id)) throw new HttpError(400, "Identifiant invalide");
  const token = newToken();
  db.prepare(
    "INSERT INTO machines (id, owner_id, enc_name, enc_pub, enc_auth, token_hash, created_at, share_boards) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    req.body.id,
    req.user!.id,
    blob(req.body.encName, 1000),
    blob(req.body.encPub, 300),
    blob(req.body.encAuth, 300),
    sha256(token),
    Date.now(),
    req.body.shareBoards === false ? 0 : 1,
  );
  res.json({ machine: dto(getMachine(req.body.id)!), token, server: publicUrl(req) });
});

machinesApi.patch("/:id", (req, res) => {
  const m = own(req);
  if (req.body.encName !== undefined) db.prepare("UPDATE machines SET enc_name = ? WHERE id = ?").run(blob(req.body.encName, 1000), m.id);
  if (typeof req.body.shareBoards === "boolean") {
    db.prepare("UPDATE machines SET share_boards = ? WHERE id = ?").run(req.body.shareBoards ? 1 : 0, m.id);
    // Turned off: the board links go, with the sessions only they allowed.
    if (!req.body.shareBoards) {
      db.prepare("DELETE FROM machine_boards WHERE machine_id = ?").run(m.id);
      closeLostSessions(m.id);
    }
  }
  res.json({ ok: true });
});

// ---- Direct shares ----------------------------------------------------------------

machinesApi.get("/:id/shares", (req, res) => {
  const m = own(req);
  const shares = db
    .prepare(
      `SELECT s.user_id AS userId, u.name, u.email, u.color, u.public_key AS publicKey FROM machine_shares s JOIN users u ON u.id = s.user_id
       WHERE s.machine_id = ? ORDER BY s.created_at`,
    )
    .all(m.id);
  const boards = (db.prepare("SELECT board_id AS id FROM machine_boards WHERE machine_id = ? ORDER BY created_at").all(m.id) as { id: string }[]).map((b) => b.id);
  res.json({ shares, boards });
});

/** `sealed`: the machine's auth key, name and public key sealed to that person's public key. */
machinesApi.put("/:id/shares/:userId", (req, res) => {
  const m = own(req);
  const target = getUserRow(pid(req, "userId"));
  if (!target) throw new HttpError(404, "Utilisateur introuvable");
  if (target.id === m.owner_id) throw new HttpError(400, "C'est ta machine");
  const isNew = !db.prepare("SELECT 1 FROM machine_shares WHERE machine_id = ? AND user_id = ?").get(m.id, target.id);
  db.prepare(
    `INSERT INTO machine_shares (machine_id, user_id, sealed, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(machine_id, user_id) DO UPDATE SET sealed = excluded.sealed`,
  ).run(m.id, target.id, blob(req.body.sealed, 2000), Date.now());
  if (isNew) {
    notify(req, [target.id], "itemShared", `Excalibash : ${req.user!.name} t'a partagé une machine`, () => ({
      title: `${req.user!.name} t'a partagé une machine`,
      lines: [`**${req.user!.name}** te permet d'ouvrir des shells et des sites sur une de ses machines, depuis tes tableaux.`],
      button: mailLink(req, "/machines", "Voir mes machines"),
      note: "Son nom est chiffré : seul ton navigateur peut le lire, c'est pourquoi il n'apparaît pas ici.",
    }));
  }
  res.json({ ok: true });
});

/** The owner withdraws a share, or the person gives it up. Their sessions on the machine are closed. */
machinesApi.delete("/:id/shares/:userId", (req, res) => {
  const m = getMachine(pid(req));
  const userId = pid(req, "userId");
  if (!m || (m.owner_id !== req.user!.id && userId !== req.user!.id)) throw new HttpError(404, "Machine introuvable");
  db.prepare("DELETE FROM machine_shares WHERE machine_id = ? AND user_id = ?").run(m.id, userId);
  closeLostSessions(m.id);
  res.json({ ok: true });
});

// ---- Board links ------------------------------------------------------------------

/** `wrapped`: the machine's auth key, name and public key boxed under the board key. */
machinesApi.put("/:id/links/:boardId", (req, res) => {
  const m = own(req);
  if (!m.share_boards) throw new HttpError(409, "Le partage par les tableaux est désactivé pour cette machine");
  const board = getItem(pid(req, "boardId"));
  if (!board || board.kind !== "board" || isTrashed(board.id) || !atLeast(roleOn(m.owner_id, board.id), "editor")) throw new HttpError(404, "Tableau introuvable");
  db.prepare(
    `INSERT INTO machine_boards (machine_id, board_id, wrapped, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(machine_id, board_id) DO UPDATE SET wrapped = excluded.wrapped`,
  ).run(m.id, board.id, blob(req.body.wrapped, 2000), Date.now());
  res.json({ ok: true });
});

machinesApi.delete("/:id/links/:boardId", (req, res) => {
  const m = own(req);
  db.prepare("DELETE FROM machine_boards WHERE machine_id = ? AND board_id = ?").run(m.id, pid(req, "boardId"));
  closeLostSessions(m.id);
  res.json({ ok: true });
});

machinesApi.post("/:id/token", (req, res) => {
  const m = own(req);
  const token = newToken();
  db.prepare("UPDATE machines SET token_hash = ? WHERE id = ?").run(sha256(token), m.id);
  disconnectMachine(m.id);
  res.json({ token, server: publicUrl(req) });
});

// Can this machine reach these addresses? The request and the answer are boxed by the browser
// and the agent (machine auth key): the server sees neither the addresses nor the results.
machinesApi.post("/:id/probe", (req, res, next) => {
  const { rid, ts, d, boardId } = req.body ?? {};
  const m = getMachine(pid(req));
  if (!m || !machineAccess(req.user!.id, m, typeof boardId === "string" ? boardId : null)) throw new HttpError(404, "Machine introuvable");
  if (!isClientId(rid) || !Number.isSafeInteger(ts)) throw new HttpError(400, "Requête invalide");
  const box = blob(d, 8000);
  const refusal = probeRefusal(m.id);
  if (refusal === "offline") throw new HttpError(409, "Machine hors ligne");
  if (refusal) throw new HttpError(429, "Trop de sondes, réessaie dans un instant");
  relayProbe(m.id, rid, ts, box)
    .then((answer) => (answer ? res.json({ d: answer }) : res.status(504).json({ error: "La machine ne répond pas" })))
    .catch(next);
});

// Ask the agent to update itself. Boxed under machine auth like a probe: whoever may open a shell
// on the machine may ask, and the agent only installs a release signed with its embedded key, so the
// request grants nothing. The answer is a stream of boxed progress frames, one JSON object per line.
machinesApi.post("/:id/update", (req, res) => {
  const { rid, ts, d, boardId } = req.body ?? {};
  const m = getMachine(pid(req));
  if (!m || !machineAccess(req.user!.id, m, typeof boardId === "string" ? boardId : null)) throw new HttpError(404, "Machine introuvable");
  if (!isClientId(rid) || !Number.isSafeInteger(ts)) throw new HttpError(400, "Requête invalide");
  const box = blob(d, 2000);
  const refusal = updateRefusal(m.id);
  if (refusal === "offline") throw new HttpError(409, "Machine hors ligne");
  if (refusal === "busy") throw new HttpError(409, "Une mise à jour est déjà en cours sur cette machine");
  if (refusal) throw new HttpError(429, "Une mise à jour a déjà été demandée il y a moins d'une minute");
  relayUpdate(m.id, rid, ts, box, res);
});

machinesApi.delete("/:id", (req, res) => {
  const m = own(req);
  dropMachine(m.id);
  dropMachineTunnels(m.id);
  db.prepare("DELETE FROM machines WHERE id = ?").run(m.id);
  // The command that removes the agent from the machine itself (pinned like the install ones).
  const pin = pinFor(req);
  const curl = pin ? `curl -k --pinnedpubkey '${pin}' -fsSL` : "curl -fsSL";
  res.json({ ok: true, uninstall: `${curl} ${publicUrl(req)}/uninstall.sh | sh` });
});
