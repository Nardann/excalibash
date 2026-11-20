// HTTPS by default: self-signed certificate, pin, HTTP → HTTPS redirect on the same port, plain
// /agent websocket kept for agents paired over http://, pinned install scripts, agent --pin.
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";

const root = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.TLS_PORT ?? 6791);
const PROXY_PORT = Number(process.env.TLS_PROXY_PORT ?? 6792);
const DATA = mkdtempSync(join(tmpdir(), "excalibash-tls-"));

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

let server: ChildProcess | null = null;
let log = "";
async function start(env: Record<string, string> = {}): Promise<void> {
  log = "";
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "server/src/index.ts")], {
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), PROXY_PORT: String(PROXY_PORT), TLS: "auto", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => (log += d));
  server.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !/Tunnels web.*sur https?:/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  if (!/Tunnels web.*sur https?:/.test(log)) throw new Error(`le serveur ne démarre pas :\n${log}`);
}
async function stop(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((r) => {
    s.once("exit", r);
    s.kill("SIGTERM");
  });
}

type Res = { status: number; headers: Record<string, any>; body: string };
function get(url: string, opts: Record<string, any> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, opts, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Websocket handshake with a bad token: the server answers 401 instead of upgrading. */
function wsAgent(url: string, opts: Record<string, any> = {}): Promise<Res> {
  return get(url, {
    ...opts,
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Authorization: "Bearer eba_nope" },
  });
}

/** Certificate the server actually presents. */
function served(): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port: PORT, rejectUnauthorized: false }, () => {
      resolve(new X509Certificate(s.getPeerCertificate().raw));
      s.end();
    });
    s.on("error", reject);
  });
}

const pinOf = (x: X509Certificate) => "sha256//" + createHash("sha256").update(x.publicKey.export({ type: "spki", format: "der" })).digest("base64");

