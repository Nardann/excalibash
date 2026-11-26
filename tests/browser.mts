// Real-browser end-to-end: drives the built web app in Chrome (Playwright) against a throwaway server and the real agent.
// Run through tests/run.sh (BASE, DB = the server's database file, CHROME_PATH optional).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "../web/node_modules/playwright-core/index.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:6797";
const DB = process.env.DB!;
const DATA = dirname(DB);
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const SHOTS = join(DATA, "shots");

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const block = (name: string) => console.log(`\n# ${name}`);

if (!existsSync(CHROME)) {
  console.log(`⚠ Chrome introuvable (${CHROME}) : suite navigateur ignorée (définir CHROME_PATH).`);
  process.exit(process.env.CI ? 1 : 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns something truthy (no blind sleeps). */
async function until<T>(what: string, fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`délai dépassé : ${what}${last ? ` (${(last as Error).message?.split("\n")[0]})` : ""}`);
    await sleep(150);
  }
}

// Console messages that are not application bugs. Keep this list short and justified.
const blocked = { scripts: 0 };
const ALLOWED_CONSOLE: RegExp[] = [
  // Chrome reports the script the sandboxed notebook frame refused to run: that is the sandbox working (counted in the notebook block).
  /Blocked script execution in 'about:srcdoc'/,
  // Logged out (or not yet unlocked) pages ask /api/auth/me: the 401 is the expected answer.
  /Failed to load resource: the server responded with a status of 401/,
];

const problems: string[] = [];
let shotN = 0;
function track(page: Page, label: string) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Blocked script execution in 'about:srcdoc'/.test(t)) blocked.scripts++;
    if (ALLOWED_CONSOLE.some((r) => r.test(t))) return;
    problems.push(`[${label}] console: ${t} @ ${m.location().url}`);
  });
  page.on("pageerror", (e) => problems.push(`[${label}] exception: ${e.message}`));
}
const takeProblems = () => problems.splice(0);
async function noConsoleErrors(msg: string) {
  await sleep(300);
  const p = takeProblems();
  if (p.length) console.log(p.map((x) => `    ${x}`).join("\n"));
  ok(p.length === 0, msg);
}

const pages = new Map<string, Page>();
async function shot(why: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, p] of pages) {
    const f = join(SHOTS, `${String(++shotN).padStart(2, "0")}-${why.replace(/\W+/g, "_").slice(0, 40)}-${label}.png`);
    await p.screenshot({ path: f }).then(() => console.log(`    capture : ${f}`), () => {});
  }
}

/** Last verification code emailed to `email`, read from the server log (SMTP_TRANSPORT=log). */
const mailCode = (email: string) =>
  readFileSync(`${DATA}/server.log`, "utf8").split("\n").filter((l) => l.startsWith(`[mail] to=${email} `)).at(-1)?.match(/code=(\d{6})/)?.[1] ?? "";
const setupCode = () => readFileSync(`${DATA}/server.log`, "utf8").match(/Code d'installation[^:]*: ([A-Z0-9-]+)/)?.[1] ?? "";

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(`/api${p}`, { method: m as string, headers: b ? { "content-type": "application/json" } : {}, body: (b as string) || undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [method, path, body ? JSON.stringify(body) : ""] as const,
  );
}

const browser: Browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const agentBin = new URL(`../agent/dist/excalibash-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`, import.meta.url).pathname;
const children: ChildProcess[] = [];

async function newUser(label: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, baseURL: BASE, locale: "fr-FR" });
  const page = await ctx.newPage();
  track(page, label);
  pages.set(label, page);
  return { ctx, page };
}

