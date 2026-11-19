import { api } from "../api.ts";
import type { SymKey } from "../crypto.ts";
import { createItem, fetchBoardContent } from "../library.tsx";
import { encryptPreview } from "./boardCrypto.ts";

/** Renders a scene to an SVG string for dashboard thumbnails (Excalidraw is loaded on demand). */
export async function renderPreview(elements: readonly any[], files: Record<string, any>, background = "#ffffff"): Promise<string | null> {
  // Terminal windows would export as a bare URL placeholder; draw them as dark panes instead.
  const visible = elements
    .filter((e) => !e.isDeleted)
    .map((e) =>
      e.customData?.terminalId
        ? { ...e, type: "rectangle", link: null, backgroundColor: "#0b1020", fillStyle: "solid", strokeColor: "#1e293b", strokeWidth: 2, roughness: 0, roundness: { type: 3 } }
        : e,
    );
  if (!visible.length) return null;
  const { exportToSvg } = await import("@excalidraw/excalidraw");
  const svg = await exportToSvg({
    elements: visible,
    appState: { exportBackground: false, viewBackgroundColor: background, exportWithDarkMode: false },
    files,
    exportPadding: 16,
  });
  return svg.outerHTML;
}

export async function savePreview(boardId: string, key: SymKey, epoch: number, elements: readonly any[], files: Record<string, any>) {
  const svg = await renderPreview(elements, files);
  if (svg) await api.put(`/items/${boardId}/preview`, { epoch, preview: await encryptPreview(key, boardId, svg) });
}

export async function exportBoard(name: string, key: SymKey, id: string) {
  const content = await fetchBoardContent(key, id);
  const data = {
    type: "excalidraw",
    version: 2,
    source: location.origin,
    elements: content.elements.filter((e) => !e.customData?.terminalId),
    appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
    files: content.files,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, "_") || "tableau"}.excalidraw`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Imports .excalidraw / .json files as new encrypted boards. Returns how many were created. */
export async function importFiles(ctx: Parameters<typeof createItem>[0], files: FileList | File[], parentId: string | null): Promise<number> {
  let created = 0;
  for (const file of Array.from(files)) {
    let data: any;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error(`${file.name} : fichier illisible`);
    }
    if (!Array.isArray(data?.elements)) throw new Error(`${file.name} : ce n'est pas un fichier Excalidraw`);
    const name = file.name.replace(/\.(excalidraw|json)$/i, "") || "Importé";
    const { restoreElements } = await import("@excalidraw/excalidraw");
    const elements = restoreElements(data.elements, null);
    const preview = await renderPreview(elements, data.files ?? {}).catch(() => null);
    await createItem(ctx, "board", parentId, name, { elements: [...elements], files: data.files ?? {}, preview });
    created++;
  }
  return created;
}
