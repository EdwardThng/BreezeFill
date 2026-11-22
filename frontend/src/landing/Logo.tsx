/**
 * The mark itself, generated from the master by scripts/make_logo_assets.py
 * and served from public/. This used to be a hand-drawn SVG of a document
 * with a tick — nothing like the actual logo, which is why it read as missing
 * rather than wrong.
 */
export default function Logo({ className = "" }: { className?: string }) {
  return (
    <img
      className={`logo ${className}`.trim()}
      src="/website-logo-128.png"
      alt=""
      width={128}
      height={128}
      aria-hidden="true"
    />
  );
}
