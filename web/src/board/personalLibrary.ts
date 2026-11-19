// The user's Excalidraw library, stored server-side encrypted under their vault key,
// and the icon rendering used by terminal tiles.
import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";
import type { LibraryItems } from "@excalidraw/excalidraw/types";
import { api, type User } from "../api.ts";
import { boxJson, unboxJson, vaultKey, type KeyPair } from "../crypto.ts";

const aad = (userId: string) => `eb:library:${userId}`;

let cache: { userId: string; items: LibraryItems } | null = null;
const listeners = new Set<() => void>();

export async function loadLibrary(user: User, keys: KeyPair): Promise<LibraryItems> {
  if (cache?.userId === user.id) return cache.items;
  const r = await api.get<{ encLibrary: string | null }>("/library");
  const items = r.encLibrary ? await unboxJson<LibraryItems>(await vaultKey(keys), r.encLibrary, aad(user.id)) : [];
  cache = { userId: user.id, items };
  return items;
}

async function saveLibrary(user: User, keys: KeyPair, items: LibraryItems) {
  await api.put("/library", { encLibrary: await boxJson(await vaultKey(keys), items, aad(user.id)) });
  cache = { userId: user.id, items };
  for (const fn of listeners) fn();
}

export function onLibraryUpdate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function libraryAdapter(user: User, keys: KeyPair): LibraryPersistenceAdapter {
  return {
    load: async () => ({ libraryItems: await loadLibrary(user, keys) }),
    save: ({ libraryItems }) => saveLibrary(user, keys, libraryItems),
  };
}

// ---- Icons ------------------------------------------------------------------------

/** Elements of a library item, as stored on a terminal tile (inside the encrypted element). */
export type TileIcon = { elements: readonly any[] };

const svgCache = new Map<string, Promise<string>>();

/** Renders icon elements to a data URL (used through <img>, so it can never run script). */
export function iconUrl(icon: TileIcon, dark: boolean): Promise<string> {
  const key = `${dark ? "d" : "l"}:${JSON.stringify(icon.elements)}`;
  let p = svgCache.get(key);
  if (!p) {
    p = (async () => {
      const { exportToSvg } = await import("@excalidraw/excalidraw");
      const svg = await exportToSvg({
        elements: icon.elements.filter((e) => !e.isDeleted) as any,
        appState: { exportBackground: false, exportWithDarkMode: dark },
        files: null,
        exportPadding: 2,
        skipInliningFonts: true,
      } as any);
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
    })();
    svgCache.set(key, p);
    if (svgCache.size > 300) svgCache.delete(svgCache.keys().next().value!);
  }
  return p;
}

