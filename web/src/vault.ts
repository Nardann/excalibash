// Per-user encrypted records the server cannot forge: pinned contact keys (TOFU) and
// the public keys of the user's own machines.
import { api, type RawMachine, type User } from "./api.ts";
import { AAD, box, boxText, fingerprint, generateKeyPair, machineAuthKey, randomId, symKey, toB64, unbox, unboxJson, unboxText, boxJson, vaultKey, type KeyPair, type SymKey } from "./crypto.ts";

/** Pinned public keys of the people we shared with, by account id and by email. */
type VaultData = { contacts: Record<string, string>; emails?: Record<string, string> };

let cache: { userId: string; data: VaultData } | null = null;

async function load(user: User, keys: KeyPair): Promise<VaultData> {
  if (cache?.userId === user.id) return cache.data;
  const r = await api.get<{ encVault: string | null }>("/auth/me");
  let data: VaultData = { contacts: {}, emails: {} };
  if (r.encVault) data = await unboxJson<VaultData>(await vaultKey(keys), r.encVault, AAD.vault(user.id));
  cache = { userId: user.id, data };
  return data;
}

async function save(user: User, keys: KeyPair, data: VaultData) {
  await api.put("/auth/vault", { encVault: await boxJson(await vaultKey(keys), data, AAD.vault(user.id)) });
  cache = { userId: user.id, data };
}

export type KeyCheck = "new" | "match" | "changed";

/**
 * Compares a contact's public key with the one pinned the first time we shared with them.
 * Pinning by email too catches an account deleted and re-created under the same address.
 */
export async function checkContact(user: User, keys: KeyPair, contactId: string, email: string, publicKey: string): Promise<KeyCheck> {
  const data = await load(user, keys);
  const byId = data.contacts[contactId];
  const byEmail = data.emails?.[email.toLowerCase()];
  if ((byId && byId !== publicKey) || (byEmail && byEmail !== publicKey)) return "changed";
  return byId || byEmail ? "match" : "new";
}

export async function pinContact(user: User, keys: KeyPair, contactId: string, email: string, publicKey: string) {
  const data = await load(user, keys);
  const e = email.toLowerCase();
  if (data.contacts[contactId] === publicKey && data.emails?.[e] === publicKey) return;
  await save(user, keys, { contacts: { ...data.contacts, [contactId]: publicKey }, emails: { ...data.emails, [e]: publicKey } });
}

// ---- Machines ----------------------------------------------------------------------

export type Machine = Omit<RawMachine, "encName" | "encPub" | "encAuth"> & { name: string; pub: Uint8Array; auth: SymKey; fingerprint: string };

const machineNameAad = AAD.machineName;

export async function listMachines(keys: KeyPair): Promise<Machine[]> {
  const vk = await vaultKey(keys);
  const { machines } = await api.get<{ machines: RawMachine[] }>("/machines");
  const out: Machine[] = [];
  for (const m of machines) {
    try {
      const pub = await unbox(vk, m.encPub, AAD.machine(m.id));
      const auth = await symKey(await unbox(vk, m.encAuth, AAD.machineAuth(m.id)));
      const { encName: _n, encPub: _p, encAuth: _a, ...rest } = m;
      out.push({ ...rest, name: await unboxText(vk, m.encName, machineNameAad(m.id)), pub, auth, fingerprint: await fingerprint(pub) });
    } catch {
      // Not signed by our vault key: refuse to use it rather than trust the server.
      console.warn("[excalibash] machine ignorée : enregistrement non authentique", m.id);
    }
  }
  return out;
}

export async function createMachine(keys: KeyPair, name: string) {
  const vk = await vaultKey(keys);
  const id = randomId();
  const kp = await generateKeyPair();
  const r = await api.post<{ token: string; server: string }>("/machines", {
    id,
    encName: await boxText(vk, name, machineNameAad(id)),
    encPub: await box(vk, kp.pub, AAD.machine(id)),
    encAuth: await box(vk, (await machineAuthKey(kp.rawPriv)).raw, AAD.machineAuth(id)),
  });
  return { id, token: r.token, server: r.server, privateKey: toB64(kp.rawPriv), fingerprint: await fingerprint(kp.pub) };
}

export async function renameMachine(keys: KeyPair, id: string, name: string) {
  await api.patch(`/machines/${id}`, { encName: await boxText(await vaultKey(keys), name, machineNameAad(id)) });
}

