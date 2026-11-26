// Restoring a history version: computed locally, then committed like any local edit, so it syncs to
// everyone through the normal encrypted path and can be undone with Ctrl+Z.
import { CaptureUpdateAction, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { cd } from "./nodeData.ts";
import { isWindow } from "./nodes.ts";

type Api = ExcalidrawImperativeAPI;

/** Fields of a machine tile that tie it to live shells, sites and machines: never taken from the past. */
const LIVE_KEYS = ["shells", "webs", "machineId", "machineName", "remote"] as const;

const nonce = () => crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;

/** A copy of `el` that collaboration will send (higher version, new nonce). */
const bumped = (el: any, over: any, floor: number) => ({ ...el, ...over, version: Math.max(el.version ?? 0, floor) + 1, versionNonce: nonce(), updated: Date.now() });

/**
 * Replaces the drawing by `snapshot`. Windows (shells, sites) are left exactly as they are and
 * ignored in the snapshot; machine tiles keep their current shells / sites / machine links.
 * Returns the number of elements changed.
 */
export function restoreVersion(api: Api, snapshot: readonly any[], files: Record<string, any>): number {
  const current = api.getSceneElementsIncludingDeleted() as readonly any[];
  const byId = new Map(current.map((e) => [e.id, e]));
  const past = restoreElements(snapshot.filter((e) => !isWindow(e)) as any, null) as any[];
  const pastIds = new Set(past.map((e) => e.id));
  const replaced = new Map<string, any>();
  const added: any[] = [];

  for (const s of past) {
    const c = byId.get(s.id);
    if (c && isWindow(c)) continue;
    let data = s.customData;
    if (cd(s).node) {
      // A live tile keeps its connections; a deleted or missing one comes back as a plain icon.
      const live = c && !c.isDeleted && cd(c).node ? cd(c) : {};
      const kept = Object.fromEntries(LIVE_KEYS.filter((k) => live[k] !== undefined).map((k) => [k, live[k]]));
      data = { ...cd(s) };
      for (const k of LIVE_KEYS) delete data[k];
      data.shells = [];
      data.webs = [];
      Object.assign(data, kept);
    }
    const next = bumped(s, data === s.customData ? {} : { customData: data }, c?.version ?? 0);
    if (c) replaced.set(s.id, next);
    else added.push(next);
  }
  // Elements that did not exist then disappear, except tiles that still own live shells or sites.
  for (const c of current) {
    if (pastIds.has(c.id) || c.isDeleted || isWindow(c)) continue;
    if (cd(c).node && (cd(c).shells?.length || cd(c).webs?.length)) continue;
    replaced.set(c.id, bumped(c, { isDeleted: true }, c.version));
  }
  const changed = replaced.size + added.length;
  if (!changed) return 0;
  if (Object.keys(files).length) api.addFiles(Object.values(files));
  api.updateScene({ elements: [...current.map((e) => replaced.get(e.id) ?? e), ...added], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return changed;
}
