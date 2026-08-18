"""The form bank: schemas derived from uploaded PDFs, kept for the next doctor.

WHY THIS EXISTS, AND WHY IT IS THE ONE PIECE OF SERVER STATE
------------------------------------------------------------

`main.py` opens by saying every route is stateless and that a shared store
would be "a database holding patient data, which is a thing this product says
publicly it does not have". That is still true and this does not change it.

What is stored here is a **blank insurer form** and the schema derived from it.
No patient, no note, no claim, no demographic — a published document that the
insurer hands out to anyone who asks, and a description of where its boxes are.
The rule worth defending was never "no bytes may persist"; it was that nothing
about a patient survives the request that carried it in. That is unchanged, and
`intake_guard` below is what keeps it unchanged: a PDF that already has values
in its fields is somebody's filled claim, and it is refused for banking.

WHY IT IS WORTH THE EXCEPTION
-----------------------------

Deriving a schema costs a model call per page of the form and is the slow,
expensive, error-prone step of the whole upload path. It is also the step whose
answer is identical for every doctor who ever uploads that same form. Banking
it means the second doctor to send in Prudential's medical report waits for
nothing and pays for nothing, and — more to the point — gets a schema that has
already been seen to work rather than a freshly guessed one.

STORAGE
-------

Two backends behind one interface, chosen by environment:

- `LocalBank` writes to a directory. This is what runs in development and in
  the tests, and it is what runs in production too if nothing else is
  configured — the feature degrades to "derive it every time", which is slower
  and correct, rather than failing.
- `BlobBank` talks to Vercel Blob over plain HTTP. Vercel publishes no
  first-party Python SDK for Blob, and the one on PyPI is a single-maintainer
  package that pulls in `requests` and `tqdm`; the API surface needed here is
  two calls, so it is written against `urllib` and costs no new dependency.

A backend that fails NEVER fails the request. Banking is a cache, and a doctor
holding a form should not be told to come back later because a storage call
timed out. Every write is best-effort and every read falls through to deriving.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from mapping import FormSchema

logger = logging.getLogger("formfill.bank")

# Everything this module writes lives under one prefix, so the bank can be
# listed, audited and emptied without touching anything else in the store.
BANK_PREFIX = "form-bank/"

BLOB_API = "https://blob.vercel-storage.com"
BLOB_API_VERSION = "10"
BLOB_TIMEOUT_SECONDS = 10


class BankKey(str):
    """A content hash of the blank form PDF.

    The key is the PDF's own bytes rather than its filename, and that is the
    property the whole cache rests on: two doctors uploading "claim form.pdf"
    from two different insurers get two different keys, and the same doctor
    re-uploading the identical file gets a hit. A filename would do neither.
    """


def key_for(pdf_bytes: bytes) -> BankKey:
    return BankKey(hashlib.sha256(pdf_bytes).hexdigest()[:32])


FORM_ID_PREFIX = "upload_"


def form_id_for(key: BankKey) -> str:
    """The form_id an uploaded form is known by.

    Carries the WHOLE key, not a shortened one, and that is what keeps the
    upload path stateless. `/map` and `/forms/{id}/pdf` arrive as separate
    requests and may well land on different machines; a form_id the bank key
    can be read back out of means the second machine can find the form without
    anything having been remembered between the two. A truncated id would have
    needed a lookup table, which is server state, which is the thing this
    codebase does not have.

    Prefixed so it can never collide with a hand-authored schema id.
    """
    return f"{FORM_ID_PREFIX}{key}"


def key_from_form_id(form_id: str) -> BankKey | None:
    """The bank key inside an uploaded form's id, or None if it is not one."""
    if not form_id.startswith(FORM_ID_PREFIX):
        return None
    key = form_id[len(FORM_ID_PREFIX):]
    if not re.fullmatch(r"[0-9a-f]{32}", key):
        return None
    return BankKey(key)


_SAFE_NAME = re.compile(r"[^A-Za-z0-9 ()\-_.]")


def display_name_for(filename: str) -> str:
    """A human name for the picker, from the uploaded filename.

    Sanitised because it is echoed back to the browser and, more importantly,
    because it is written into a schema that gets stored: an uploaded filename
    is attacker-controlled text in the general case.
    """
    name = Path(filename or "").name
    # `.pdf` is a file with NO NAME, not a dotfile with no extension — which is
    # the other way round from how `Path.stem` reads it, and the difference is
    # a picker entry reading "pdf".
    stem = "" if name.startswith(".") and "." not in name[1:] else Path(name).stem
    return _SAFE_NAME.sub("", stem.replace("_", " ")).strip(" .-_")[:80] or "Uploaded form"


class IntakeRefused(Exception):
    """The upload must not be banked. Carries the reason shown to the doctor."""


def intake_guard(already_filled: bool) -> None:
    """The one check that keeps the PHI rule true.

    A blank form is a public document. A filled one is a patient's claim, and
    banking it would put clinical data into shared storage — the exact thing
    every other line of this codebase is arranged to prevent. Refused loudly
    rather than silently skipped, because a doctor who uploaded the wrong file
    needs to know they did.
    """
    if already_filled:
        raise IntakeRefused(
            "That PDF already has answers filled into it, so it is a completed "
            "claim rather than a blank form. Upload the empty form instead — "
            "BreezeFill never stores a patient's claim."
        )


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------


