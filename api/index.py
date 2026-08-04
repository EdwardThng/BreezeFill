"""Vercel entrypoint: the same FastAPI app, as a serverless function.

Vercel's Python runtime looks for a module under `api/` exporting an ASGI
callable named `app`. `backend/` is not importable from here by default —
locally the app runs as `uvicorn main:app --app-dir backend`, which puts that
directory on the path — so this re-creates that one condition and imports the
real thing. There is no second copy of the application to drift.

---------------------------------------------------------------------------
Why this is possible at all
---------------------------------------------------------------------------

It was not, until the claim store was removed (2026-08-04). Serverless gives no
sticky instance: a claim created on one invocation would have 404'd when the
approve request landed on another, exactly the two-machine trap `--ha=false`
used to guard against on Fly, but permanent. Every route is stateless now, so
"which instance handled this request" stopped being a question anyone can ask.

Do not reintroduce server-side state here. On this platform it would not fail
loudly — it would work in development, work under light traffic, and start
losing claims once Vercel scaled to a second instance.

---------------------------------------------------------------------------
Paths
---------------------------------------------------------------------------

`main.py` resolves `REPO_ROOT` two levels up from itself and reads
`forms/`, `backend/schemas/` and `extension/` beneath it. Those are pulled into
the bundle by `includeFiles` in vercel.json — a function bundle contains only
what it is told to, and a missing `forms/` directory would surface as a 500 on
the first PDF fill rather than at deploy time.

`frontend/dist` is deliberately NOT included: on Vercel the static site is
served from the CDN, never through this function. `main.py` already guards that
mount with `is_dir()`, so it simply does not mount here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from main import app  # noqa: E402  (path must be set before this import)

__all__ = ["app"]
