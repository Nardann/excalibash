// Account key management: the password never leaves the browser, the private key is only
// ever stored encrypted on the server and as a non-extractable CryptoKey in IndexedDB.
import { api, type User } from "./api.ts";
import {
  AAD,
  box,
  deriveAccountKeys,
  formatRecoveryKey,
  fromB64,
  generateKeyPair,
  importPrivateKey,
  parseRecoveryKey,
  randomBytes,
  randomId,
  recoveryKeys,
  toB64,
  unbox,
  type KeyPair,
} from "./crypto.ts";

const DB = "excalibash";
const STORE = "keys";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function storeKeys(userId: string, kp: KeyPair): Promise<void> {
  await idbOp("readwrite", (s) => s.put({ priv: kp.priv, pub: kp.pub }, userId));
}

export async function loadKeys(userId: string): Promise<KeyPair | null> {
  try {
    const v = (await idbOp("readonly", (s) => s.get(userId))) as { priv: CryptoKey; pub: Uint8Array } | undefined;
    return v ? { priv: v.priv, pub: new Uint8Array(v.pub) } : null;
  } catch {
    return null;
  }
}

export async function forgetKeys(): Promise<void> {
  try {
    await idbOp("readwrite", (s) => s.clear());
  } catch {
    /* nothing stored */
  }
}

async function openPrivateKey(encPrivateKey: string, key: Parameters<typeof unbox>[0], userId: string, publicKey: string): Promise<KeyPair> {
  const pkcs8 = await unbox(key, encPrivateKey, AAD.priv(userId));
  return { priv: await importPrivateKey(pkcs8), pub: fromB64(publicKey) };
}

export type Session = { user: User; keys: KeyPair };

export async function register(o: { email: string; name: string; password: string; invite?: string | null }): Promise<Session & { recoveryKey: string }> {
  const id = randomId();
  const salt = toB64(randomBytes(16));
  const { authKey, masterKey } = await deriveAccountKeys(o.password, salt);
  const kp = await generateKeyPair();
  const recoveryRaw = randomBytes(32);
  const rec = await recoveryKeys(recoveryRaw);
  const r = await api.post<{ user: User }>("/auth/register", {
    id,
    email: o.email,
    name: o.name,
    invite: o.invite || undefined,
    salt,
    authKey,
    publicKey: toB64(kp.pub),
    encPrivateKey: await box(masterKey, kp.pkcs8, AAD.priv(id)),
    recoveryEncPrivateKey: await box(rec.recoveryEnc, kp.pkcs8, AAD.priv(id)),
    recoveryAuth: rec.recoveryAuth,
  });
  const keys = { priv: await importPrivateKey(kp.pkcs8), pub: kp.pub };
  await storeKeys(r.user.id, keys);
  return { user: r.user, keys, recoveryKey: formatRecoveryKey(recoveryRaw) };
}

export async function login(email: string, password: string): Promise<Session> {
  const { salt } = await api.post<{ salt: string }>("/auth/prelogin", { email });
  const { authKey, masterKey } = await deriveAccountKeys(password, salt);
  const r = await api.post<{ user: User; keys: { publicKey: string; encPrivateKey: string } }>("/auth/login", { email, authKey });
  const keys = await openPrivateKey(r.keys.encPrivateKey, masterKey, r.user.id, r.keys.publicKey);
  await storeKeys(r.user.id, keys);
  return { user: r.user, keys };
}

/** A session cookie without keys on this device (cleared storage, new browser profile…). */
export async function unlock(user: User, password: string): Promise<KeyPair> {
  const k = await api.get<{ salt: string; publicKey: string; encPrivateKey: string }>("/auth/keys");
  const { masterKey } = await deriveAccountKeys(password, k.salt);
  let keys: KeyPair;
  try {
    keys = await openPrivateKey(k.encPrivateKey, masterKey, user.id, k.publicKey);
  } catch {
    throw new Error("Mot de passe incorrect");
  }
  await storeKeys(user.id, keys);
  return keys;
}

export async function recover(email: string, recoveryKey: string, newPassword: string): Promise<Session> {
  const rec = await recoveryKeys(parseRecoveryKey(recoveryKey));
  const r = await api.post<{ userId: string; publicKey: string; recoveryEncPrivateKey: string }>("/auth/recover", { email, recoveryAuth: rec.recoveryAuth });
  const pkcs8 = await unbox(rec.recoveryEnc, r.recoveryEncPrivateKey, AAD.priv(r.userId));
  const salt = toB64(randomBytes(16));
  const { authKey, masterKey } = await deriveAccountKeys(newPassword, salt);
  const done = await api.post<{ user: User }>("/auth/recover/finish", {
    email,
    recoveryAuth: rec.recoveryAuth,
    salt,
    authKey,
    encPrivateKey: await box(masterKey, pkcs8, AAD.priv(r.userId)),
  });
  const keys = { priv: await importPrivateKey(pkcs8), pub: fromB64(r.publicKey) };
  await storeKeys(done.user.id, keys);
  return { user: done.user, keys };
}

export async function changePassword(user: User, current: string, next: string): Promise<void> {
  const k = await api.get<{ salt: string; encPrivateKey: string }>("/auth/keys");
  const old = await deriveAccountKeys(current, k.salt);
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await unbox(old.masterKey, k.encPrivateKey, AAD.priv(user.id));
  } catch {
    throw new Error("Mot de passe actuel incorrect");
  }
  const newSalt = toB64(randomBytes(16));
  const fresh = await deriveAccountKeys(next, newSalt);
  await api.post("/auth/password", {
    authKey: old.authKey,
    newSalt,
    newAuthKey: fresh.authKey,
    newEncPrivateKey: await box(fresh.masterKey, pkcs8, AAD.priv(user.id)),
  });
}
