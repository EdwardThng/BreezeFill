"""Render a flat form's pages with a point-grid, for placing overlay boxes.

Overlay schemas position each field by an (x, y, w, h) box in PDF points
measured from the page's TOP-LEFT corner. This renders each page as a PNG
with that coordinate grid drawn on top, so the boxes can be read straight
off the image instead of guessed.

    python scripts/calibrate_overlay.py forms/scans_unsupported/henner.pdf out/

Then, after writing the schema, check the result with:

    python scripts/calibrate_overlay.py --proof backend/schemas/henner.json out/

which fills every box with its own field id and renders the pages, so a
misplaced box is obvious at a glance.

Pages are rasterized with PyMuPDF. An earlier version pulled the embedded
full-page JPEG out of the PDF instead, which is fine for the blank form but
renders the proof mode useless: the overlay is vector text drawn *on top* of
that image, so extracting the image showed a blank form every time.

PyMuPDF is a calibration-only dependency (`pip install pymupdf`) — the server
never rasterizes, so it stays out of backend/requirements.txt.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from mapping import load_form_schema  # noqa: E402
from overlay_fill import overlay_fill  # noqa: E402

MAJOR = 50  # labelled grid interval, points
MINOR = 10
GRID = (0, 120, 255)
LABEL = (220, 0, 0)


def page_images(pdf_path: Path, zoom: float) -> list[tuple[Image.Image, float, float]]:
    """One PIL image per page, rasterized so 1 point == `zoom` pixels.

    Rasterizing (rather than extracting the embedded scan) is what makes the
    proof mode meaningful — it composites the overlay text with the page.
    """
    out = []
    with fitz.open(str(pdf_path)) as doc:
        for page in doc:
            pw, ph = page.rect.width, page.rect.height
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            out.append((img, pw, ph))
    return out


def draw_grid(img: Image.Image, pw: float, ph: float, zoom: float) -> None:
    d = ImageDraw.Draw(img, "RGBA")
    for x in range(0, int(pw) + 1, MINOR):
        major = x % MAJOR == 0
        d.line([(x * zoom, 0), (x * zoom, ph * zoom)], fill=(*GRID, 90 if major else 35), width=1)
        if major:
            d.text((x * zoom + 2, 2), str(x), fill=LABEL)
    for y in range(0, int(ph) + 1, MINOR):
        major = y % MAJOR == 0
        d.line([(0, y * zoom), (pw * zoom, y * zoom)], fill=(*GRID, 90 if major else 35), width=1)
        if major:
            d.text((2, y * zoom + 2), str(y), fill=LABEL)


def render(pdf_path: Path, out_dir: Path, zoom: float, grid: bool) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = pdf_path.stem
    for i, (img, pw, ph) in enumerate(page_images(pdf_path, zoom), start=1):
        if grid:
            draw_grid(img, pw, ph, zoom)
        dest = out_dir / f"{stem}_p{i}.png"
        img.save(dest)
        print(f"{dest}  ({pw:.0f}x{ph:.0f}pt)")


def proof(schema_path: Path, out_dir: Path, zoom: float) -> None:
    """Fill every box with its own field id, then render — a box in the wrong
    place shows up immediately."""
    schema = load_form_schema(schema_path)
    root = Path(__file__).resolve().parent.parent
    pdf_path = root / schema.pdf_path
    values = {
        f.id: (True if f.type == "checkbox" else f.id)
        for f in schema.fields
        if f.box is not None
    }
    filled = overlay_fill(pdf_path, schema.boxes, values)
    tmp = out_dir / f"_{schema.form_id}_proof.pdf"
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(filled)
    print(f"{tmp}  ({len(values)} boxes stamped)")
    render(tmp, out_dir, zoom, grid=False)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="PDF to calibrate, or schema JSON with --proof")
    ap.add_argument("out_dir")
    ap.add_argument("--proof", action="store_true", help="stamp field ids and render")
    ap.add_argument("--zoom", type=float, default=2.0, help="pixels per point")
    ap.add_argument("--no-grid", action="store_true")
    args = ap.parse_args()

    if args.proof:
        proof(Path(args.target), Path(args.out_dir), args.zoom)
    else:
        render(Path(args.target), Path(args.out_dir), args.zoom, grid=not args.no_grid)


if __name__ == "__main__":
    main()


# The proof PDF written above is a build artifact, not patient data — it
# contains only field ids. Keep it out of the repo.
