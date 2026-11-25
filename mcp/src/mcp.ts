// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0. stdout carries only protocol.
import { createInterface } from "node:readline";

export const VERSION = "1.0.0";
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: "string" | "integer" | "boolean"; description: string; minimum?: number; maximum?: number; maxLength?: number; default?: unknown }>;
  required?: string[];
  additionalProperties: false;
};
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type Tool = { name: string; description: string; inputSchema: JsonSchema; run: (args: Record<string, any>) => Promise<string> };

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** Validates arguments against the tool's own schema (the subset used here); returns a French message or null. */
export function validate(schema: JsonSchema, args: unknown): { args: Record<string, any> } | { error: string } {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return { error: "Les arguments doivent être un objet." };
  const a = args as Record<string, unknown>;
  const unknown = Object.keys(a).filter((k) => !(k in schema.properties));
  if (unknown.length) return { error: `Arguments inconnus : ${unknown.join(", ")}. Arguments possibles : ${Object.keys(schema.properties).join(", ") || "aucun"}.` };
  for (const k of schema.required ?? []) if (a[k] === undefined) return { error: `Argument obligatoire manquant : « ${k} ».` };
  const out: Record<string, any> = {};
  for (const [k, spec] of Object.entries(schema.properties)) {
    let v = a[k];
    if (v === undefined || v === null) {
      if (spec.default !== undefined) out[k] = spec.default;
      continue;
    }
    if (spec.type === "string" && typeof v !== "string") return { error: `« ${k} » doit être une chaîne de caractères.` };
    if (spec.type === "boolean" && typeof v !== "boolean") return { error: `« ${k} » doit être un booléen (true ou false).` };
    if (spec.type === "integer") {
      if (typeof v !== "number" || !Number.isFinite(v)) return { error: `« ${k} » doit être un nombre entier.` };
      v = Math.round(v as number);
      if (spec.minimum !== undefined && (v as number) < spec.minimum) return { error: `« ${k} » doit être au moins ${spec.minimum}.` };
      if (spec.maximum !== undefined && (v as number) > spec.maximum) return { error: `« ${k} » doit être au plus ${spec.maximum}.` };
    }
    if (spec.type === "string" && spec.maxLength !== undefined && (v as string).length > spec.maxLength) return { error: `« ${k} » est limité à ${spec.maxLength} caractères.` };
    out[k] = v;
  }
  return { args: out };
}

export function serveStdio(tools: Tool[], info: { name: string; version: string }, onExit: () => void) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

  async function handle(msg: any): Promise<unknown | undefined> {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Requête JSON-RPC invalide" } };
    }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await dispatch(msg.method, msg.params);
      return isNotification ? undefined : { jsonrpc: "2.0", id: msg.id, result };
    } catch (e) {
      if (isNotification) return undefined;
      if (e instanceof RpcError) return { jsonrpc: "2.0", id: msg.id, error: { code: e.code, message: e.message } };
      process.stderr.write(`[mcp] ${(e as Error)?.stack ?? e}\n`);
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Erreur interne" } };
    }
  }

  async function dispatch(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: {} },
          serverInfo: { name: info.name, version: info.version },
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      case "ping":
        return {};
      case "tools/list":
        return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
      case "tools/call": {
        const tool = typeof params?.name === "string" ? byName.get(params.name) : undefined;
        if (!tool) throw new RpcError(-32602, `Outil inconnu : ${params?.name}`);
        const v = validate(tool.inputSchema, params.arguments);
        if ("error" in v) return textResult(`${v.error}\nSchéma attendu : ${JSON.stringify(tool.inputSchema.properties)}`, true);
        try {
          return textResult(await tool.run(v.args));
        } catch (e) {
          return textResult((e as Error)?.message || "Erreur inconnue", true);
        }
      }
      default:
        throw new RpcError(-32601, `Méthode inconnue : ${method}`);
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let ended = false;
  const maybeExit = () => {
    if (ended && pending === 0) onExit();
  };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } });
      return;
    }
    pending++;
    const done = (async () => {
      if (Array.isArray(msg)) {
        const rs = (await Promise.all(msg.map(handle))).filter((r) => r !== undefined);
        if (rs.length) write(rs);
      } else {
        const r = await handle(msg);
        if (r !== undefined) write(r);
      }
    })();
    done.finally(() => {
      pending--;
      maybeExit();
    });
  });
  rl.on("close", () => {
    ended = true;
    maybeExit();
  });
}
