// Hand-drawn SVG shapes with rough.js (the sketch engine Excalidraw itself uses), rendered as
// plain React <path>s so they inherit currentColor and need no canvas.
import rough from "roughjs";
import type { Options } from "roughjs/bin/core";

const gen = rough.generator();

const BASE: Options = { roughness: 1.1, bowing: 1, strokeWidth: 1.6, stroke: "currentColor", preserveVertices: false };

type Props = { opts?: Options; seed: number; className?: string; scaleStroke?: boolean };

function Paths({ drawable, className, scaleStroke }: { drawable: ReturnType<typeof gen.rectangle>; className?: string; scaleStroke?: boolean }) {
  return (
    <g className={className}>
      {gen.toPaths(drawable).map((p, i) => (
        <path
          key={i}
          d={p.d}
          stroke={p.stroke === "none" ? "none" : p.stroke}
          strokeWidth={p.strokeWidth}
          fill={p.fill ?? "none"}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect={scaleStroke ? undefined : "non-scaling-stroke"}
        />
      ))}
    </g>
  );
}

export function RRect({ x, y, w, h, seed, opts, className, scaleStroke }: Props & { x: number; y: number; w: number; h: number }) {
  return <Paths className={className} scaleStroke={scaleStroke} drawable={gen.rectangle(x, y, w, h, { ...BASE, seed, ...opts })} />;
}

export function REllipse({ cx, cy, w, h, seed, opts, className }: Props & { cx: number; cy: number; w: number; h: number }) {
  return <Paths className={className} drawable={gen.ellipse(cx, cy, w, h, { ...BASE, seed, ...opts })} />;
}

export function RLine({ x1, y1, x2, y2, seed, opts, className }: Props & { x1: number; y1: number; x2: number; y2: number }) {
  return <Paths className={className} drawable={gen.line(x1, y1, x2, y2, { ...BASE, seed, ...opts })} />;
}

/** A sketched curve ending in an arrowhead, like Excalidraw's arrow tool. */
export function RArrow({ points, seed, opts, className }: Props & { points: [number, number][] }) {
  const [px, py] = points[points.length - 2];
  const [x, y] = points[points.length - 1];
  const a = Math.atan2(y - py, x - px);
  const head = 12;
  const wing = (d: number): [number, number] => [x - head * Math.cos(a + d), y - head * Math.sin(a + d)];
  const [lx, ly] = wing(0.45);
  const [rx, ry] = wing(-0.45);
  const o = { ...BASE, seed, ...opts };
  return (
    <g className={className}>
      <Paths drawable={points.length > 2 ? gen.curve(points, o) : gen.line(points[0][0], points[0][1], x, y, o)} />
      <Paths drawable={gen.line(lx, ly, x, y, { ...o, seed: seed + 1 })} />
      <Paths drawable={gen.line(rx, ry, x, y, { ...o, seed: seed + 2 })} />
    </g>
  );
}

/** A box drawn behind HTML content, stretched to its size without distorting the stroke. */
export function SketchBox({ seed, opts, className }: { seed: number; opts?: Options; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 300 200" preserveAspectRatio="none" aria-hidden>
      <RRect x={3} y={3} w={294} h={194} seed={seed} opts={{ roughness: 1.3, ...opts }} />
    </svg>
  );
}
