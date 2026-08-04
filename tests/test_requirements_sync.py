"""The two requirements files must not drift.

`backend/requirements.txt` is what local development and the Docker image
install. `requirements.txt` at the repo root is what Vercel installs, and it
exists separately because Vercel detects the framework by reading that file —
an `-r backend/requirements.txt` indirection would hide FastAPI from detection.

Two files listing the same packages is a drift hazard, and the failure mode is
nasty: a dependency added for a new feature works everywhere except the
deployed function, where it surfaces as an ImportError at runtime on the first
request that needs it. This test is the thing that stops that.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ROOT_REQS = REPO_ROOT / "requirements.txt"
BACKEND_REQS = REPO_ROOT / "backend" / "requirements.txt"

# Installed for tests only, or provided by the platform. Never shipped in the
# function bundle, so their absence from the root file is intended.
NOT_DEPLOYED = {"pytest", "httpx", "uvicorn"}


def _packages(path: Path) -> dict[str, str]:
    """name -> version spec, for every requirement line in a file."""
    found: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#")[0].strip()
        if not line or line.startswith("-"):
            continue
        match = re.match(r"^([A-Za-z0-9_.\-]+)\s*(.*)$", line)
        assert match, f"unparseable requirement in {path.name}: {line!r}"
        found[match.group(1).lower()] = match.group(2).replace(" ", "")
    return found


def test_every_runtime_dependency_is_deployed() -> None:
    backend = _packages(BACKEND_REQS)
    root = _packages(ROOT_REQS)
    missing = sorted(set(backend) - NOT_DEPLOYED - set(root))
    assert not missing, (
        f"{missing} is in backend/requirements.txt but not requirements.txt, so it "
        "would be missing from the deployed function"
    )


def test_the_deployed_set_invents_nothing() -> None:
    # The root file is a subset, never a superset: a package here and not in
    # backend/ would be installed in production and untested locally.
    extra = sorted(set(_packages(ROOT_REQS)) - set(_packages(BACKEND_REQS)))
    assert not extra, f"{extra} is deployed but not installed for development or tests"


def test_version_specs_match() -> None:
    """Same floor in both places. Different ones mean production can resolve a
    version no test ever ran against."""
    backend = _packages(BACKEND_REQS)
    for name, spec in _packages(ROOT_REQS).items():
        assert spec == backend[name], f"{name}: root says {spec!r}, backend says {backend[name]!r}"


def test_test_only_packages_are_not_shipped() -> None:
    # They would go into the function bundle, which has a size limit and no
    # use for a test runner.
    assert not (NOT_DEPLOYED & set(_packages(ROOT_REQS)))
