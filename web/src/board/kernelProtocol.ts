// JSON-lines protocol between the browser and the agent's Jupyter bridge (agent/kernel_bridge.py).
// The lines travel through the encrypted terminal stream of a "jupyter" remote session: the browser
// sends one JSON object per line as keystrokes and re-splits the output bytes with a LineSplitter.
// Pure module (no DOM, no React): tested by kernelProtocol.test.ts.

/** Longest request line the agent accepts (2 MiB); code itself is limited to 1 MiB. */
export const MAX_OP_BYTES = 2 << 20;
export const MAX_CODE_BYTES = 1 << 20;
export const MAX_ID_LENGTH = 64;
/** Longest event line the splitter keeps (the agent caps one output at 8 MiB, ASCII-escaped). */
export const MAX_LINE = 64 << 20;

export type KernelOp =
  | { op: "exec"; id: string; code: string }
  | { op: "interrupt" }
  | { op: "restart" }
  | { op: "complete"; id: string; code: string; pos: number }
  | { op: "inspect"; id: string; code: string; pos: number }
  | { op: "ping" };

export type KernelState = "starting" | "idle" | "busy" | "restarting" | "dead";
export type MimeBundle = Record<string, string>;

export type KernelEvent =
  | { ev: "ready"; kernel: string; language: string; version: string }
  | { ev: "status"; state: KernelState }
  | { ev: "stream"; id?: string; name: "stdout" | "stderr"; text: string }
  | { ev: "display"; id: string; data: MimeBundle; metadata: Record<string, unknown>; display_id?: string }
  | { ev: "update"; id: string; display_id: string; data: MimeBundle; metadata: Record<string, unknown> }
  | { ev: "result"; id: string; count: number | null; data: MimeBundle }
  | { ev: "error"; id: string; ename: string; evalue: string; traceback: string[] }
  | { ev: "done"; id: string; count: number | null; status: "ok" | "error" | "aborted" }
  | { ev: "complete"; id: string; matches: string[]; start: number; end: number }
  | { ev: "inspect"; id: string; found: boolean; data: MimeBundle }
  | { ev: "clear"; id: string; wait: boolean }
  | { ev: "log"; text: string }
  | { ev: "fatal"; error: string }
  | { ev: "pong" };

const enc = new TextEncoder();

/** One request as the line to send (JSON + "\n"). Throws if the agent would refuse it. */
export function encodeOp(op: KernelOp): string {
  if ("id" in op && (typeof op.id !== "string" || op.id.length === 0 || op.id.length > MAX_ID_LENGTH)) {
    throw new Error("identifiant de requête incorrect");
  }
  if ("code" in op && enc.encode(op.code).length > MAX_CODE_BYTES) {
    throw new Error("code trop long (1 Mio au maximum)");
  }
  const line = JSON.stringify(op) + "\n";
  if (enc.encode(line).length > MAX_OP_BYTES) throw new Error("requête trop volumineuse (2 Mio au maximum)");
  return line;
}

/** Parses one event line; null when it is not a JSON object with an "ev" field. */
export function parseEvent(line: string): KernelEvent | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && typeof v.ev === "string" ? (v as KernelEvent) : null;
  } catch {
    return null;
  }
}

/**
 * Turns the output stream (bytes or strings, cut anywhere, even inside a UTF-8 character) into complete
 * lines, without their line ending. A line longer than `maxLine` characters is dropped whole (counted in
 * `dropped`) and the following lines are unaffected.
 */
export class LineSplitter {
  dropped = 0;
  private dec = new TextDecoder("utf-8");
  private parts: string[] = [];
  private len = 0;
  private skipping = false;

  private maxLine: number;

  constructor(maxLine = MAX_LINE) {
    this.maxLine = maxLine;
  }

  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.dec.decode(chunk, { stream: true });
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      const end = nl < 0 ? text.length : nl;
      const piece = text.slice(start, end);
      if (!this.skipping) {
        this.parts.push(piece);
        this.len += piece.length;
        if (this.len > this.maxLine) this.overflow();
      }
      if (nl < 0) break;
      if (this.skipping) this.skipping = false;
      else lines.push(this.take());
      start = nl + 1;
    }
    return lines.filter((l) => l.length > 0);
  }

  private overflow() {
    this.dropped++;
    this.parts = [];
    this.len = 0;
    this.skipping = true;
  }

  private take(): string {
    const line = (this.parts.length === 1 ? this.parts[0] : this.parts.join("")).replace(/\r$/, "");
    this.parts = [];
    this.len = 0;
    return line;
  }
}
