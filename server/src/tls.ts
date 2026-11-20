import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, isIP, isIPv4, type Socket } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { config } from "./config.ts";

// HTTPS out of the box. Without a certificate from the admin, the instance makes its own
// (self-signed) on first start; scripts and agents pin its public key instead of trusting a CA.

type Tls = { cert: string; key: string; selfSigned: boolean; pin: string | null };

let tls: Tls | null = null;

/** curl --pinnedpubkey format: sha256//<base64 of the SHA-256 of the DER SubjectPublicKeyInfo>. */
export function spkiPin(cert: X509Certificate): string {
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  return "sha256//" + createHash("sha256").update(spki).digest("base64");
}

/** Loads (or creates) the certificate. Call once at startup, before serving. */
export function initTls(): void {
  if (config.tls.mode === "off") return;
  if (config.tls.cert || config.tls.key) {
    if (!config.tls.cert || !config.tls.key) throw new Error("TLS_CERT et TLS_KEY vont ensemble");
    tls = { cert: readFileSync(config.tls.cert, "utf8"), key: readFileSync(config.tls.key, "utf8"), selfSigned: false, pin: null };
  } else {
    tls = selfSigned();
  }
  const x509 = new X509Certificate(tls.cert);
  console.log(`[tls] certificat ${tls.selfSigned ? "auto-signé" : "fourni"}, empreinte SHA-256 ${x509.fingerprint256}`);
  if (tls.pin) console.log(`[tls] épingle (curl --pinnedpubkey, agent --pin) : ${tls.pin}`);
}

/** What /api/config tells the browser. */
export function tlsInfo(req: IncomingMessage): { selfSigned: boolean; pin: string | null } | null {
  return tls && { selfSigned: tls.selfSigned, pin: pinFor(req) };
}

/**
 * Pin to put in install commands. Only for our own self-signed certificate reached directly: a
 * reverse proxy in front (it adds X-Forwarded-For) presents its own certificate.
 */
export function pinFor(req: IncomingMessage): string | null {
  if (!tls?.pin || req.headers["x-forwarded-for"] || req.headers.forwarded) return null;
  return tls.pin;
}

/** The self-signed certificate, for browsers and systems to install (null otherwise). */
export function certificatePem(): string | null {
  return tls?.selfSigned ? tls.cert : null;
}

// ---- self-signed certificate ---------------------------------------------------------

function wantedSans(): string[] {
  const names = new Set(["localhost", "127.0.0.1", "::1", hostname().toLowerCase()]);
  for (const list of Object.values(networkInterfaces())) {
    // Link-local IPv6 needs a zone and never appears in a URL.
    for (const a of list ?? []) if (!a.internal && !/^fe80:/i.test(a.address)) names.add(a.address);
  }
  for (const url of [config.publicUrl, config.proxyUrl]) {
    if (url) names.add(new URL(url).hostname.replace(/^\[|\]$/g, ""));
  }
  for (const s of config.tls.sans) names.add(s);
  // Anything else could not be written in the certificate (IA5String).
  return [...names].filter((n) => isIP(n) || /^[a-z0-9*._-]+$/.test(n)).sort();
}

function selfSigned(): Tls {
  const dir = join(config.dataDir, "tls");
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const sansPath = join(dir, "sans.json");
  const sans = wantedSans();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  let cert = existsSync(certPath) ? readFileSync(certPath, "utf8") : "";
  let key = existsSync(keyPath) ? readFileSync(keyPath, "utf8") : "";
  const known = existsSync(sansPath) ? readFileSync(sansPath, "utf8") : "";
  const valid = (() => {
    try {
      const x = new X509Certificate(cert);
      return x.checkPrivateKey(createPrivateKey(key)) && Date.parse(x.validTo) > Date.now() + 30 * 86400_000;
    } catch {
      return false;
    }
  })();

  if (!valid || known !== JSON.stringify(sans)) {
    // Keep the key when only the names change: the pin, and so the paired agents, stay valid.
    let priv: KeyObject;
    try {
      priv = createPrivateKey(key);
      if (priv.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    } catch {
      priv = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
      key = priv.export({ type: "pkcs8", format: "pem" }).toString();
      write(keyPath, key, 0o600);
    }
    cert = makeCertificate(priv, sans);
    write(certPath, cert, 0o644);
    write(sansPath, JSON.stringify(sans), 0o644);
    console.log(`[tls] certificat auto-signé généré pour : ${sans.join(", ")}`);
  }
  chmodSync(keyPath, 0o600);
  return { cert, key, selfSigned: true, pin: spkiPin(new X509Certificate(cert)) };
}

function write(path: string, data: string, mode: number): void {
  writeFileSync(path + ".tmp", data, { mode });
  chmodSync(path + ".tmp", mode);
  renameSync(path + ".tmp", path);
}

// Minimal DER encoder: just what an X.509 v3 certificate needs.
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const hex = n.toString(16);
  const b = Buffer.from(hex.padStart(hex.length + (hex.length % 2), "0"), "hex");
  return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
}
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const ctx = (n: number, ...parts: Buffer[]) => tlv(0xa0 + n, ...parts);
const int = (b: Buffer) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const octets = (b: Buffer) => tlv(0x04, b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >>> 7; v; v >>>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
}

