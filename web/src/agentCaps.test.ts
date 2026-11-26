// Unit tests of the agent capability gating (pure, no framework):
//   node --experimental-strip-types web/src/agentCaps.test.ts
import { FEATURES, KNOWN_CAPS, OutdatedError, missingCaps, needsUpdate, outdatedMessage, supports, updateCommand } from "./agentCaps.ts";
import { readFileSync } from "node:fs";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

const full = [...KNOWN_CAPS];
ok(Object.keys(FEATURES).every((f) => supports(full, f as keyof typeof FEATURES)), "a current agent supports every feature");
ok(!needsUpdate(full) && missingCaps(full).length === 0, "a current agent needs no update");

// An agent that announced nothing (before the list existed) is old for everything.
for (const none of [undefined, null, []] as const) {
  ok(Object.keys(FEATURES).every((f) => !supports(none, f as keyof typeof FEATURES)), `no capability list (${JSON.stringify(none)}): every feature refused`);
  ok(needsUpdate(none), `no capability list (${JSON.stringify(none)}): update offered`);
}

// A partial agent: files but no capture.
const partial = ["files", "ifaces"];
ok(supports(partial, "files") && supports(partial, "code") && !supports(partial, "capture") && !supports(partial, "kernel"), "partial agent: only what it announced");
ok(missingCaps(partial).join() === "capture,jupyter,probe,schema", "missing caps listed in a stable order");

ok(outdatedMessage("srv-1", "capture") === "L'agent de srv-1 est trop ancien pour la capture réseau : mets-le à jour.", "message names the machine and the feature");
ok(outdatedMessage("  \n ", "files").includes("cette machine"), "blank machine name: generic");
const e = new OutdatedError("pc", "schema");
ok(e.code === "outdated" && e.machine === "pc" && e.feature === "schema" && e.message.includes("la vérification du schéma"), "OutdatedError carries machine and feature");

ok(updateCommand("https://eb.example/", null) === "curl -fsSL https://eb.example/update.sh | sh", "update command");
ok(updateCommand("https://eb.example", "sha256//abc=") === "curl -k --pinnedpubkey 'sha256//abc=' -fsSL https://eb.example/update.sh | sh", "update command, pinned certificate");

// The web list must match what the Go agent announces (otherwise a current agent would look old).
const go = readFileSync(new URL("../../agent/conn.go", import.meta.url), "utf8");
const goCaps = /var agentCaps = \[\]string\{([^}]*)\}/.exec(go)?.[1].match(/"([a-z0-9._-]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
ok(goCaps.join() === [...KNOWN_CAPS].join(), `agentCaps (Go) = KNOWN_CAPS (web): ${goCaps.join()}`);

if (failures) {
  console.error(`${failures} échec(s)`);
  process.exit(1);
}
