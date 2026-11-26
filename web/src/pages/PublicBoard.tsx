// Read-only view of a board through a public link (/v/<token>#<linkKey>). No account, no session, no
// collaboration socket: the board is fetched as ciphertext, decrypted here with the key from the URL
// fragment, and polled every 15 s. The fragment is read from location.hash only; it is never sent anywhere.
import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { Eye, Moon, Sun } from "lucide-react";
import { useTheme } from "../components/ui.tsx";
import { diagramShapes } from "../board/exportDiagram.ts";
import { LINK_BASE, nodeDataOf } from "../board/nodes.ts";
import { decryptPublic, linkKeyFromFragment, newPublicCache, type PublicResponse } from "../publicLinks.ts";

const POLL_MS = 15_000;

type Scene = { elements: any[]; files: Record<string, any> };
type Status = { kind: "loading" } | { kind: "ready" } | { kind: "error"; title: string; text: string };

const MISSING_KEY: Status = {
  kind: "error",
  title: "Clé manquante dans l'URL",
  text: "Le lien est incomplet : il doit se terminer par « # » suivi de la clé. Demande à la personne qui te l'a envoyé de te le renvoyer en entier.",
};
const GONE: Status = {
  kind: "error",
  title: "Lien invalide ou expiré",
  text: "Ce lien n'existe pas, a expiré ou a été supprimé. Demande-en un nouveau à la personne qui te l'a envoyé.",
};

/** The scene as it should appear read-only: windows gone, node tiles drawn as icons, no internal links. */
function toScene(elements: any[], files: Record<string, any>): Scene {
  const names = new Map(elements.map((e) => [e.id, nodeDataOf(e)?.title || nodeDataOf(e)?.machineName || ""]));
  const shapes = diagramShapes(elements, (id) => names.get(id) ?? "").map((e: any) => (e.link?.startsWith(LINK_BASE) ? { ...e, link: null } : e));
  return { elements: shapes, files };
}

export default function PublicBoard({ token }: { token: string }) {
  const { theme, toggle } = useTheme();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [title, setTitle] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const initial = useRef<Scene | null>(null);
  const latest = useRef<Scene | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const cache = useRef(newPublicCache());
  const etag = useRef<string | null>(null);
  const busy = useRef(false);
  const dead = useRef(false);

  const apply = useCallback((scene: Scene) => {
    latest.current = scene;
    const x = apiRef.current;
    if (!x) return;
    const files = Object.values(scene.files);
    if (files.length) x.addFiles(files);
    x.updateScene({ elements: scene.elements, captureUpdate: CaptureUpdateAction.NEVER });
  }, []);

  const load = useCallback(async () => {
    if (busy.current || dead.current) return;
    const key = linkKeyFromFragment(location.hash.slice(1));
    if (!key) {
      dead.current = true;
      setStatus(MISSING_KEY);
      return;
    }
    busy.current = true;
    try {
      const res = await fetch(`/api/public/${encodeURIComponent(token)}`, {
        headers: etag.current ? { "If-None-Match": etag.current } : undefined,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      setOffline(false);
      if (res.status === 304) return;
      if (res.status === 404) {
        dead.current = true;
        setStatus(GONE);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PublicResponse;
      let scene: Scene;
      try {
        const dec = await decryptPublic(data, key, cache.current);
        setTitle(dec.title);
        scene = toScene(dec.elements, dec.files);
      } catch {
        dead.current = true;
        setStatus({
          kind: "error",
          title: "Contenu illisible",
          text: "La clé contenue dans l'URL ne permet pas de déchiffrer ce tableau. Le lien est peut-être incomplet ou a été modifié.",
        });
        return;
      }
      etag.current = res.headers.get("ETag");
      if (!initial.current) initial.current = scene;
      apply(scene);
      setStatus({ kind: "ready" });
    } catch {
      // Network trouble or rate limit: keep what is shown and try again at the next tick.
      setOffline(true);
    } finally {
      busy.current = false;
    }
  }, [token, apply]);

  useEffect(() => {
    void load();
    const tick = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    apiRef.current = api;
    if (api && latest.current) apply(latest.current);
  }, [api, apply]);

  useEffect(() => {
    document.title = title ? `${title} · Excalibash` : "Excalibash";
  }, [title]);

  return (
    <div className="board-page public-view">
      <header className="board-header">
        <span className="badge">
          <Eye size={12} /> Vue en lecture seule · Excalibash
        </span>
        {title && <span className="public-title">{title}</span>}
        {offline && <span className="sub">Connexion perdue, nouvelle tentative…</span>}
        <div className="spacer" />
        <button className="btn btn-icon btn-sm" title={theme === "dark" ? "Thème clair" : "Thème sombre"} onClick={toggle}>
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>
      <div className="board-canvas">
        {status.kind === "ready" && initial.current && (
          <Excalidraw
            excalidrawAPI={setApi}
            theme={theme}
            langCode="fr-FR"
            name={title ?? "tableau"}
            viewModeEnabled
            aiEnabled={false}
            initialData={{ elements: initial.current.elements, files: initial.current.files as any, scrollToContent: true }}
            UIOptions={{ canvasActions: { saveToActiveFile: false, loadScene: false, export: false, toggleTheme: false } }}
          />
        )}
        {status.kind === "loading" && <div className="board-overlay">Chargement et déchiffrement…</div>}
        {status.kind === "error" && (
          <div className="board-overlay">
            <div className="public-state">
              <h2 className="display">{status.title}</h2>
              <p>{status.text}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
