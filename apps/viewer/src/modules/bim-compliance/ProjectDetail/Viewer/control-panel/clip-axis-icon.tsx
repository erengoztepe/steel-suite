import * as React from "react";

interface ClipAxisIconProps extends React.SVGProps<SVGSVGElement> {
  axis: "XY" | "XZ" | "YZ";
  /** This plane's colour (axis colour for side "a", its complement for side "b"). */
  color: string;
  /** Plane on -> square filled with `color`; off -> coloured outline only. */
  active: boolean;
}

/**
 * A clipping-plane button glyph: a rounded square outlined in the plane's colour.
 * All six squares show their colour at rest (a colour-coded 2x3 grid); a plane
 * that is ON fills its square. No letters — colour + grid position identify the
 * plane, and the cell carries a `title` tooltip.
 */
function ClipAxisIcon({ axis, color, active, width = 16, height = 16, style, ...props }: ClipAxisIconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      // SVGs collapse to 0 width as flex/grid children — pin the box so the
      // coloured square always renders at its intended size.
      style={{ display: "block", flexShrink: 0, ...style }}
      {...props}
    >
      <title>{axis} clipping plane</title>
      <rect
        x="3"
        y="3"
        width="14"
        height="14"
        rx="3.5"
        fill={color}
        fillOpacity={active ? 0.9 : 0}
        stroke={color}
        strokeWidth={active ? 2.5 : 2}
      />
      {/* Axis letters, dark-outlined so they stay legible on light fills (yellow/cyan). */}
      <text
        x="10"
        y="13.2"
        textAnchor="middle"
        fontSize="7"
        fontWeight="700"
        fill="#ffffff"
        stroke="#0f172a"
        strokeWidth="0.7"
        paintOrder="stroke"
        fontFamily="system-ui, sans-serif"
      >
        {axis}
      </text>
    </svg>
  );
}

export default React.memo(ClipAxisIcon);
