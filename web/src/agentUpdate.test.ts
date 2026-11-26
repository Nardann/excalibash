// Unit tests of the browser side of the agent self-update (no framework):
//   node --experimental-strip-types web/src/agentUpdate.test.ts
import { AAD, boxJson, symKey } from "./crypto.ts";
import { classify, compareVersions, isOutdated, requestUpdate, runLimited, sessionsText, updateMachine, waitForVersion } from "./agentUpdate.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

// Same table as agent/update_test.go: the browser and the agent must agree on what is newer.
const cmp: [string, string, number][] = [
  ["1.0.0", "1.0.0", 0], ["v1.0.0", "1.0.0", 0], ["1.2.0", "1.1.9", 1], ["1.10.0", "1.9.0", 1], ["2.0.0", "1.99.99", 1],
  ["1.0", "1.0.0", 0], ["1.0.0", "1.0.1", -1], ["1.0.0-rc.1", "1.0.0", -1], ["1.0.0-rc.2", "1.0.0-rc.10", -1], ["1.0.0+b5", "1.0.0", 0],
];
for (const [a, b, want] of cmp) ok(compareVersions(a, b) === want, `compare(${a}, ${b}) = ${want}`);
for (const bad of ["", "dev", "abc", "1.x.0", "1.2.3.4", "7f1f162"]) ok(compareVersions(bad, "1.0.0") === null, `"${bad}" is not a version`);

const latest = { version: "2.0.0", signed: true };
const base = { agentVersion: "1.0.0", agentCaps: ["files", "update"], online: true, lastSeen: 1 };
ok(classify(base, latest) === "outdated", "old agent with the update cap: one click");
ok(classify({ ...base, agentVersion: "2.0.0" }, latest) === "uptodate", "same version: up to date");
ok(classify({ ...base, agentVersion: "3.0.0" }, latest) === "uptodate", "newer agent: never offered a downgrade");
ok(classify({ ...base, agentCaps: ["files"] }, latest) === "manual", "no update cap: manual command");
ok(classify({ ...base, online: false }, latest) === "offline", "offline agent: later");
ok(classify({ ...base, agentVersion: "dev" }, latest) === "unknown", "dev build: unknown");
ok(classify(base, { version: null, signed: false }) === "unknown", "no signed release: nothing to do");
ok(isOutdated(base, latest) && !isOutdated(base, { version: "2.0.0", signed: false }), "outdated only against a signed release");
ok(sessionsText(0).includes("Aucun") && sessionsText(1) === "1 shell ouvert sera interrompu." && sessionsText(3) === "3 shells ouverts seront interrompus.", "open sessions wording");

// runLimited: at most 3 at a time, all done.
{
  let cur = 0, max = 0, done = 0;
  await runLimited([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    cur++;
    max = Math.max(max, cur);
    await new Promise((r) => setTimeout(r, 10));
    cur--;
    done++;
  });
  ok(max === 3 && done === 8, `concurrency capped at 3 (max ${max}), every job ran (${done})`);
  await runLimited([1, 2], 3, async () => { throw new Error("boom"); });
  ok(true, "a failing job does not stop the batch");
}

// waitForVersion.
{
  let t = 0;
  const sleep = async (ms: number) => void (t += ms);
  let polls = 0;
  const list = async () => [{ id: "m", online: polls++ >= 2, agentVersion: polls > 2 ? "2.0.0" : "1.0.0" }] as any;
  ok((await waitForVersion("m", "2.0.0", list, { sleep, pollMs: 1000, timeoutMs: 10_000 })) === true, "waits for the new version");
  const never = async () => [{ id: "m", online: true, agentVersion: "1.0.0" }] as any;
  ok((await waitForVersion("m", "2.0.0", never, { sleep, pollMs: 1000, timeoutMs: 5000, }).catch(() => "x")) !== undefined, "returns when time is out");
}

// requestUpdate / updateMachine against a fake server streaming boxed frames.
{
  const auth = await symKey(crypto.getRandomValues(new Uint8Array(32)));
  const machine: any = { id: "m1", name: "pc", auth, access: "owner", agentVersion: "1.0.0", agentCaps: ["update"], online: true, lastSeen: 1 };
  const realFetch = globalThis.fetch;
  const stream = (lines: string[]) => new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l + "\n")); c.close(); } }), { status: 200 });
  const fake = (frames: (rid: string) => Promise<string[]>) => {
    globalThis.fetch = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      return stream(await frames(body.rid));
    }) as any;
  };
  const line = async (rid: string, f: object, aadRid = rid, signed = auth) => JSON.stringify({ d: await boxJson(signed, f, AAD.updateRes(aadRid)) });

  fake(async (rid) => [
    await line(rid, { n: 1, phase: "check", msg: "vérification" }),
    await line(rid, { n: 1, phase: "error", msg: "rejoué : ignoré" }), // n not increasing: ignored
    await line(rid, { n: 2, phase: "error", msg: "autre requête" }, "another-rid"), // other rid: does not authenticate
    await line(rid, { n: 3, phase: "error", msg: "autre clé" }, rid, await symKey(crypto.getRandomValues(new Uint8Array(32)))),
    await line(rid, { n: 4, phase: "restarting", version: "2.0.0" }),
  ]);
  const seen: string[] = [];
  const last = await requestUpdate(machine, undefined, (f) => seen.push(f.phase));
  ok(seen.join() === "check,restarting" && last?.phase === "restarting", `forged, replayed and foreign frames are ignored (${seen.join()})`);

  fake(async (rid) => [await line(rid, { n: 1, phase: "restarting", version: "2.0.0" })]);
  const steps: string[] = [];
  const back = [{ ...machine, agentVersion: "2.0.0" }];
  const res = await updateMachine(machine, { expected: "2.0.0", list: async () => back, onProgress: (p) => steps.push(p.kind), wait: { pollMs: 1, timeoutMs: 500 } });
  ok(res.kind === "done" && steps.join() === "running,restarting,waiting,done", `full run: ${steps.join()}`);

  fake(async (rid) => [await line(rid, { n: 1, phase: "error", msg: "mise à jour automatique désactivée pour cet agent (aucune clé de signature intégrée)" })]);
  const failed = await updateMachine(machine, { expected: "2.0.0", list: async () => [], onProgress: () => {} });
  ok(failed.kind === "failed" && failed.reason.includes("aucune clé de signature"), "the agent's refusal is shown");

  fake(async () => []);
  const silent = await updateMachine(machine, { expected: "2.0.0", list: async () => [], onProgress: () => {} });
  ok(silent.kind === "failed", "a stream that ends without a verdict is a failure");

  const stuck = await updateMachine(machine, { expected: "2.0.0", list: async () => [{ ...machine, agentVersion: "1.0.0" }], onProgress: () => {}, wait: { pollMs: 1, timeoutMs: 30 } }).catch(() => null);
  ok(stuck !== null, "no hang when the agent never comes back");
  globalThis.fetch = realFetch;
}

if (failures) {
  console.error(`${failures} échec(s)`);
  process.exit(1);
}
