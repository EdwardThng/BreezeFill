"""The extension download (GET /download/claimfill-extension.zip).

The site's whole purpose now is handing this file out, so the thing worth
testing is that what arrives is installable: the manifest at the top of one
folder, every file it references present, and nothing in it that should not be
shipped to a doctor's machine.
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))

import main

client = TestClient(main.app)

URL = "/download/claimfill-extension.zip"


@pytest.fixture
def archive() -> zipfile.ZipFile:
    response = client.get(URL)
    assert response.status_code == 200, response.text
    return zipfile.ZipFile(io.BytesIO(response.content))


def test_it_is_served_as_a_download(archive: zipfile.ZipFile) -> None:
    response = client.get(URL)
    assert response.headers["content-type"] == "application/zip"
    # Without this the browser navigates to the zip instead of saving it.
    assert "attachment" in response.headers["content-disposition"]
    assert "claimfill-extension.zip" in response.headers["content-disposition"]


def test_everything_sits_under_one_folder(archive: zipfile.ZipFile) -> None:
    # So unzipping produces exactly the directory "Load unpacked" wants
    # selected, rather than scattering files into the Downloads folder.
    assert all(name.startswith("claimfill-extension/") for name in archive.namelist())


def test_the_manifest_is_where_chrome_looks_for_it(archive: zipfile.ZipFile) -> None:
    manifest = json.loads(archive.read("claimfill-extension/manifest.json"))
    assert manifest["manifest_version"] == 3


def test_every_file_the_manifest_references_is_present(archive: zipfile.ZipFile) -> None:
    """The failure this catches is the worst kind: Chrome refuses the whole
    extension for one missing file, and the error names the file rather than
    the packaging step that dropped it."""
    manifest = json.loads(archive.read("claimfill-extension/manifest.json"))
    names = set(archive.namelist())

    referenced: list[str] = []
    if "background" in manifest:
        referenced.append(manifest["background"]["service_worker"])
    if "side_panel" in manifest:
        referenced.append(manifest["side_panel"]["default_path"])
    action = manifest.get("action", {})
    for key in ("default_popup", "default_icon"):
        value = action.get(key)
        if isinstance(value, str):
            referenced.append(value)
        elif isinstance(value, dict):
            referenced.extend(value.values())

    assert referenced, "manifest referenced no files; this test would pass vacuously"
    for path in referenced:
        assert f"claimfill-extension/{path}" in names, path


def test_the_files_the_panel_injects_are_all_there(archive: zipfile.ZipFile) -> None:
    # panel.js injects these four by name at fill time. A missing one fails in
    # the browser, on a doctor's machine, mid-claim.
    for path in ("learn/dump.js", "fill/locate.js", "fill/apply.js", "content/fill.js"):
        assert f"claimfill-extension/{path}" in archive.namelist(), path


def test_tests_are_not_shipped(archive: zipfile.ZipFile) -> None:
    assert not [n for n in archive.namelist() if n.endswith(".test.js")]


def test_nothing_enormous_slipped_in(archive: zipfile.ZipFile) -> None:
    # A stray node_modules under extension/ would sail through the recursive
    # walk and turn a 60KB download into a 60MB one.
    assert not [n for n in archive.namelist() if "node_modules" in n]
    assert sum(info.file_size for info in archive.infolist()) < 2_000_000


def test_it_is_the_running_source_not_a_stale_build(archive: zipfile.ZipFile) -> None:
    """Zipped per request from the source tree, so a download can never be
    older than the server answering it."""
    live = (main.EXTENSION_DIR / "panel" / "panel.js").read_bytes()
    assert archive.read("claimfill-extension/panel/panel.js") == live
