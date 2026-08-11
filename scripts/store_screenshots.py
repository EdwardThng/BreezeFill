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

---------------------------------------------------------------------------
--crop, and the problem it solves
---------------------------------------------------------------------------

The side panel is Chrome UI down the right-hand edge, so a whole-window
capture spends three quarters of its width on the insurer's form. Scaled into
1280x800 the panel's text lands around 9px — and that text is the product's
entire argument, unreadable at the size the store draws a listing thumbnail.

    --crop right:45      the rightmost 45% of the width
    --crop left:60       the leftmost 60%
    --crop 1600,0,1400,875   an exact region, x,y,w,h in source pixels

The fractional forms also trim the height to the store's own 16:10, anchored
at the top, so the result FILLS the frame instead of sitting in a letterbox.
That matters: a full-height slice of a wide capture is portrait, and a
portrait region centred in a landscape frame is mostly ground — the opposite
of the legibility the flag exists for. The panel is anchored at the top
because that is where its header and current step are.

An exact region is used verbatim and padded as usual: you measured it, so it
is not second-guessed.

One crop applies to every capture in the run, which is the normal case — a
batch shot in one window layout shares one geometry. Outputs keep the same
name, so a cropped run overwrites an uncropped one for the same capture.
"""

from __future__ import annotations

import argparse
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


class CropError(ValueError):
    """A --crop spec that cannot be honoured. Reported, never guessed around."""


def parse_crop(spec: str) -> tuple[str, tuple[int, ...]]:
    """`right:45`, `left:60` or `x,y,w,h` -> a tagged spec.

    Validated here rather than at use, so a typo fails before any file is
    written instead of halfway through a batch.
    """
    text = spec.strip().lower()

    for side in ("right", "left"):
        if text.startswith(f"{side}:"):
            raw = text.split(":", 1)[1].strip().rstrip("%")
            try:
                percent = float(raw)
            except ValueError:
                raise CropError(f"{side}: wants a percentage, got {raw!r}") from None
            if not 0 < percent <= 100:
                raise CropError(f"{side}: wants 0 to 100, got {percent:g}")
            return side, (percent,)

    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 4:
        raise CropError(
            f"cannot read {spec!r} — use right:45, left:60, or x,y,w,h"
        )
    try:
        x, y, w, h = (int(p) for p in parts)
    except ValueError:
        raise CropError(f"x,y,w,h must be whole pixels, got {spec!r}") from None
    if w <= 0 or h <= 0:
        raise CropError(f"width and height must be positive, got {w}x{h}")
    if x < 0 or y < 0:
        raise CropError(f"x and y must not be negative, got {x},{y}")
    return "box", (x, y, w, h)


def crop_box(spec: tuple[str, tuple[int, ...]], width: int, height: int):
    """The region to keep, as a PIL box, for one image's dimensions."""
    kind, values = spec

    if kind == "box":
        x, y, w, h = values
        if x + w > width or y + h > height:
            raise CropError(
                f"region {x},{y},{w},{h} falls outside a {width}x{height} capture"
            )
        return (x, y, x + w, y + h)

    keep = max(1, round(width * values[0] / 100))
    left = width - keep if kind == "right" else 0
    # Trim to the store's aspect so the crop fills the frame rather than
    # letterboxing. Clamped, because a narrow crop of a short capture cannot
    # always reach 16:10 — then it pads, which is still the honest result.
    tall = min(height, max(1, round(keep * HEIGHT / WIDTH)))
    return (left, 0, left + keep, tall)


def convert(source: Path, out_dir: Path, crop: tuple | None = None) -> tuple[Path, str]:
    """One capture -> one exactly-1280x800 PNG. Returns the path and a note."""
    with Image.open(source) as raw:
        image = raw.convert("RGB")

    original = f"{image.width}x{image.height}"
    cropped = ""
    if crop is not None:
        box = crop_box(crop, image.width, image.height)
        image = image.crop(box)
        cropped = f" cropped to {image.width}x{image.height}"

    scale = min(WIDTH / image.width, HEIGHT / image.height)
    # Scaling up is allowed and is what --crop relies on: a region of a 2x
    # retina capture holds more real pixels than 1280x800 needs, so enlarging
    # it back to the frame costs nothing. Capping at 1:1 would leave every
    # crop marooned in the middle of the ground, which is the letterbox the
    # flag exists to avoid.
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    resized = image.resize(size, Image.LANCZOS)

    canvas = Image.new("RGB", (WIDTH, HEIGHT), GROUND)
    canvas.paste(resized, ((WIDTH - size[0]) // 2, (HEIGHT - size[1]) // 2))

    destination = out_dir / f"{PREFIX}{source.stem}.png"
    canvas.save(destination, "PNG")

    pad = "exact fit" if size == (WIDTH, HEIGHT) else (
        f"padded {WIDTH - size[0]}px wide, {HEIGHT - size[1]}px tall"
    )
    return destination, f"{original}{cropped} -> {size[0]}x{size[1]}, {pad}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="store_screenshots.py",
        description="Turn raw screen captures into 1280x800 Chrome Web Store images.",
    )
    parser.add_argument(
        "folder",
        nargs="?",
        default=None,
        help="folder of captures (default: the current directory)",
    )
    parser.add_argument(
        "--crop",
        metavar="SPEC",
        help="right:45 | left:60 | x,y,w,h — keep a region and scale it up, "
             "so the side panel is legible at thumbnail size",
    )
    args = parser.parse_args(argv[1:])

    folder = Path(args.folder).expanduser() if args.folder else Path.cwd()
    if not folder.is_dir():
        print(f"Not a folder: {folder}")
        return 1

    crop = None
    if args.crop:
        try:
            crop = parse_crop(args.crop)
        except CropError as error:
            print(f"--crop {args.crop}: {error}")
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

    written = 0
    for capture in captures:
        try:
            destination, note = convert(capture, folder, crop)
        except CropError as error:
            # Named rather than swallowed: a region that fits one capture and
            # not another means the window moved between shots, and silently
            # skipping would leave a gap nobody notices until upload.
            print(f"{capture.name:44} SKIPPED — {error}")
            continue
        print(f"{capture.name:44} {note}")
        print(f"{'':44} -> {destination.name}")
        written += 1

    if not written:
        print("\nNothing written.")
        return 1
    skipped = len(captures) - written
    tail = f" ({skipped} skipped)" if skipped else ""
    print(f"\n{written} ready to upload, all exactly {WIDTH}x{HEIGHT}.{tail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
