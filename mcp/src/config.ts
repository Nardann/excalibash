// Local configuration of the MCP client: where the session cookie and the account private key
// live on disk. Same trust model as the agent's agent.json (see docs/MCP.md).
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type McpConfig = {
  url: string;
  cookie: string;
  userId: string;
  email: string;
  /** Account public key, base64url (re-derived from the private key at startup). */
  publicKey: string;
  /** PKCS#8 private key, base64url. */
  pkcs8: string;
};

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "excalibash", "mcp.json");
}

export const resolveConfigPath = (p?: string) => resolve(p || defaultConfigPath());
export const auditPath = (configPath: string) => join(dirname(configPath), "mcp-audit.log");

const posix = process.platform !== "win32";

/** Like ssh: a key file readable by group or others is refused. */
function checkPermissions(path: string) {
  if (!posix) return;
  const st = statSync(path);
  if (st.mode & 0o077) {
    throw new Error(
      `Le fichier ${path} est lisible par d'autres utilisateurs (mode ${(st.mode & 0o777).toString(8)}). ` +
        `Il contient ta clé privée : corrige avec « chmod 600 ${path} » ou relance « login ».`,
    );
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`Le fichier ${path} appartient à un autre utilisateur : refusé.`);
  }
}

export function loadConfig(path: string, opts: { skipPermissions?: boolean } = {}): McpConfig {
  if (!existsSync(path)) throw new Error(`Aucune connexion enregistrée (${path}). Lance d'abord : node excalibash-mcp.mjs login`);
  if (!opts.skipPermissions) checkPermissions(path);
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Le fichier ${path} est illisible ou corrompu : relance « login ».`);
  }
  for (const k of ["url", "cookie", "userId", "email", "publicKey", "pkcs8"] as const) {
    if (typeof raw?.[k] !== "string" || !raw[k]) throw new Error(`Le fichier ${path} est incomplet (champ « ${k} » manquant) : relance « login ».`);
  }
  return raw as McpConfig;
}

/** Writes the config in a 0700 directory with mode 0600 from the first byte (temp file + rename). */
export function saveConfig(path: string, cfg: McpConfig) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (posix) chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  if (posix) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function deleteConfig(path: string) {
  rmSync(path, { force: true });
}

/**
 * Appends one line to the audit log (0600). Only metadata is written, never what was typed:
 * it could hold secrets.
 */
export function audit(configPath: string, line: string) {
  const file = auditPath(configPath);
  const text = `${new Date().toISOString()} ${line}`;
  process.stderr.write(`[audit] ${text}\n`);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(file);
    const fd = openSync(file, "a", 0o600);
    try {
      appendFileSync(fd, text + "\n");
    } finally {
      closeSync(fd);
    }
    if (fresh && posix) chmodSync(file, 0o600);
  } catch (e) {
    process.stderr.write(`[audit] écriture impossible : ${(e as Error).message}\n`);
    throw new Error("Journal d'audit inaccessible : action refusée.");
  }
}