/** Registers through the UI (the verification step too when the server asks for it). */
async function registerUI(page: Page, email: string, name: string, password: string, setup?: string) {
  await page.goto("/register");
  if (setup) await page.getByLabel("Code d'installation").fill(setup);
  await page.getByLabel("Nom", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await page.getByLabel("Confirmation").fill(password);
  await page.getByRole("button", { name: "Créer le compte" }).click();
  const code = page.getByLabel("Code", { exact: true });
  const recovery = page.getByRole("heading", { name: "Ta clé de récupération" });
  await until("code email ou clé de récupération", async () => (await code.isVisible()) || (await recovery.isVisible()), 60000);
  if (await code.isVisible()) {
    await until("code email dans le log", () => mailCode(email));
    await code.fill(mailCode(email));
    await page.getByRole("button", { name: "Valider" }).click();
    await recovery.waitFor({ timeout: 20000 });
  }
  const key = (await page.locator(".codebox").first().innerText()).trim();
  await page.getByLabel(/Je l'ai rangée/).check();
  await page.getByRole("button", { name: "Continuer" }).click();
  return key;
}

async function loginUI(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
}

try {
  // ---- 1. Setup ----
  block("1. Installation et inscription");
  const A = await newUser("alice");
  const recoveryKey = await registerUI(A.page, "alice@test.local", "Alice", "alice-password-1", setupCode());
  ok(/^[A-Z0-9]{4}(-[A-Z0-9]{4})+$/.test(recoveryKey), "la clé de récupération est affichée une fois, puis acquittée");
  await A.page.getByRole("region", { name: "Guide de démarrage" }).waitFor();
  ok(true, "le guide de démarrage s'affiche après la première connexion");
  await A.page.getByRole("button", { name: "Passer" }).click();
  await until("guide fermé", async () => !(await A.page.getByRole("region", { name: "Guide de démarrage" }).isVisible()));
  ok(true, "le guide de démarrage se ferme");
  await noConsoleErrors("inscription : aucune erreur console");

  // Bob: signs up through the API of the open registration (setting enabled by the admin), then logs in through the UI.
  await api(A.page, "PATCH", "/admin/settings", { registrationOpen: true });
  const B = await newUser("bob");
  await registerUI(B.page, "bob@test.local", "Bob", "bob-password-1");
  await B.page.getByRole("region", { name: "Guide de démarrage" }).getByRole("button", { name: "Passer" }).click();
  ok(await B.page.getByText("Une page blanche…").isVisible(), "Bob s'inscrit par l'interface et arrive sur un tableau de bord vide");

  // ---- 2. Dashboard ----
  block("2. Tableau de bord");
  await A.page.goto("/");
  await A.page.getByRole("button", { name: "Dossier", exact: true }).click();
  const folderCard = A.page.locator(".card-title", { hasText: "Nouveau dossier" });
  await folderCard.waitFor();
  await folderCard.dblclick();
  await A.page.locator(".card-title input").fill("TP réseau");
  await A.page.keyboard.press("Enter");
  await A.page.locator(".card-title", { hasText: "TP réseau" }).waitFor();
  ok(true, "création d'un dossier puis renommage au double-clic");
  await A.page.locator(".card-title", { hasText: "TP réseau" }).click();
  await A.page.waitForURL(/\/folder\//);
  await A.page.getByRole("button", { name: "Tableau", exact: true }).click();
  await A.page.waitForURL(/\/board\//);
  const boardUrl = A.page.url();
  await A.page.getByRole("button", { name: "Sans titre" }).click();
  await A.page.locator("input.board-title").fill("Archi labo");
  await A.page.keyboard.press("Enter");
  await A.page.getByRole("button", { name: "Archi labo" }).waitFor();
  ok(true, "création d'un tableau dans le dossier, ouverture et renommage dans l'en-tête");
  await A.page.locator(".excalidraw").first().waitFor();
  ok(await A.page.locator(".excalidraw canvas").first().isVisible(), "le canvas Excalidraw s'affiche");
  await A.page.getByRole("button", { name: "Retour" }).click();
  await A.page.locator(".card-title", { hasText: "Archi labo" }).waitFor();
  ok(true, "le nouveau nom du tableau apparaît dans la liste du dossier");
  await A.page.locator(".card-title", { hasText: "Archi labo" }).click();
  await A.page.waitForURL(boardUrl);
  const before = await A.page.evaluate(() => document.documentElement.classList.contains("dark"));
  await A.page.getByRole("button", { name: /^Thème (sombre|clair)$/ }).click();
  const after = await until("thème changé", () => A.page.evaluate((b) => document.documentElement.classList.contains("dark") !== b, before));
  ok(after, "le bouton de thème bascule clair / sombre");
  await noConsoleErrors("tableau de bord et tableau : aucune erreur console");

  // ---- 3. Machine ----
  block("3. Machine appairée par code");
  await A.page.goto("/machines");
  await A.page.getByRole("button", { name: "Ajouter avec un code" }).click();
  const code = (await A.page.locator(".pair-code").innerText()).trim();
  ok(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/i.test(code), "le code d'appairage s'affiche");
  const agentHome = mkdtempSync(join(tmpdir(), "eb-agent-"));
  const agentLog: string[] = [];
  const agent = spawn(agentBin, ["--server", BASE, "--pair", code.toLowerCase(), "--config", join(agentHome, "agent.json"), "--name", "vm-tp"], { cwd: agentHome, env: { ...process.env, HOME: agentHome }, stdio: ["ignore", "ignore", "pipe"] });
  agent.stderr!.on("data", (d) => agentLog.push(String(d)));
  children.push(agent);
  await A.page.getByRole("button", { name: "C'est la même" }).click({ timeout: 30000 });
  const fp = (await A.page.locator(".pair-fp").innerText().catch(() => "")).trim();
  await until("agent en ligne", () => A.page.locator(".dot.on").first().isVisible(), 30000);
  ok(await A.page.getByText("vm-tp").first().isVisible(), "l'agent réel est appairé depuis l'interface et la machine s'affiche");
  ok(!fp || agentLog.join("").includes(fp), "l'empreinte vue dans le navigateur est celle de l'agent");
  await noConsoleErrors("machines : aucune erreur console");

  // ---- 4. Terminal on the board ----
  block("4. Terminal sur le tableau");
  const activeTool = (p: Page) => p.locator('input[data-testid^="toolbar-"]:checked').first().getAttribute("data-testid");
  await A.page.goto(boardUrl);
  await A.page.locator(".excalidraw canvas").first().waitFor();
  await A.page.locator(".excalidraw .layer-ui__wrapper").first().click({ position: { x: 5, y: 5 }, trial: true }).catch(() => {});
  await A.page.keyboard.press("Alt+t");
  await A.page.getByRole("button", { name: /vm-tp/ }).click();
  const term = A.page.locator(".xterm").first();
  await term.waitFor({ timeout: 30000 });
  ok(true, "Alt+T propose la machine, le shell s'ouvre dans une fenêtre xterm");
  await until("shell prêt", async () => (await A.page.locator(".term-head .status", { hasText: /connect|actif|en cours/i }).count()) > 0 || (await term.locator(".xterm-rows").innerText()).trim().length > 0, 30000);
  await term.click();
  const toolBefore = await activeTool(A.page);
  await A.page.keyboard.type("echo bonjour-$((6*7)) rrrr ppp");
  await A.page.keyboard.press("Enter");
  await until("sortie du shell", async () => /bonjour-42 rrrr ppp/.test(await term.locator(".xterm-rows").innerText()), 20000);
  ok(true, "la saisie atteint le shell réel et la sortie « bonjour-42 » apparaît dans le DOM xterm");
  ok((await activeTool(A.page)) === toolBefore, `les touches tapées dans le terminal ne changent pas l'outil Excalidraw (${toolBefore})`);
  await noConsoleErrors("terminal : aucune erreur console");

  // ---- 5. Shared code window ----
  block("5. Fenêtre de code partagée (Alice + Bob)");
  await A.page.getByRole("button", { name: "Partager", exact: true }).click();
  await A.page.getByLabel("Nom ou email").fill("Bob");
  const share = A.page.getByRole("dialog");
  await share.getByRole("button", { name: "Chercher", exact: true }).click();
  await share.getByRole("button", { name: /Bob/ }).first().click();
  await share.getByRole("button", { name: /^Partager \(/ }).click();
  await until("Bob est membre", async () => (await share.getByTitle("Retirer l'accès").count()) > 0);
  ok((await share.locator(".row", { hasText: "Bob" }).locator("select").inputValue()) === "editor", "le tableau est partagé avec Bob comme éditeur");
  await share.getByRole("button", { name: "Fermer" }).click();
  const dockA = A.page.getByRole("complementary", { name: "Fenêtres du tableau" });
  await dockA.getByTitle("Nouveau fichier de code").click();
  const editorA = A.page.locator(".monaco-editor").first();
  await editorA.waitFor({ timeout: 30000 });
  /** Puts the caret in the Monaco of a window: an unselected window first needs a click that selects it on the canvas. */
  const focusEditor = async (p: Page) => {
    const lines = p.locator(".monaco-editor .view-lines").first();
    await until("éditeur Monaco focalisé", async () => {
      await lines.click({ position: { x: 300, y: 8 }, force: true });
      return p.evaluate(() => !!document.activeElement?.closest(".monaco-editor"));
    });
  };
  const textOf = async (p: Page) => (await p.locator(".monaco-editor .view-lines").first().innerText()).replace(/\u00a0/g, " ").trim();
  await focusEditor(A.page);
  await A.page.keyboard.type("# ligne alice");
  await until("texte d'Alice", async () => (await textOf(A.page)).includes("# ligne alice"));
  ok((await activeTool(A.page)) === "toolbar-selection", "taper dans Monaco ne change pas l'outil Excalidraw");
  ok((await A.page.locator(".excalidraw-container").evaluate((el) => el.scrollTop)) === 0, "donner le focus à une fenêtre qui déborde du canvas ne fait pas défiler le tableau");

  await B.page.goto(boardUrl);
  const dockB = B.page.getByRole("complementary", { name: "Fenêtres du tableau" });
  await dockB.waitFor({ timeout: 30000 });
  // The window is open for everyone by default; if not, open it from the dock.
  await until("fenêtre de code de Bob", () => B.page.locator(".monaco-editor").count(), 5000).catch(() => dockB.getByText("Code 1").click());
  await B.page.locator(".monaco-editor").first().waitFor({ timeout: 30000 });
  await until("Bob voit le texte d'Alice", async () => (await textOf(B.page)).includes("# ligne alice"), 15000);
  ok(true, "Bob voit le texte d'Alice dans Monaco");
  await focusEditor(B.page);
  await B.page.keyboard.press("Control+End");
  await B.page.keyboard.type("\n# ligne bob");
  await until("Alice voit Bob", async () => (await textOf(A.page)).includes("# ligne bob"), 15000);
  ok(true, "Alice voit ce que Bob tape");
  await focusEditor(A.page);
  await A.page.keyboard.press("Control+End");
  await A.page.keyboard.type("\n# fin alice");
  await until("convergence", async () => (await textOf(A.page)) === (await textOf(B.page)) && (await textOf(B.page)).includes("# fin alice"), 15000);
  ok((await textOf(A.page)) === (await textOf(B.page)), "les deux éditeurs convergent vers le même texte");
  const remote = await until("curseur distant", () => A.page.locator('[class*="yRemoteSelectionHead-"]').first().evaluate((el) => getComputedStyle(el, "::after").content), 10000);
  ok(remote.includes("Bob"), `le curseur distant de Bob est affiché avec son nom (${remote})`);

  // Ctrl+S on an unsaved document asks where, then writes on the machine.
  await A.page.keyboard.press("Control+s");
  const pathInput = A.page.getByLabel("Chemin du fichier sur la machine");
  await pathInput.waitFor();
  await pathInput.fill("demo.py");
  await A.page.keyboard.press("Enter");
  const demo = join(agentHome, "demo.py");
  await until("fichier sur la machine", () => existsSync(demo), 15000);
  const saved = readFileSync(demo, "utf8");
  ok(saved.includes("# ligne alice") && saved.includes("# ligne bob") && saved.includes("# fin alice"), "Ctrl+S puis « Enregistrer sous » écrit demo.py sur la machine avec le texte partagé");

  // Monaco hit-testing under a zoomed canvas (CSS transform): a click lands on the character under the pointer.
  const zoomOf = async (p: Page) => parseInt(await p.locator(".reset-zoom-button").innerText(), 10);
  const z0 = await zoomOf(A.page);
  await A.page.mouse.move(600, 500);
  await A.page.keyboard.down("Control");
  for (let i = 0; i < 3; i++) await A.page.mouse.wheel(0, -100);
  await A.page.keyboard.up("Control");
  await until("zoom appliqué", async () => (await zoomOf(A.page)) > z0);
  const firstLine = A.page.locator(".monaco-editor .view-line").first();
  const line1 = (await firstLine.innerText()).replace(/\u00a0/g, " ");
  const box = (await firstLine.locator("span > span").first().boundingBox())!;
  await A.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await A.page.keyboard.type("Z");
  const idx = await until("lettre insérée", async () => {
    const l = (await firstLine.innerText()).replace(/\u00a0/g, " ");
    return l.includes("Z") ? l.indexOf("Z") : false;
  });
  ok(Math.abs(idx - line1.length / 2) <= 2, `zoom ${await zoomOf(A.page)} % : le clic dans Monaco place le curseur sous le pointeur (caractère ${idx} sur ${line1.length})`);

  // The editor follows the app theme.
  const monacoDark = () => A.page.locator(".monaco-editor").first().evaluate((el) => el.classList.contains("vs-dark"));
  const appDark = () => A.page.evaluate(() => document.documentElement.classList.contains("dark"));
  const wasDark = await appDark();
  await A.page.getByRole("button", { name: /^Thème (sombre|clair)$/ }).click();
  await until("thème de Monaco", async () => (await appDark()) !== wasDark && (await monacoDark()) === (await appDark()));
  ok((await monacoDark()) === (await appDark()), "Monaco suit le thème de l'application (clair / sombre)");
  await noConsoleErrors("fenêtre de code : aucune erreur console (Alice et Bob)");

  // ---- 6. Notebook ----
  block("6. Notebook partagé sur un noyau Jupyter");
  await A.page.getByTitle(/^Masquer \(le document reste partagé, l'icône aussi\)/).click();
  await A.page.locator(".reset-zoom-button").click();
  await dockA.getByTitle("Nouveau notebook").click();
  const nbA = A.page.locator(".nb-cells");
  await nbA.waitFor({ timeout: 30000 });
  await A.page.getByRole("button", { name: /Démarrer le noyau/ }).click();
  await A.page.getByRole("dialog").getByRole("button", { name: "Démarrer", exact: true }).click();
  await until("noyau prêt", async () => /prêt|inactif|idle/i.test(await A.page.locator(".nb-kernel").innerText()), 60000);
  ok(true, `le noyau Jupyter démarre sur la machine (${(await A.page.locator(".nb-kernel").innerText()).trim()})`);
  const cellEditor = (p: Page, n: number) => p.locator(".nb-cell").nth(n).locator(".monaco-editor");
  const typeInCell = async (p: Page, n: number, text: string) => {
    const ed = cellEditor(p, n);
    await until(`cellule ${n}`, () => ed.count(), 15000);
    await until(`cellule ${n} focalisée`, async () => {
      await ed.locator(".view-lines").click({ position: { x: 20, y: 8 }, force: true });
      return p.evaluate((i) => !!document.querySelectorAll(".nb-cell")[i]?.contains(document.activeElement), n);
    });
    await p.keyboard.type(text);
    await p.keyboard.press("Escape");
  };
  await typeInCell(A.page, 0, "x = 41");
  await A.page.keyboard.press("Shift+Enter");
  await until("cellule 2", () => A.page.locator(".nb-cell").count().then((n) => n >= 2));
  await typeInCell(A.page, 1, "print(x + 1)");
  await A.page.keyboard.press("Shift+Enter");
  await until("sortie 42 (Alice)", async () => /\b42\b/.test(await A.page.locator(".nb-outputs .nb-text").allInnerTexts().then((t) => t.join("\n"))), 30000);
  ok(true, "Maj+Entrée exécute les cellules sur le noyau et la sortie « 42 » s'affiche chez Alice");
  ok((await activeTool(A.page)) === "toolbar-selection", "taper dans les cellules ne change pas l'outil Excalidraw");

  // Bob sees the same notebook, with the same output.
  await B.page.goto(boardUrl);
  await dockB.waitFor({ timeout: 30000 });
  await until("notebook de Bob", () => B.page.locator(".nb-cells").count(), 8000).catch(() => dockB.getByText("Notebook 1").click());
  await until("sortie 42 (Bob)", async () => /\b42\b/.test(await B.page.locator(".nb-outputs .nb-text").allInnerTexts().then((t) => t.join("\n"))), 30000);
  ok(true, "Bob voit la même sortie « 42 » dans le notebook partagé");

  // HTML output: sandboxed iframe, no script runs.
  await B.page.evaluate(() => {
    (window as any).__msgs = [];
    window.addEventListener("message", (e) => (window as any).__msgs.push(String(e.data)));
  });
  await A.page.evaluate(() => {
    (window as any).__msgs = [];
    window.addEventListener("message", (e) => (window as any).__msgs.push(String(e.data)));
  });
  await until("cellule vide ajoutée par Maj+Entrée", () => A.page.locator(".nb-cell").count().then((n) => n >= 3));
  await typeInCell(A.page, 2, `from IPython.display import HTML; HTML("<b>gras</b><script>parent.postMessage('pwned','*')</script>")`);
  await A.page.keyboard.press("Shift+Enter");
  const frameA = A.page.locator(".nb-cell").nth(2).locator("iframe.nb-frame");
  await frameA.waitFor({ timeout: 30000 });
  ok((await frameA.getAttribute("sandbox")) === "", "la sortie HTML s'affiche dans une iframe avec sandbox=\"\" (aucun droit)");
  const frameB = B.page.locator(".nb-cell").nth(2).locator("iframe.nb-frame");
  await frameB.waitFor({ timeout: 30000 });
  ok((await frameB.getAttribute("sandbox")) === "", "même chose chez Bob");
  const gras = await frameA.contentFrame().locator("b").innerText().catch(() => "");
  ok(gras === "gras" || gras === "", "le contenu HTML est rendu dans l'iframe isolée");
  await sleep(800);
  const leaked = [...(await A.page.evaluate(() => (window as any).__msgs)), ...(await B.page.evaluate(() => (window as any).__msgs))];
  ok(!leaked.includes("pwned"), "le script de la sortie HTML ne s'exécute pas");
  ok(blocked.scripts >= 1, "Chrome confirme avoir bloqué le script de la sortie HTML (sandbox sans allow-scripts)");

  // Ctrl+Entrée runs a cell without moving on.
  await until("cellule vide ajoutée", () => A.page.locator(".nb-cell").count().then((n) => n >= 4));
  await typeInCell(A.page, 3, "print(6 * 7 + 1)");
  await A.page.keyboard.press("Control+Enter");
  await until("sortie 43", async () => /\b43\b/.test(await A.page.locator(".nb-cell").nth(3).innerText()), 20000);
  ok(true, "Ctrl+Entrée exécute la cellule courante");
  await noConsoleErrors("notebook : aucune erreur console (Alice et Bob)");

  // ---- 7. Broadcast, history, public link ----
  block("7. Diffusion de saisie, historique, lien public");
  await A.page.getByTitle(/^Masquer \(le notebook reste partagé/).click();
  await dockA.getByTitle("Nouveau shell sur cette machine").click();
  await until("deux terminaux", () => A.page.locator(".term:not(.code) .xterm").count().then((n) => n === 2), 30000);
  const termText = (n: number) => A.page.locator(".term:not(.code) .xterm").nth(n).locator(".xterm-rows").innerText();
  await until("second shell prêt", async () => /[#$] ?$/m.test((await termText(1)).trim()) || (await termText(1)).includes("@"), 20000);
  const focusTerm = (n: number) => A.page.locator(".term:not(.code) .xterm").nth(n).locator(".xterm-helper-textarea").focus();
  await focusTerm(0);
  await A.page.keyboard.press("Alt+b");
  await focusTerm(1);
  await A.page.keyboard.press("Alt+b");
  const bcast = A.page.locator(".term:not(.code) button[aria-pressed=true][title*='Alt+B']");
  await until("deux terminaux en diffusion", () => bcast.count().then((n) => n === 2));
  ok(true, "Alt+B met deux terminaux dans la diffusion de saisie");
  ok((await activeTool(A.page)) === "toolbar-selection", "Alt+B ne change pas l'outil Excalidraw");
  await A.page.keyboard.type("echo diffusion-$((20+22))");
  await A.page.keyboard.press("Enter");
  await until("sortie dans les deux terminaux", async () => (await termText(0)).includes("diffusion-42") && (await termText(1)).includes("diffusion-42"), 20000);
  ok(true, "ce qui est tapé dans un terminal de la diffusion s'exécute dans les deux shells");
  await A.page.keyboard.press("Alt+b");
  await focusTerm(0);
  await A.page.keyboard.press("Alt+b");
  await until("diffusion arrêtée", () => bcast.count().then((n) => n === 0));
  ok(true, "Alt+B retire les terminaux de la diffusion");

  // Draw something on the empty canvas (windows hidden) so the board has content for the history and the public view.
  await dockA.getByTitle("Tout masquer").click();
  await A.page.locator(".excalidraw canvas.interactive").click({ position: { x: 900, y: 700 }, force: true });
  await A.page.keyboard.press("r");
  await until("outil rectangle", async () => (await activeTool(A.page)) === "toolbar-rectangle");
  await A.page.mouse.move(850, 650);
  await A.page.mouse.down();
  await A.page.mouse.move(1000, 760, { steps: 6 });
  await A.page.mouse.up();
  ok(true, "un rectangle est dessiné sur le canvas");

  await A.page.getByTitle("Historique des versions").click();
  const history = A.page.getByRole("complementary", { name: "Historique du tableau" });
  await history.locator(".history-item").first().waitFor({ timeout: 30000 });
  ok((await history.locator(".history-item").count()) >= 1, "le panneau d'historique s'ouvre et liste des versions");
  await history.locator(".history-item").first().click();
  await history.getByAltText("Aperçu de la version").or(history.getByText("Rien à afficher")).waitFor({ timeout: 15000 });
  ok(true, "une version s'affiche en aperçu");
  await A.page.getByTitle("Historique des versions").click();
  ok((await A.page.getByTitle(/^Vérifier le schéma/).count()) === 0, "le bouton « Vérifier le schéma » n'apparaît pas tant qu'aucun câble ne relie une machine");

  // Public link: created from the share dialog, opened logged out.
  await A.page.getByRole("button", { name: "Partager", exact: true }).click();
  const shareDlg = A.page.getByRole("dialog");
  await shareDlg.getByLabel("Libellé du lien").fill("Pour le jury");
  await shareDlg.getByRole("button", { name: /Créer/ }).click();
  const link = await until("lien public", () => shareDlg.getByLabel("Lien public").inputValue(), 15000);
  ok(/\/p\/|public|#/.test(link), "un lien public est créé (la clé reste dans le fragment de l'URL)");
  await shareDlg.getByRole("button", { name: "Fermer" }).click();
  const P = await newUser("public");
  await P.page.goto(link);
  await P.page.locator(".public-view .excalidraw").waitFor({ timeout: 30000 });
  ok(await P.page.getByText(/Vue en lecture seule/).isVisible(), "le lien public ouvre le tableau en lecture seule, sans compte");
  await until("dessin affiché", async () => (await P.page.locator(".excalidraw canvas").count()) > 0);
  ok((await P.page.locator(".xterm, .monaco-editor, .nb-cells, .term").count()) === 0, "la vue publique ne contient aucun terminal, éditeur ni notebook");
  ok((await P.page.locator(".App-toolbar").count()) === 0, "la vue publique n'a pas la barre d'outils de dessin (lecture seule)");
  await noConsoleErrors("diffusion, historique et vue publique : aucune erreur console");
  await shot("fin");
} catch (e) {
  console.log(`✘ ${(e as Error).message}`);
  failures++;
  await shot("echec");
} finally {
  const p = takeProblems();
  if (p.length) console.log(p.join("\n"));
  for (const c of children) c.kill();
  await browser.close();
}
console.log(failures ? `\n${failures} échec(s)` : "\nTout est OK");
process.exit(failures ? 1 : 0);
