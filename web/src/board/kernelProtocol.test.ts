// Unit tests of the kernel protocol helpers (pure, no framework):
//   node --experimental-strip-types web/src/board/kernelProtocol.test.ts     (or: npx tsx web/src/board/kernelProtocol.test.ts)
import { LineSplitter, encodeOp, parseEvent } from "./kernelProtocol.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const bytes = (s: string) => new TextEncoder().encode(s);
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// 1. Lines cut anywhere
{
  const s = new LineSplitter();
  ok(s.push('{"ev":"pong"}\n{"ev":"st').join("|") === '{"ev":"pong"}', "a complete line comes out, the partial one waits");
  ok(s.push('atus"}\n').join("|") === '{"ev":"status"}', "the partial line is completed by the next chunk");
  ok(s.push("a\nb\nc\n").join("|") === "a|b|c", "several lines in one chunk");
  ok(s.push("").length === 0 && s.push("no newline yet").length === 0, "no line without a newline");
  ok(s.push("\r\n").join("|") === "no newline yet", "CR LF is stripped");
  ok(s.push("\n\n\n").length === 0, "empty lines are skipped");
}

// 2. Split UTF-8 (bytes) and strings
{
  const s = new LineSplitter();
  const b = bytes('{"text":"é€😀"}\n');
  let out: string[] = [];
  for (let i = 0; i < b.length; i++) out = out.concat(s.push(b.slice(i, i + 1)));
  ok(out.length === 1 && out[0] === '{"text":"é€😀"}', "multibyte characters split byte by byte are rebuilt");
  const s2 = new LineSplitter();
  const e = bytes("é\n");
  ok(s2.push(e.slice(0, 1)).length === 0 && s2.push(e.slice(1)).join("") === "é", "a character cut between two chunks");
  ok(s2.push("x\n").join("") === "x", "strings are accepted too");
}

// 3. Line cap
{
  const s = new LineSplitter(10);
  ok(s.push("0123456789ab").length === 0 && s.dropped === 1, "an oversized line is dropped (counted)");
  ok(s.push("cdefgh\nok\n").join("|") === "ok", "its end is skipped, the next line survives");
  ok(s.push("short\n").join("|") === "short" && s.dropped === 1, "normal lines keep working");
  ok(s.push("0123456789\n").join("|") === "0123456789", "a line of exactly the cap is kept");
  ok(s.push("01234567890\n").length === 0 && s.dropped === 2, "one more character is not");
  const big = new LineSplitter();
  ok(big.push("x".repeat(1 << 20) + "\n")[0].length === 1 << 20, "1 MiB line goes through with the real cap");
}

// 4. encodeOp
{
  ok(encodeOp({ op: "ping" }) === '{"op":"ping"}\n', "ping is one line");
  const l = encodeOp({ op: "exec", id: "1", code: 'print("a\nb")' });
  ok(l.endsWith("\n") && l.indexOf("\n") === l.length - 1, "newlines in code are escaped: exactly one line");
  ok(JSON.parse(l).code === 'print("a\nb")', "code round-trips");
  ok(throws(() => encodeOp({ op: "exec", id: "", code: "1" })), "empty id refused");
  ok(throws(() => encodeOp({ op: "exec", id: "x".repeat(65), code: "1" })), "id over 64 characters refused");
  ok(throws(() => encodeOp({ op: "exec", id: "a", code: "x".repeat((1 << 20) + 1) })), "code over 1 MiB refused");
  ok(!throws(() => encodeOp({ op: "complete", id: "a", code: "pri", pos: 3 })), "complete accepted");
}

// 5. parseEvent
{
  ok(parseEvent('{"ev":"done","id":"a","count":1,"status":"ok"}')?.ev === "done", "event parsed");
  ok(parseEvent("not json") === null && parseEvent("[]") === null && parseEvent('{"x":1}') === null, "non events give null");
}

console.log(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
