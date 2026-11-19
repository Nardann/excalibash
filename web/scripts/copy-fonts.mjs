// Self-hosts Excalidraw's fonts so the editor never reaches out to a CDN.
import { cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const dest = resolve(root, "public/fonts");
if (!existsSync(src)) throw new Error(`fonts introuvables: ${src}`);
cpSync(src, dest, { recursive: true });
console.log("fonts Excalidraw copiées dans public/fonts");
