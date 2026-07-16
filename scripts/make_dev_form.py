"""Generate the synthetic fillable AcroForm PDF used for development and
tests (forms/dev_sample.pdf). Entirely synthetic — stands in for a real
insurer form until the three real MVP forms are collected.

Run from repo root: python scripts/make_dev_form.py
"""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "forms" / "dev_sample.pdf"


def make_dev_form(out_path: Path = OUT_PATH) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(out_path), pagesize=A4)
    form = c.acroForm

    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, 800, "FormFill Dev Sample — Specialist Report (synthetic)")
    c.setFont("Helvetica", 10)

    rows = [
        ("Patient name", "Text_PatientName"),
        ("Date of birth (DD/MM/YYYY)", "Text_DOB"),
        ("Primary diagnosis", "Text_Diagnosis1"),
        ("Date of first consultation", "Date_FirstConsult"),
    ]
    y = 750
    for label, name in rows:
        c.drawString(50, y + 4, label + ":")
        form.textfield(
            name=name, x=250, y=y, width=280, height=18,
            borderWidth=0.5, forceBorder=True,
        )
        y -= 40

    c.drawString(50, y + 4, "Pre-existing condition:")
    form.checkbox(name="Check_PreExisting", x=250, y=y, size=14, borderWidth=0.5)

    c.save()
    return out_path


if __name__ == "__main__":
    print(f"wrote {make_dev_form()}")
