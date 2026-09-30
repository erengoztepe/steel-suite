"use client";

/**
 * Premium isometric schematic of the solved joint, tuned for what a steel
 * connection engineer reads first:
 *  - colour = role (column / beam / brace); bearing member = amber + star + glow
 *  - spoke thickness ∝ √Iy (section stiffness) → hierarchy at a glance
 *  - eccentric members (axis misses the node) get a red dashed marker
 *  - summary strip: member count, role breakdown, bearing section, eccentric count
 * All symbols are SVG-drawn (no unicode glyphs). True lengths/offsets/rotations
 * are in the table; the spider is fixed-length so direction & topology read clean.
 */

import {
  BEARING_HEX,
  memberRole,
  NODE_HEX,
  ROLE_HEX,
  type MemberRole,
} from "./member-roles";
import type { OrientedMemberVectorRow } from "./types";

type Vec3 = [number, number, number];

interface JointDiagramProps {
  rows: OrientedMemberVectorRow[];
  node: Vec3;
  bearingGlobalId: string | null;
}

const W = 600;
const R = 120;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);
const ECC_MM = 25; // true perpendicular eccentricity above this flags a member

// Height is fitted to the drawing (see `half` below), not a fixed canvas.
// Room a spoke needs past its tip: the tag + profile label (13), or the
// arrowhead, whose half-width is 3× the stroke (markers scale with it).
const tipRoom = (width: number) => Math.max(13, 3 * width + 1);
const PAD = 10;
// Below the node the orientation triad needs this much even for a flat joint.
const MIN_HALF = 70;

const AXIS = "#4b5a6a";
const SUB = "#7f93a6";
const TEXT = "#dbe7f3";

function iso(v: Vec3): [number, number] {
  const x = (v[0] - v[1]) * COS30;
  const yUp = v[2] - (v[0] + v[1]) * SIN30;
  return [x * R, -yUp * R];
}

function stiffness(r: OrientedMemberVectorRow): number {
  return r.iStrongCm4 ?? r.sectionAreaMm2 ?? r.crossSectionArea ?? 0;
}

function eccentric(r: OrientedMemberVectorRow): boolean {
  return r.eccentricityMm > ECC_MM;
}

