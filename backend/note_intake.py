"""Reading a consultation note out of an uploaded PDF.

THIS MODULE HANDLES PHI. `form_intake.py`, next to it, deliberately does not —
that one reads blank insurer forms, which are published documents with no
patient in them, and its docstring says so in order to justify sending them to
the model unredacted. Nothing in that justification applies here. What this
reads is a doctor's clinical note about a named patient, and it is the same
material as the paste box, arriving by a different route.

So it does exactly one thing: PDF bytes in, text out. It does not redact, does
not parse, does not call a model, and does not decide anything. The text it
returns joins the ordinary pipeline at the point the paste box feeds — which
means it is redacted by whatever redacts a paste, and no earlier and no later.

The one product decision in here is that the extracted text is handed BACK TO
THE DOCTOR rather than passed onward invisibly. A PDF's text layer is not
always what the page looks like: columns interleave, headers repeat, a letter
carries the clinic's address and the previous patient's name in a footer. The
doctor has to see what was actually read before it is mapped, for the same
reason the parsed demographics stay on screen and stay editable — what is shown
there is what redaction will be searching through.

Nothing here touches disk.
"""

from __future__ import annotations

import io

from pypdf import PdfReader

# Below this there is no usable text layer. A scanned or photographed note
# comes back at 0, and a handful of stray characters from a watermark or a
# form-feed is not a note either.
MIN_NOTE_CHARS = 60


class NoteIntakeError(Exception):
    """The upload cannot become text.

    NEVER put any of the document's content in the message. This exception is
    raised while holding a patient's clinical note, and its message goes into
    an HTTP response and, worse, potentially into a log.
    """


SCANNED_NOTE_REFUSAL = (
    "There is no readable text in that PDF — it looks like a scan or a photo "
    "rather than a document exported from your clinic system. Export the note "
    "as a PDF from your records instead, or copy and paste the text."
)


def extract_note_text(data: bytes) -> str:
    """Every page's text, in page order, or a refusal that says what to do.

    Deliberately not clever. No column reconstruction, no header stripping, no
    de-duplication of repeated running titles — anything this module removed
    would be removed from the doctor's view of it too, and a note is not a
    thing to silently drop lines from. It is shown as read and edited by hand.
    """
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise NoteIntakeError("That file could not be read as a PDF.") from exc

    if reader.is_encrypted:
        try:
            if not reader.decrypt(""):
                raise NoteIntakeError(
                    "That PDF is password-protected. Save an unprotected copy "
                    "and upload that, or copy and paste the text."
                )
        except NoteIntakeError:
            raise
        except Exception as exc:
            raise NoteIntakeError(
                "That PDF is password-protected. Save an unprotected copy and "
                "upload that, or copy and paste the text."
            ) from exc

    pages: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            # One unreadable page does not lose the rest of the note. The
            # doctor sees what came out and can paste the remainder.
            continue
        if text.strip():
            pages.append(text.strip())

    joined = "\n\n".join(pages).strip()
    if len(joined) < MIN_NOTE_CHARS:
        raise NoteIntakeError(SCANNED_NOTE_REFUSAL)
    return joined