try {
  await start();
  const base = `https://127.0.0.1:${PORT}`;
  const certPath = join(DATA, "tls", "cert.pem");
  const keyPath = join(DATA, "tls", "key.pem");
  ok(existsSync(certPath) && existsSync(keyPath), "certificat et clé créés dans DATA_DIR/tls");
  ok((statSync(keyPath).mode & 0o777) === 0o600, "clé privée en 0600");

  const pem = readFileSync(certPath, "utf8");
  const cert = new X509Certificate(pem);
  const sans = cert.subjectAltName ?? "";
  ok(sans.includes("DNS:localhost") && sans.includes("IP Address:127.0.0.1"), `SAN : localhost et 127.0.0.1 (${sans.slice(0, 80)}…)`);
  ok(cert.subject.includes("CN=Excalibash") && !cert.ca, "CN Excalibash, pas une autorité");
  const years = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / (365.25 * 86400_000);
  ok(years > 9.9 && years < 10.1 && Date.parse(cert.validFrom) <= Date.now(), "valable 10 ans à partir de maintenant");
  ok(cert.checkPrivateKey(createPrivateKey(readFileSync(keyPath))), "la clé correspond au certificat");
  ok(cert.verify(cert.publicKey), "certificat auto-signé valide");

  const live = await served();
  ok(live.fingerprint256 === cert.fingerprint256, "le port sert ce certificat");
  ok(log.includes(cert.fingerprint256), "empreinte SHA-256 dans les logs");

  const cfg = await get(`${base}/api/config`, { ca: pem });
  const tls = JSON.parse(cfg.body).tls;
  ok(cfg.status === 200 && tls?.selfSigned === true, "HTTPS vérifié avec le certificat comme autorité");
  ok(tls?.pin === pinOf(live), `/api/config annonce l'épingle du certificat servi (${tls?.pin})`);
  const proxied = await get(`${base}/api/config`, { ca: pem, headers: { "X-Forwarded-For": "203.0.113.1" } });
  ok(JSON.parse(proxied.body).tls?.pin === null, "pas d'épingle derrière un reverse proxy");

  const redir = await get(`http://127.0.0.1:${PORT}/machines?x=1`);
  ok(redir.status === 308 && redir.headers.location === `https://127.0.0.1:${PORT}/machines?x=1`, `HTTP clair → 308 ${redir.headers.location}`);
  const redirProxy = await get(`http://localhost:${PROXY_PORT}/t/abc/`);
  ok(redirProxy.status === 308 && redirProxy.headers.location === `https://localhost:${PROXY_PORT}/t/abc/`, "port des tunnels : 308 aussi");

  const plainAgent = await wsAgent(`http://127.0.0.1:${PORT}/agent`);
  ok(plainAgent.status === 401, `websocket /agent en HTTP clair servie, pas redirigée (${plainAgent.status})`);
  const plainWs = await wsAgent(`http://127.0.0.1:${PORT}/ws`);
  ok(plainWs.status === 308, "websocket /ws en HTTP clair redirigée");
  const tlsAgent = await wsAgent(`${base}/agent`, { ca: pem });
  ok(tlsAgent.status === 401, "websocket /agent en HTTPS");
  const tlsWs = await wsAgent(`${base}/ws`, { ca: pem });
  ok(tlsWs.status === 401, "websocket /ws en HTTPS");

  const dl = await get(`${base}/certificate.pem`, { ca: pem });
  ok(dl.status === 200 && dl.body === pem && /application\/x-pem-file/.test(dl.headers["content-type"]) && /excalibash\.pem/.test(dl.headers["content-disposition"]), "/certificate.pem servi");

  const install = (await get(`${base}/install.sh`, { ca: pem })).body;
  ok(install.includes(`PIN='${tls.pin}'`) && install.includes('--pinnedpubkey "$PIN"') && install.includes('--pin "$PIN"'), "install.sh épinglé (curl et agent)");
  const pair = (await get(`${base}/p/ABC234`, { ca: pem })).body;
  ok(pair.includes(`PIN='${tls.pin}'`) && pair.includes('--pinnedpubkey "$PIN"') && pair.includes('--pin "$PIN"') && !pair.includes("wget"), "/p/<code> épinglé, sans wget");

  const boot = (await get(`https://127.0.0.1:${PROXY_PORT}/eb-proxy/boot.js`, { ca: pem })).body;
  ok(boot.includes(`"https://127.0.0.1:${PORT}/certificate.pem"`), "page de tunnel : lien vers le certificat");

  let hasCurl = true;
  try {
    execFileSync("curl", ["--version"], { stdio: "ignore" });
  } catch {
    hasCurl = false;
  }
  if (hasCurl) {
    const curl = (pin: string) => {
      try {
        return execFileSync("curl", ["-k", "--pinnedpubkey", pin, "-fsS", `${base}/healthz`], { stdio: ["ignore", "pipe", "ignore"] }).toString();
      } catch {
        return "";
      }
    };
    ok(curl(tls.pin).includes('"ok":true'), "curl -k --pinnedpubkey : bonne épingle acceptée");
    ok(curl("sha256//" + Buffer.alloc(32).toString("base64")) === "", "curl -k --pinnedpubkey : mauvaise épingle refusée");
  }

  const agentBin = join(root, `agent/dist/excalibash-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`);
  // Guarded so the rest runs with an agent built before --pin existed.
  const help = existsSync(agentBin) ? spawnSync(agentBin, ["-h"], { encoding: "utf8" }) : null;
  const pinSupport = !!help && /-pin\b/.test(help.stdout + help.stderr);
  if (pinSupport) {
    const wrong = "sha256//" + Buffer.alloc(32, 7).toString("base64");
    /** Runs the agent for a moment and returns what it printed. */
    const run = (args: string[], env: Record<string, string> = {}) =>
      new Promise<string>((resolve) => {
        const p = spawn(agentBin, args, { env: { ...process.env, HOME: DATA, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        const t = setTimeout(() => p.kill(), 2500);
        p.on("exit", () => {
          clearTimeout(t);
          resolve(out);
        });
      });
    const pairArgs = ["--server", base, "--pair", "ZZZ999", "--pair-only", "--config", join(DATA, "agent.json")];
    const pairOk = await run([...pairArgs, "--pin", tls.pin]);
    ok(/code inconnu/.test(pairOk), "agent --pin : appairage joint le serveur (code inconnu attendu)");
    const pairBad = await run([...pairArgs, "--pin", wrong]);
    ok(!/code inconnu/.test(pairBad) && /attendu/.test(pairBad), "agent --pin : mauvaise épingle refusée à l'appairage");
    const creds = { EXCALIBASH_TOKEN: "eba_nope", EXCALIBASH_KEY: randomBytes(32).toString("base64url") };
    const wsOk = await run(["--server", base, "--pin", tls.pin], creds);
    ok(/401/.test(wsOk), "agent --pin : websocket établie (jeton refusé par le serveur, 401)");
    const wsBad = await run(["--server", base, "--pin", wrong], creds);
    ok(!/401/.test(wsBad) && /attendu/.test(wsBad), "agent --pin : mauvaise épingle refusée sur la websocket");
    const wsPlain = await run(["--server", `http://127.0.0.1:${PORT}`], creds);
    ok(/401/.test(wsPlain), "agent en http:// : /agent toujours servi");
  } else {
    console.log("· agent sans --pin : tests de l'agent ignorés");
  }

  await stop();
  await start({ TLS_SANS: "excalibash.test, 10.11.12.13" });
  const cert2 = new X509Certificate(readFileSync(certPath, "utf8"));
  ok(cert2.fingerprint256 !== cert.fingerprint256, "TLS_SANS modifié : certificat régénéré");
  ok(cert2.subjectAltName?.includes("DNS:excalibash.test") && cert2.subjectAltName.includes("IP Address:10.11.12.13"), "les SAN de TLS_SANS apparaissent");
  ok(pinOf(cert2) === tls.pin, "même clé, donc même épingle");
  await stop();
  await start({ TLS_SANS: "excalibash.test, 10.11.12.13" });
  ok(new X509Certificate(readFileSync(certPath, "utf8")).fingerprint256 === cert2.fingerprint256, "redémarrage sans changement : certificat conservé");
  await stop();

  await start({ TLS: "off" });
  const off = await get(`http://127.0.0.1:${PORT}/api/config`);
  ok(off.status === 200 && JSON.parse(off.body).tls === null, "TLS=off : HTTP seul, tls: null");
  ok((await get(`http://127.0.0.1:${PORT}/certificate.pem`)).status === 404, "TLS=off : pas de /certificate.pem");
  ok(!(await get(`http://127.0.0.1:${PORT}/install.sh`)).body.includes("PIN"), "TLS=off : scripts sans épingle");
} catch (e) {
  console.error(e);
  console.error(log);
  failures++;
} finally {
  await stop();
  rmSync(DATA, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} échec(s)` : "\nTLS : tout est vert");
process.exit(failures ? 1 : 0);
