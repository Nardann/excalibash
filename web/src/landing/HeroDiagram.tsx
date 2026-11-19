import { useEffect, useRef, useState } from "react";
import { REllipse, RArrow, RLine, RRect } from "./rough.tsx";

type Server = { id: string; ip: string; cx: number; script: { cmd: string; out: string[] } };

const SERVERS: Server[] = [
  { id: "srv-web", ip: "192.168.10.11", cx: 130, script: { cmd: "curl -sI localhost | head -2", out: ["HTTP/1.1 200 OK", "Server: nginx/1.26.2"] } },
  { id: "srv-dns", ip: "192.168.10.12", cx: 300, script: { cmd: "dig +short srv-web.tp.lan", out: ["192.168.10.11"] } },
  { id: "srv-db", ip: "192.168.10.13", cx: 470, script: { cmd: "systemctl is-active mariadb", out: ["active"] } },
];

const SERVER_Y = 300;
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Three stacked units, like the server icons of a network library. */
function ServerIcon({ cx, seed }: { cx: number; seed: number }) {
  return (
    <g>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <RRect x={cx - 34} y={SERVER_Y + i * 22} w={68} h={20} seed={seed + i * 7} opts={{ fill: "var(--lp-paper)", fillStyle: "solid", roughness: 0.9 }} />
          <circle cx={cx + 22} cy={SERVER_Y + 10 + i * 22} r={2.6} className="lp-led" />
        </g>
      ))}
    </g>
  );
}

/**
 * The hero: a hand-drawn TP topology. Each server opens its own terminal, which types a real
 * command — the product, shown rather than described.
 */
export function HeroDiagram() {
  const [open, setOpen] = useState<string | null>(null);
  const [typed, setTyped] = useState(0);
  const touched = useRef(false);
  const server = SERVERS.find((s) => s.id === open);

  // One orchestrated moment: the first terminal opens by itself, once.
  useEffect(() => {
    const t = setTimeout(() => !touched.current && setOpen("srv-web"), reduced() ? 0 : 900);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!server) return;
    if (reduced()) return setTyped(server.script.cmd.length);
    setTyped(0);
    const t = setInterval(() => setTyped((n) => (n >= server.script.cmd.length ? n : n + 1)), 38);
    return () => clearInterval(t);
  }, [server]);

  const pick = (id: string) => {
    touched.current = true;
    setOpen(id);
  };

  const done = server && typed >= server.script.cmd.length;

  return (
    <div className="lp-diagram">
      <svg viewBox="0 0 600 480" role="img" aria-label="Schéma d'un TP : un routeur, un switch et trois serveurs dans un LAN">
        <REllipse className="lp-zone" cx={300} cy={305} w={590} h={330} seed={4} opts={{ fill: "#ffe58a", fillStyle: "hachure", hachureGap: 7, fillWeight: 1.2, roughness: 1.6 }} />
        <text x={6} y={134} className="lp-hand lp-zone-label">
          LAN 192.168.10.0/24
        </text>

        <RRect x={250} y={18} w={100} h={46} seed={11} opts={{ fill: "var(--lp-paper)", fillStyle: "solid" }} />
        <text x={300} y={47} className="lp-hand lp-center">
          routeur
        </text>
        <RLine x1={300} y1={66} x2={300} y2={176} seed={12} />

        <RRect x={220} y={178} w={160} h={40} seed={13} opts={{ fill: "var(--lp-paper)", fillStyle: "solid" }} />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <rect key={i} x={238 + i * 22} y={194} width={12} height={8} rx={1.5} className="lp-port" />
        ))}
        <text x={392} y={204} className="lp-hand">
          switch
        </text>

        {SERVERS.map((s, i) => (
          <RLine key={s.id} x1={300} y1={220} x2={s.cx} y2={SERVER_Y - 4} seed={20 + i} />
        ))}

        {SERVERS.map((s, i) => (
          <g
            key={s.id}
            className={`lp-server ${open === s.id ? "is-open" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`Ouvrir le terminal de ${s.id}`}
            aria-pressed={open === s.id}
            onClick={() => pick(s.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(s.id))}
          >
            <rect x={s.cx - 60} y={SERVER_Y - 10} width={120} height={130} fill="transparent" />
            <ServerIcon cx={s.cx} seed={40 + i * 30} />
            <text x={s.cx} y={SERVER_Y + 88} className="lp-hand lp-center">
              {s.id}
            </text>
            <text x={s.cx} y={SERVER_Y + 106} className="lp-hand lp-center lp-ip">
              {s.ip}
            </text>
          </g>
        ))}

        {server && <RArrow key={server.id} className="lp-link" points={[[server.cx, SERVER_Y + 116], [server.cx + 14, 438], [server.cx < 300 ? 236 : 300, 466]]} seed={70} opts={{ strokeLineDash: [6, 7], roughness: 0.8 }} />}
      </svg>

      <p className="lp-hint lp-hand" aria-hidden={!!touched.current}>
        clique sur une machine
      </p>

      <div className={`lp-term ${server ? "is-open" : ""}`} aria-live="polite">
        {server && (
          <>
            <div className="lp-term-head">
              <span className="lp-term-dot" />
              {server.id}
              <span className="lp-term-ip">{server.ip}</span>
            </div>
            <pre className="lp-term-body">
              <span className="lp-prompt">etu@{server.id}:~$ </span>
              {server.script.cmd.slice(0, typed)}
              {!done && <span className="lp-caret" />}
              {done && (
                <>
                  {"\n" + server.script.out.join("\n") + "\n"}
                  <span className="lp-prompt">etu@{server.id}:~$ </span>
                  <span className="lp-caret" />
                </>
              )}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
