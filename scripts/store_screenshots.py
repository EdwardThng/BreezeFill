"""Turn raw screen captures into Chrome Web Store screenshots.

The store wants exactly 1280x800 (or 640x400). A macOS window capture is
never that — it is whatever the window happened to be, at 2x on a retina
display. Uploading the wrong size gets the image rejected or letterboxed by
the store into something you did not compose.

This scales each capture to fit and centres it on a neutral ground, so the
result is exactly 1280x800 with the composition intact. It never stretches:
a distorted screenshot of a form-filling tool looks like a broken
form-filling tool.

    .venv/bin/python scripts/store_screenshots.py ~/BreezeFill_screenshots

Reads every PNG/JPEG in the folder that is not already an output, and writes
`store-1280x800-<name>.png` beside it. Run it again after retaking one; it
overwrites its own outputs and leaves the originals alone.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

WIDTH, HEIGHT = 1280, 800
PREFIX = "store-1280x800-"

# The panel's own paper colour. A screenshot that needs padding should look
# composed rather than letterboxed, and grey bars around a warm-grey UI read
# as a mistake.
GROUND = (245, 245, 244)

SOURCES = {".png", ".jpg", ".jpeg"}


def convert(source: Path, out_dir: Path) -> tuple[Path, str]:
    """One capture -> one exactly-1280x800 PNG. Returns the path and a note."""
    with Image.open(source) as raw:
        image = raw.convert("RGB")

    scale = min(WIDTH / image.width, HEIGHT / image.height)
    # Never enlarge past 1:1 — upscaling a 2x retina capture is free, but
    # blowing up a small window just makes it soft.
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    resized = image.resize(size, Image.LANCZOS)

    canvas = Image.new("RGB", (WIDTH, HEIGHT), GROUND)
    canvas.paste(resized, ((WIDTH - size[0]) // 2, (HEIGHT - size[1]) // 2))

    destination = out_dir / f"{PREFIX}{source.stem}.png"
    canvas.save(destination, "PNG")

    pad = "exact fit" if size == (WIDTH, HEIGHT) else (
        f"padded {WIDTH - size[0]}px wide, {HEIGHT - size[1]}px tall"
    )
    return destination, f"{image.width}x{image.height} -> {size[0]}x{size[1]}, {pad}"


def main(argv: list[str]) -> int:
    folder = Path(argv[1]).expanduser() if len(argv) > 1 else Path.cwd()
    if not folder.is_dir():
        print(f"Not a folder: {folder}")
        return 1

    captures = sorted(
        p
        for p in folder.iterdir()
        if p.suffix.lower() in SOURCES and not p.name.startswith(PREFIX)
    )
    if not captures:
        print(f"No captures found in {folder}")
        print("Take them first — see the submission runbook.")
        return 1

    for capture in captures:
        destination, note = convert(capture, folder)
        print(f"{capture.name:44} {note}")
        print(f"{'':44} -> {destination.name}")

    print(f"\n{len(captures)} ready to upload, all exactly {WIDTH}x{HEIGHT}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