/** small filled star centred at (cx,cy) */
function starPoints(cx: number, cy: number, rOut: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? rOut : rOut * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

const JointDiagram = ({ rows, node, bearingGlobalId }: JointDiagramProps) => {
  if (!node || rows.length === 0) return null;
  const cx = W / 2;
  const cy = 0; // the node; the viewBox is fitted around it

  const stiffs = rows.map(stiffness);
  const minS = Math.min(...stiffs.filter((s) => s > 0), 1);
  const maxS = Math.max(...stiffs, 1);
  const widthOf = (s: number) => {
    if (maxS <= minS || s <= 0) return 2.2;
    const k = (Math.sqrt(s) - Math.sqrt(minS)) / (Math.sqrt(maxS) - Math.sqrt(minS));
    return 1.8 + k * 5.2; // 1.8–7 px
  };

  const spokes = rows.map((r) => {
    const [dx, dy] = iso(r.unit);
    const role = memberRole(r.unit);
    const isB = r.globalId === bearingGlobalId;
    return {
      r,
      role,
      isB,
      ecc: eccentric(r),
      color: isB ? BEARING_HEX : ROLE_HEX[role],
      width: widthOf(stiffness(r)),
      tx: cx + dx,
      ty: cy + dy,
    };
  });

  // Label placement + vertical de-collision per side.
  const labels = spokes
    .map((s) => ({ s, x: s.tx + (s.tx >= cx ? 8 : -8), y: s.ty, anchor: (s.tx >= cx ? "start" : "end") as "start" | "end" }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].anchor === labels[i - 1].anchor && labels[i].y - labels[i - 1].y < 22) {
      labels[i].y = labels[i - 1].y + 22;
    }
  }

  // SYMMETRIC about the node, and blind to which member is the bearing: a flip
  // mirrors a spoke through the node and a bearing change only recolours, so
  // neither changes the height and the table below never jumps under the
  // pointer. Only labels pushed down by the de-collision above extend it.
  const half = Math.max(MIN_HALF, ...spokes.map((s) => Math.abs(s.ty - cy) + tipRoom(s.width))) + PAD;
  const top = cy - half;
  const bottom = Math.max(cy + half, ...labels.map((l) => l.y + 13 + PAD));

  const counts: Record<MemberRole, number> = { column: 0, beam: 0, brace: 0 };
  for (const s of spokes) counts[s.role]++;
  const eccCount = spokes.filter((s) => s.ecc).length;
  const bearing = spokes.find((s) => s.isB);

  const chip = "flex items-center gap-1.5 rounded-lg px-2.5 py-0.5";
  const dot = (c: string) => (
    <span style={{ width: 9, height: 9, borderRadius: "50%", background: c, display: "inline-block" }} />
  );

  const triad: { v: Vec3; name: string }[] = [
    { v: [1, 0, 0], name: "X" },
    { v: [0, 1, 0], name: "Y" },
    { v: [0, 0, 1], name: "Z" },
  ];
  const tx = 52;
  const ty = bottom - 22;
  const TR = 24;

  return (
    <div className="rounded-md border border-border-primary p-2">
      {/* summary strip */}
      <div className="flex flex-wrap gap-1.5 mb-2 text-[11px] text-text-primary">
        <span className={`${chip} bg-bg-secondary`}><b className="font-medium">{rows.length}</b> members</span>
        {counts.column > 0 && <span className={`${chip} bg-bg-secondary`}>{dot(ROLE_HEX.column)}{counts.column} column</span>}
        {counts.beam > 0 && <span className={`${chip} bg-bg-secondary`}>{dot(ROLE_HEX.beam)}{counts.beam} beam</span>}
        {counts.brace > 0 && <span className={`${chip} bg-bg-secondary`}>{dot(ROLE_HEX.brace)}{counts.brace} brace</span>}
        {bearing && (
          <span className={`${chip} bg-bg-secondary`} style={{ color: BEARING_HEX }}>
            ★ bearing: {bearing.r.profile || bearing.r.tag}
          </span>
        )}
        <span className={`${chip} bg-bg-secondary`} style={eccCount ? { color: "#ef7d7d" } : undefined}>
          {eccCount} eccentric
        </span>
      </div>

      <svg viewBox={`0 ${top} ${W} ${bottom - top}`} width="100%" style={{ maxWidth: W }}>
        <defs>
          {spokes.map((s, i) => (
            <marker key={i} id={`mv-h${i}`} markerWidth="8" markerHeight="8" refX="5.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill={s.color} />
            </marker>
          ))}
        </defs>

        {/* axes */}
        <line x1={30} y1={cy} x2={W - 30} y2={cy} stroke={AXIS} strokeWidth={0.5} />
        <line x1={cx} y1={top + PAD} x2={cx} y2={bottom - PAD} stroke={AXIS} strokeWidth={0.5} />

        {/* bearing glow */}
        {spokes.filter((s) => s.isB).map((s, i) => (
          <line key={`g${i}`} x1={cx} y1={cy} x2={s.tx} y2={s.ty} stroke={BEARING_HEX} strokeWidth={12} strokeLinecap="round" opacity={0.16} />
        ))}

        {/* spokes */}
        {spokes.map((s, i) => (
          <line
            key={`s${i}`}
            x1={cx}
            y1={cy}
            x2={s.tx}
            y2={s.ty}
            stroke={s.color}
            strokeWidth={s.width}
            strokeLinecap="round"
            markerEnd={`url(#mv-h${i})`}
          />
        ))}

        {/* eccentricity markers (near node end of the spoke) */}
        {spokes.filter((s) => s.ecc).map((s, i) => {
          const ex = cx + (s.tx - cx) * 0.32;
          const ey = cy + (s.ty - cy) * 0.32;
          return <circle key={`e${i}`} cx={ex} cy={ey} r={5} fill="none" stroke="#ef7d7d" strokeWidth={1.4} strokeDasharray="2,2" />;
        })}

        {/* labels: tag + profile */}
        {labels.map((l, i) => (
          <g key={`l${i}`}>
            <text x={l.x} y={l.y} fill={l.s.isB ? BEARING_HEX : TEXT} fontSize={10} fontWeight={500} textAnchor={l.anchor}>
              {l.s.isB ? "★ " : ""}{l.s.r.tag || "—"}
            </text>
            <text x={l.x} y={l.y + 11} fill={SUB} fontSize={8.5} textAnchor={l.anchor}>
              {l.s.r.profile || l.s.role}{l.s.ecc ? " · ecc" : ""}
            </text>
          </g>
        ))}

        {/* node */}
        <circle cx={cx} cy={cy} r={9} fill="none" stroke={NODE_HEX} strokeWidth={1} opacity={0.5} />
        <circle cx={cx} cy={cy} r={4.5} fill={NODE_HEX} />

        {/* bearing star at tip */}
        {bearing && <polygon points={starPoints(bearing.tx, bearing.ty, 6)} fill={BEARING_HEX} />}

        {/* orientation triad */}
        {triad.map((t) => {
          const [dx, dy] = iso(t.v);
          const ex = tx + (dx / R) * TR;
          const ey = ty + (dy / R) * TR;
          return (
            <g key={t.name}>
              <line x1={tx} y1={ty} x2={ex} y2={ey} stroke={AXIS} strokeWidth={1} />
              <text x={ex + (ex >= tx ? 2 : -2)} y={ey + 3} fill={SUB} fontSize={8} textAnchor={ex >= tx ? "start" : "end"}>
                {t.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* legend */}
      <div className="flex flex-wrap gap-3 mt-1 text-[10px] text-text-secondary items-center">
        <span className="flex items-center gap-1"><span style={{ width: 14, height: 3, background: ROLE_HEX.column, borderRadius: 2 }} />column</span>
        <span className="flex items-center gap-1"><span style={{ width: 14, height: 3, background: ROLE_HEX.beam, borderRadius: 2 }} />beam</span>
        <span className="flex items-center gap-1"><span style={{ width: 14, height: 3, background: ROLE_HEX.brace, borderRadius: 2 }} />brace</span>
        <span className="flex items-center gap-1" style={{ color: BEARING_HEX }}>★ bearing</span>
        <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, borderRadius: "50%", border: "1.4px dashed #ef7d7d" }} />eccentric</span>
        <span>line thickness ∝ √Iy (stiffness)</span>
        <span><span style={{ color: NODE_HEX }}>●</span> node (CPA joint) · arrows close→far</span>
      </div>
    </div>
  );
};

export default JointDiagram;
