"""Every sized logo the product needs, generated from one master.

Run after changing `assets/logo/source-master-600.png`:

    ./.venv/Scripts/python.exe scripts/make_logo_assets.py

Needs Pillow (`pip install pillow`), which is deliberately NOT in
backend/requirements.txt — the server never resizes an image, so this is a
build tool like scripts/calibrate_overlay.py, not a runtime dependency.

---------------------------------------------------------------------------
Why files are named for where they appear, not for how big they are
---------------------------------------------------------------------------

"32px" says nothing about whether it can be deleted. "chrome-toolbar-retina"
says exactly who breaks if it goes. Several sizes also coincide by accident —
a favicon and a toolbar icon are both 32 — and naming by size invites someone
to "deduplicate" two files that answer to different platforms and would drift
apart the moment one of them needs a tweak.

---------------------------------------------------------------------------
The 16px crop, which is the only interesting thing here
---------------------------------------------------------------------------

The mark is three wind strokes with generous air around them: measured on the
master, the white artwork fills about 51% of the tile's width. That is right
at large sizes and fatal at 16, where the drawing lands in roughly nine pixels
and the three strokes merge into one pale blob — verified by rendering it, not
assumed.

So the small sizes get the same artwork scaled up inside the tile until it
fills ~82%, which was the point at which the strokes separate again. Nothing is
redrawn and no stroke is dropped; there is simply less air. The rounded-corner
silhouette is re-imposed afterwards from the master's own alpha channel,
because scaling the artwork up would otherwise push the corners off the tile
and quietly turn the logo into a square.

Large sizes keep the master's framing exactly as drawn. Using tighter framing
only where the pixels run out is standard practice for icon sets, and it is
what the brand guidelines call a size ladder.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - developer tooling
    sys.exit("Pillow is required: pip install pillow")

REPO_ROOT = Path(__file__).resolve().parent.parent
LOGO_DIR = REPO_ROOT / "assets" / "logo"
MASTER = LOGO_DIR / "source-master-600.png"
# Chrome cannot read icons from outside the extension directory — manifest
# paths are relative to it and may not climb out — so the four it needs are
# copied in. Generated, never hand-edited: change the master and re-run.
EXTENSION_ICONS = REPO_ROOT / "extension" / "icons"

# Below this size the mark is scaled up inside the tile before rendering.
# 16 and under is where rendering showed the strokes merging.
TIGHTEN_AT_OR_BELOW = 16
TIGHT_FILL = 0.82

# name -> (pixel size, what it is for). The comment is the point of the file.
OUTPUTS = {
    "chrome-toolbar-16": (16, "Toolbar button on a standard-DPI screen. The doctor clicks this to grant BreezeFill access to the tab, so legibility here is functional, not decorative."),
    "chrome-toolbar-retina-32": (32, "Same button on a hi-DPI screen, which is what most modern laptops draw."),
    "chrome-manage-page-48": (48, "chrome://extensions, where a doctor goes to remove or reload it."),
    "chrome-store-listing-128": (128, "Install dialog and the Chrome Web Store listing. The first thing a doctor sees."),
    "website-favicon-16": (16, "Browser tab for the marketing site."),
    "website-favicon-32": (32, "Browser tab, hi-DPI, and most bookmark bars."),
    "website-apple-touch-180": (180, "iOS home screen, if a doctor saves the site."),
    "linkedin-profile-300": (300, "LinkedIn company/profile picture. LinkedIn re-crops to a circle, and the mark sits well inside the safe area at this framing."),
}


def mark_bbox(img: Image.Image) -> tuple[int, int, int, int]:
    """The white artwork's bounds, measured rather than hardcoded.

    Measured so a redrawn logo with different padding still gets a correct
    crop instead of a stale constant nobody remembers to update.
    """
    px = img.load()
    xs: list[int] = []
    ys: list[int] = []
    for y in range(0, img.height, 2):
        for x in range(0, img.width, 2):
            r, g, b, a = px[x, y]
            if a > 128 and r > 225 and g > 225 and b > 225:
                xs.append(x)
                ys.append(y)
    if not xs:
        sys.exit("no white artwork found in the master — has the logo changed colour?")
    return min(xs), min(ys), max(xs), max(ys)


def tightened(master: Image.Image, fill: float) -> Image.Image:
    """The master with its artwork scaled up to fill `fill` of the tile."""
    w = master.width
    x0, y0, x1, y1 = mark_bbox(master)
    scale = (fill * w) / (x1 - x0)

    enlarged = master.resize((int(w * scale), int(w * scale)), Image.LANCZOS)
    cx, cy = ((x0 + x1) / 2) * scale, ((y0 + y1) / 2) * scale
    canvas = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    canvas.paste(enlarged, (int(-(cx - w / 2)), int(-(cy - w / 2))))
    # The master's own alpha is the rounded square. Re-imposing it is what
    # stops the enlarged artwork bleeding into the corners.
    canvas.putalpha(master.getchannel("A"))
    return canvas


def main() -> None:
    if not MASTER.is_file():
        sys.exit(f"master not found: {MASTER}")

    master = Image.open(MASTER).convert("RGBA")
    tight = tightened(master, TIGHT_FILL)
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    EXTENSION_ICONS.mkdir(parents=True, exist_ok=True)

    x0, y0, x1, y1 = mark_bbox(master)
    print(f"master {master.width}x{master.height}, artwork fills "
          f"{100 * (x1 - x0) / master.width:.0f}% of the tile")

    for name, (size, _purpose) in OUTPUTS.items():
        source = tight if size <= TIGHTEN_AT_OR_BELOW else master
        out = source.resize((size, size), Image.LANCZOS)
        path = LOGO_DIR / f"{name}.png"
        out.save(path, "PNG", optimize=True)
        note = " (tightened)" if source is tight else ""
        print(f"  {path.relative_to(REPO_ROOT)}  {size}x{size}{note}")

    for name in (n for n in OUTPUTS if n.startswith("chrome-")):
        src = LOGO_DIR / f"{name}.png"
        dst = EXTENSION_ICONS / f"{name}.png"
        dst.write_bytes(src.read_bytes())
        print(f"  {dst.relative_to(REPO_ROOT)}  (copy for the extension package)")


if __name__ == "__main__":
    main()
