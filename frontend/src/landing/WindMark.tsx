/**
 * The logo's three wind strokes, redrawn as lines rather than filled shapes.
 *
 * The master (assets/logo/source-master.svg) is traced outlines, which can be
 * filled but not drawn. These are centre-lines measured off that master, on
 * the same 600-unit grid, so the stroke can animate on (stroke-dashoffset) and
 * still lie exactly where the logo's strokes lie. Each path is a straight run
 * into a curl that turns 290 degrees, which is the logo's terminal.
 *
 * Decoration only, so it is always hidden from assistive tech.
 */
export const WIND_PATHS = [
  "M193 246 H285 A29 29 0 1 0 258 227",
  "M150 303 H401 A29 29 0 1 0 374 284",
  "M177 361 H321 A29 29 0 1 1 294 380",
];

export default function WindMark({
  className = "",
  strokeWidth = 27,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={`wind-mark ${className}`.trim()}
      viewBox="120 150 360 300"
      aria-hidden="true"
      focusable="false"
    >
      {WIND_PATHS.map((d, i) => (
        <path
          key={d}
          d={d}
          pathLength={1}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          style={{ ["--i" as string]: i }}
        />
      ))}
    </svg>
  );
}
