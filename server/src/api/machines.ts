import { Router, type Request } from "express";
import { randomBytes } from "node:crypto";
import { db, isClientId } from "../db.ts";
import { requireUser, sha256 } from "../auth.ts";
import { getMachine, type MachineRow } from "../access.ts";
import { disconnectMachine, dropMachine, isMachineOnline } from "../terminals.ts";
import { dropMachineTunnels } from "../tunnels.ts";
import { HttpError, blob, pid, publicUrl } from "../http.ts";

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
    lastSeen: m.last_seen,
    online: isMachineOnline(m.id),
  };
}

const newToken = () => "eba_" + randomBytes(24).toString("base64url");

function own(req: Request): MachineRow {
  const m = getMachine(pid(req));
  if (!m || m.owner_id !== req.user!.id) throw new HttpError(404, "Machine introuvable");
  return m;
}

machinesApi.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM machines WHERE owner_id = ? ORDER BY created_at").all(req.user!.id) as MachineRow[];
  res.json({ machines: rows.map(dto) });
});

/**
 * The browser generated the machine's key pair: we only get the public key sealed in the
 * owner's vault, plus an auth token for the agent's connection.
 */
machinesApi.post("/", (req, res) => {
  if (!isClientId(req.body.id) || getMachine(req.body.id)) throw new HttpError(400, "Identifiant invalide");
  const token = newToken();
  db.prepare("INSERT INTO machines (id, owner_id, enc_name, enc_pub, enc_auth, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    req.body.id,
    req.user!.id,
    blob(req.body.encName, 1000),
    blob(req.body.encPub, 300),
    blob(req.body.encAuth, 300),
    sha256(token),
    Date.now(),
  );
  res.json({ machine: dto(getMachine(req.body.id)!), token, server: publicUrl(req) });
});

machinesApi.patch("/:id", (req, res) => {
  const m = own(req);
  db.prepare("UPDATE machines SET enc_name = ? WHERE id = ?").run(blob(req.body.encName, 1000), m.id);
  res.json({ ok: true });
});

machinesApi.post("/:id/token", (req, res) => {
  const m = own(req);
  const token = newToken();
  db.prepare("UPDATE machines SET token_hash = ? WHERE id = ?").run(sha256(token), m.id);
  disconnectMachine(m.id);
  res.json({ token, server: publicUrl(req) });
});

machinesApi.delete("/:id", (req, res) => {
  const m = own(req);
  dropMachine(m.id);
  dropMachineTunnels(m.id);
  db.prepare("DELETE FROM machines WHERE id = ?").run(m.id);
  res.json({ ok: true });
});