function ipBytes(ip: string): Buffer {
  if (isIPv4(ip)) return Buffer.from(ip.split(".").map(Number));
  let v6 = ip;
  const v4 = v6.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    v6 = v6.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = v6.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return Buffer.from(groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]));
}

export function makeCertificate(key: KeyObject, sans: string[], now = new Date()): string {
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(tlv(0x31, seq(oid("2.5.4.3"), utf8("Excalibash"))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 10);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const altNames = sans.map((s) => (isIP(s) ? tlv(0x87, ipBytes(s)) : tlv(0x82, Buffer.from(s, "ascii"))));
  const critical = tlv(0x01, Buffer.from([0xff]));
  const extensions = seq(
    seq(oid("2.5.29.19"), critical, octets(seq())), // basicConstraints: CA:FALSE
    seq(oid("2.5.29.15"), critical, octets(bits(Buffer.from([0x80]), 7))), // keyUsage: digitalSignature
    seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))), // extKeyUsage: serverAuth
    seq(oid("2.5.29.14"), octets(octets(createHash("sha1").update(spki).digest()))), // subjectKeyIdentifier
    seq(oid("2.5.29.17"), octets(seq(...altNames))), // subjectAltName
  );
  const tbs = seq(ctx(0, int(Buffer.from([2]))), int(serial), ecdsaSha256, name, seq(time(notBefore), time(notAfter)), name, spki, ctx(3, extensions));
  const signature = sign("sha256", tbs, { key, dsaEncoding: "der" });
  const der = seq(tbs, ecdsaSha256, bits(signature));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

// ---- listening -------------------------------------------------------------------------

type Upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
export type Listener = { close(): void };

/**
 * Serves `app` on `port`. With TLS, the same port speaks HTTPS and plain HTTP (sniffed on the
 * first byte): plain HTTP is redirected, except the /agent websocket of agents paired over http://.
 */
export function serve(app: RequestListener, port: number, label: string, upgrade?: Upgrade): Listener {
  if (!tls) {
    const server = createHttpServer(app);
    if (upgrade) server.on("upgrade", upgrade);
    server.listen(port, config.host, () => console.log(`${label} sur http://${config.host}:${port}`));
    return server;
  }

  const secure = createHttpsServer({ cert: tls.cert, key: tls.key }, app);
  const plain = createHttpServer((req, res) => redirect(req, res, port));
  if (upgrade) secure.on("upgrade", upgrade);
  plain.on("upgrade", (req, socket, head) => {
    if (upgrade && new URL(req.url ?? "/", "http://x").pathname === "/agent") return upgrade(req, socket, head);
    const to = httpsUrl(req, port);
    socket.end(to ? `HTTP/1.1 308 Permanent Redirect\r\nLocation: ${to}\r\nConnection: close\r\n\r\n` : "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const front = createNetServer((socket: Socket) => {
    socket.on("error", () => socket.destroy());
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once("data", (first: Buffer) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(first);
      // 0x16: TLS handshake record. Both servers pick up the buffered bytes.
      (first[0] === 0x16 ? secure : plain).emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
  });
  front.listen(port, config.host, () => console.log(`${label} sur https://${config.host}:${port} (HTTP redirigé)`));
  return {
    close() {
      front.close();
      secure.close();
      plain.close();
    },
  };
}

function httpsUrl(req: IncomingMessage, port: number): string | null {
  try {
    const u = new URL(`http://${req.headers.host ?? ""}`);
    if (!u.hostname || u.username || u.password || u.pathname !== "/") return null;
    const path = req.url?.startsWith("/") ? req.url : "/";
    return `https://${u.hostname}:${u.port || port}${path}`;
  } catch {
    return null;
  }
}

function redirect(req: IncomingMessage, res: ServerResponse, port: number): void {
  const to = httpsUrl(req, port);
  if (!to) {
    res.writeHead(400).end();
    return;
  }
  res.writeHead(308, { Location: to, "Content-Type": "text/plain; charset=utf-8" }).end(`HTTPS : ${to}\n`);
}
