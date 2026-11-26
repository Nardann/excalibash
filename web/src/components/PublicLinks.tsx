import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Loader2, Trash2 } from "lucide-react";
import { LINK_LIFETIMES, createPublicLink, deletePublicLink, listPublicLinks, type LinkView } from "../publicLinks.ts";
import type { Node } from "../library.tsx";
import { confirmDialog, copyText, toast } from "./ui.tsx";

const date = (t: number) => new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

/** Public read-only links of a board (owner and editors): create, copy, list, delete. */
export function PublicLinks({ node }: { node: Node }) {
  const [links, setLinks] = useState<LinkView[] | null>(null);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<string>("7");
  const [busy, setBusy] = useState(false);
  /** URL of the link just created: it is only known here, the server keeps neither the token nor the key. */
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (node.key) setLinks(await listPublicLinks(node.id, node.key));
  }, [node.id, node.key]);

  useEffect(() => {
    load().catch(toast.error);
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!node.key) return;
    setBusy(true);
    try {
      const url = await createPublicLink({ id: node.id, key: node.key, epoch: node.epoch, name: node.name }, label, days === "" ? null : Number(days));
      setFresh(url);
      setLabel("");
      await copyText(url).catch(() => {});
      await load();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (l: LinkView) => {
    const ok = await confirmDialog({
      title: "Supprimer ce lien public ?",
      text: "Il cessera immédiatement de fonctionner pour toute personne qui l'a reçu.",
      confirm: "Supprimer le lien",
      danger: true,
    });
    if (!ok) return;
    try {
      await deletePublicLink(node.id, l.publicId);
      await load();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 6 }}>
        <Link2 size={16} /> Lien public
      </h3>
      <p className="field-help" style={{ margin: "0 0 8px" }}>
        Toute personne ayant ce lien peut voir le tableau (sans les terminaux). Lecture seule, sans compte. La clé de déchiffrement reste dans le lien et n'est
        jamais envoyée au serveur. Retirer un membre supprime tous les liens du tableau.
      </p>
      <form onSubmit={create} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input className="input" maxLength={80} placeholder="Libellé (ex. Pour le jury)" aria-label="Libellé du lien" value={label} onChange={(e) => setLabel(e.target.value)} />
        <select className="select" aria-label="Expiration" value={days} onChange={(e) => setDays(e.target.value)}>
          {LINK_LIFETIMES.map((l) => (
            <option key={l.label} value={l.days ?? ""}>
              {l.label}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy || !node.key}>
          {busy ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />} Créer
        </button>
      </form>
      {fresh && (
        <div className="verify" style={{ marginBottom: 8 }}>
          <div className="sub" style={{ marginBottom: 6 }}>
            Lien copié. Il ne sera plus affiché : garde-le maintenant.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input mono" readOnly value={fresh} aria-label="Lien public" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-sm" onClick={() => copyText(fresh)}>
              <Copy size={16} /> Copier
            </button>
          </div>
        </div>
      )}
      {links && links.length > 0 && (
        <div className="panel">
          {links.map((l) => {
            const expired = l.expiresAt !== null && l.expiresAt <= Date.now();
            return (
              <div className="row" key={l.publicId}>
                <div className="grow">
                  <div className="title">{l.label || "Sans libellé"}</div>
                  <div className="sub">
                    Créé le {date(l.createdAt)}
                    {l.createdBy ? ` par ${l.createdBy}` : ""} · {l.expiresAt === null ? "sans expiration" : expired ? "expiré" : `expire le ${date(l.expiresAt)}`}
                  </div>
                </div>
                <button className="btn btn-sm btn-icon" title="Supprimer le lien" style={{ color: "var(--danger)" }} onClick={() => remove(l)}>
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
