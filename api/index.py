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

`frontend/dist` IS included, and this paragraph said the opposite until
2026-10-11. It used to be true: the static site came off the CDN and never
through this function, so the bundle excluded it and `main.py`'s `is_dir()`
guard simply did not mount.

Vercel changed underneath that. A FastAPI project is now detected as a "backend
framework project" and EVERY request is routed to the function — its own build
log warns that "internal rewrites in backend framework projects now route
requests using the rewritten destination path". Static files in `public/` stopped
being served ahead of this function, so `/`, `/privacy`, `/robots.txt` and every
hashed asset arrived here, found no mount, and got FastAPI's generic 404. The
whole website was down while `/health` answered normally, which is why it read
as a routing problem rather than an outage.

So the single-origin arrangement that already worked locally is now the one in
production too: the bundle carries `frontend/dist` and `main.py:1422` mounts it
at `/`. 292 KB.

Two consequences to accept rather than route around. Every page view is now a
function invocation, so a cold start lands on the landing page rather than only
on an API call. And the `/privacy` -> `/privacy.html` rewrite in vercel.json is
applied by the platform BEFORE this function sees the path, which is the only
reason that URL still resolves — `StaticFiles` would not serve an extensionless
path by itself.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from main import app  # noqa: E402  (path must be set before this import)

__all__ = ["app"]