class LocalBank:
    """The bank as a directory. Development, tests, and the fallback."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _paths(self, key: BankKey) -> tuple[Path, Path]:
        return self.root / f"{key}.json", self.root / f"{key}.pdf"

    def get_schema(self, key: BankKey) -> FormSchema | None:
        schema_path, _ = self._paths(key)
        if not schema_path.exists():
            return None
        try:
            return FormSchema.model_validate_json(schema_path.read_text("utf-8"))
        except Exception:
            # A schema that no longer parses is a schema from an older shape of
            # this code. Deriving again is cheap and correct; refusing is not.
            logger.warning("banked schema failed to parse; re-deriving")
            return None

    def get_pdf(self, key: BankKey) -> bytes | None:
        _, pdf_path = self._paths(key)
        return pdf_path.read_bytes() if pdf_path.exists() else None

    def put(self, key: BankKey, schema: FormSchema, pdf_bytes: bytes) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        schema_path, pdf_path = self._paths(key)
        pdf_path.write_bytes(pdf_bytes)
        schema_path.write_text(schema.model_dump_json(indent=2), "utf-8")


class BlobBank:
    """The bank on Vercel Blob.

    Reads go straight to the public blob URL, which needs no credential. The
    complication is learning that URL: it lives on a per-store subdomain this
    process is never told. So the bank is listed once per cold start, which is
    a single call, gives the base URL and the full contents at the same time,
    and is proportionate for a store holding tens of forms.
    """

    def __init__(self, token: str) -> None:
        self.token = token
        self._index: dict[str, str] | None = None  # pathname -> public url

    # -- HTTP -------------------------------------------------------------

    def _call(self, url: str, *, method: str, headers: dict[str, str], body: bytes | None = None):
        request = urllib.request.Request(url, data=body, method=method)
        for name, value in headers.items():
            request.add_header(name, value)
        return urllib.request.urlopen(request, timeout=BLOB_TIMEOUT_SECONDS)

    def _auth_headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self.token}",
            "x-api-version": BLOB_API_VERSION,
        }

    def _load_index(self) -> dict[str, str]:
        if self._index is not None:
            return self._index
        index: dict[str, str] = {}
        try:
            query = urllib.parse.urlencode({"prefix": BANK_PREFIX, "limit": "1000"})
            with self._call(
                f"{BLOB_API}?{query}", method="GET", headers=self._auth_headers()
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
            for blob in payload.get("blobs") or []:
                pathname, url = blob.get("pathname"), blob.get("url")
                if pathname and url:
                    index[pathname] = url
        except Exception as exc:
            # Cached as empty on purpose: a store that cannot be listed is a
            # store with nothing in it as far as this request is concerned, and
            # retrying the list on every lookup would turn one slow call into
            # one slow call per field.
            logger.warning("form bank list failed (%s); deriving instead", type(exc).__name__)
        self._index = index
        return index

    def _fetch(self, pathname: str) -> bytes | None:
        url = self._load_index().get(pathname)
        if not url:
            return None
        try:
            with urllib.request.urlopen(url, timeout=BLOB_TIMEOUT_SECONDS) as response:
                return response.read()
        except Exception as exc:
            logger.warning("form bank read failed (%s)", type(exc).__name__)
            return None

    # -- Bank interface ---------------------------------------------------

    def get_schema(self, key: BankKey) -> FormSchema | None:
        raw = self._fetch(f"{BANK_PREFIX}{key}.json")
        if raw is None:
            return None
        try:
            return FormSchema.model_validate_json(raw.decode("utf-8"))
        except Exception:
            logger.warning("banked schema failed to parse; re-deriving")
            return None

    def get_pdf(self, key: BankKey) -> bytes | None:
        return self._fetch(f"{BANK_PREFIX}{key}.pdf")

    def put(self, key: BankKey, schema: FormSchema, pdf_bytes: bytes) -> None:
        self._upload(f"{BANK_PREFIX}{key}.pdf", pdf_bytes, "application/pdf")
        self._upload(
            f"{BANK_PREFIX}{key}.json",
            schema.model_dump_json(indent=2).encode("utf-8"),
            "application/json",
        )

    def _upload(self, pathname: str, data: bytes, content_type: str) -> None:
        headers = {
            **self._auth_headers(),
            "access": "public",
            "x-content-type": content_type,
            # Deterministic pathnames: the key IS the content hash, so a
            # random suffix would make the same form unfindable next time.
            "x-allow-overwrite": "1",
            "content-type": content_type,
        }
        try:
            url = f"{BLOB_API}/{urllib.parse.quote(pathname)}"
            with self._call(url, method="PUT", headers=headers, body=data) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if self._index is not None and payload.get("url"):
                self._index[pathname] = payload["url"]
        except Exception as exc:
            # Best effort, always. The doctor already has their schema; this
            # only decides whether the NEXT doctor has to wait for it too.
            logger.warning("form bank write failed (%s)", type(exc).__name__)


class NullBank:
    """No storage at all. Every upload is derived fresh."""

    def get_schema(self, key: BankKey) -> FormSchema | None:
        return None

    def get_pdf(self, key: BankKey) -> bytes | None:
        return None

    def put(self, key: BankKey, schema: FormSchema, pdf_bytes: bytes) -> None:
        return None


def build_bank():
    """The bank this deployment uses, decided by environment.

    `BREEZEFILL_FORM_BANK_DIR` wins over Blob so a developer can point the bank
    at a local directory without unsetting a token they need for other things.
    """
    local_dir = os.environ.get("BREEZEFILL_FORM_BANK_DIR")
    if local_dir:
        return LocalBank(local_dir)
    token = os.environ.get("BLOB_READ_WRITE_TOKEN")
    if token:
        return BlobBank(token)
    return NullBank()
