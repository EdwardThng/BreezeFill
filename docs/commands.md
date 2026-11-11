# Commands

Paths are macOS/Linux (`.venv/bin/python`) as of 2026-08-06. On Windows the
same venv puts the interpreter at `.venv/Scripts/python.exe` — see the
toolchain note below, which is the whole of what changes between the two.

```bash
# tests (offline, no API key needed)
.venv/bin/python -m pytest -q

# extension tests (separate toolchain — vitest + jsdom, from the repo root)
npm install && npm test

# website tests (a THIRD project: its own vitest, its own jsdom, React plugin)
cd frontend && npm install && npm test
# Both vitest projects carry an explicit `include`. Without one the root runner
# discovers frontend/src/*.test.tsx and runs them without the React plugin —
# 28 failures that look like the website is broken when it is green.

# load the extension: chrome://extensions -> Developer mode -> Load unpacked
# -> select extension/. Reload it after every change; the side panel needs
# reopening, and content scripts need the insurer tab reloaded too.
# Point it at a local backend via the panel's Advanced -> Backend URL.

# backend dev. The key must be exported IN THIS SHELL — the extension's only
# backend is this process, and without the key POST /map returns 503.
export ANTHROPIC_API_KEY=...    # never via Claude Code's `!` prefix: it is logged
.venv/bin/python -m uvicorn main:app --app-dir backend --port 8000

# ...except for the RoboForm route, which needs NO key at all. Its schema is
# all-demographics, so map_fields never calls the model; disabling the sweep
# removes the only other call. FORMFILL_SHOW_INTERNAL puts the test schema in
# the picker, which is the only way the panel can name it.
export FORMFILL_SHOW_INTERNAL=1 FORMFILL_DISABLE_SWEEP=1
.venv/bin/python -m uvicorn main:app --app-dir backend --port 8000
# then: https://www.roboform.com/filling-test-all-fields, click the BreezeFill
# icon ON THAT TAB, paste a case from docs/testing/test_notes.md, Map, Fill.

# frontend dev (expects backend on :8000)
cd frontend && npm run dev            # http://localhost:5173

# production shape locally: build the frontend, then hit the backend alone
cd frontend && npm run build          # backend then serves it at /
.venv/bin/python -m uvicorn main:app --app-dir backend --port 8100

# dump a PDF's field names when adding a form
.venv/bin/python backend/pdf_fill.py forms/your_form.pdf

# Vercel. Login and `env add` need a real terminal; everything else runs from
# here once auth exists. `vercel env ls` prints names and "Encrypted", never
# values.
#
# Auth is NOT at ~/.vercel on macOS — it lives in
# ~/Library/Application Support/com.vercel.cli, so an absent ~/.vercel proves
# nothing. Check with `vercel whoami`, which is the only reliable test.
# `vercel link` here wrote .vercel/repo.json (repo-level) and an OIDC token
# into .env.local; both are gitignored, and .env.local holds a credential, so
# keep it that way.
vercel whoami                       # is anyone logged in at all
vercel domains ls --scope breeze-fill
vercel domains inspect breezefill.com --scope breeze-fill   # prints the DNS records needed
vercel alias ls                     # which hostname points at which deployment
vercel deploy --yes                 # preview
vercel deploy --prod --yes          # production
vercel env ls

# Probing a PROTECTED preview: only `vercel curl` carries the SSO bypass, and
# the URL must come FIRST. See Traps — it reads the first path-like token as
# the path, so `-o /dev/null` silently fetches /dev/null instead.
vercel curl https://<deployment>/health
vercel curl https://<deployment>/map -s -i -X POST \
  -H "Content-Type: application/json" --data-binary @probe.json
```


The `!` prefix in Claude Code runs **Bash**, not PowerShell.

**Toolchain quirks that cost a session to work out.** The lesson generalises
past the machine it was learned on: when a suite will not run, the cause has
twice been the *toolchain path*, not the code. Check that before concluding
anything is broken.

*macOS, the current machine (2026-08-06).* `node`/`npm` come from **nvm**,
which `~/.zshrc` loads for interactive shells only — so a non-interactive
shell (Claude Code's Bash tool, a hook, a cron) reports `command not found`
while the user's own terminal is fine.

Derive the path instead of hardcoding a version:

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
nvm use --lts     # if nvm is loaded (interactive shells only)
```

**SET `git config user.email` BEFORE COMMITTING ON A NEW MACHINE. Vercel
blocks deployments from commits it cannot attribute (2026-08-06).** This cost
an entire afternoon and every symptom pointed somewhere else.

A fresh macOS install has no `user.email`, so git silently invents one from
the hostname — here `edwardthng@Edwards-MacBook-Pro.local`. Commits succeed
and push fine. GitHub accepts them. But the Vercel GitHub integration
**refuses to build a commit whose author email is not a valid GitHub
account**:

> The deployment was blocked because the commit author email
> (edwardthng@Edwards-MacBook-Pro.local) is not valid. Ensure your git email
> matches your GitHub account.

Fourteen deployments accumulated over one afternoon, none of them ever built.

**The reason it is so expensive to diagnose is that the CLI never says this.**
The message above appears only in the Vercel dashboard. From the terminal:

- `vercel ls` → `UNKNOWN` status, `?` duration, for every deployment
- `vercel inspect --logs` → one line, `status UNKNOWN`, no log at all
- `vercel promote` → `not ready and cannot be promoted (422)` — the closest
  thing to a real signal, and it reads like a build still in progress

**A blocked deployment is indistinguishable from a slow one over the CLI.**
The tell is that a *hours-old* deployment still reports "not ready": a queue
drains, a blocked deployment never does. Check the dashboard the moment two
deployments of different ages both say it.

Check before committing on any new machine:

```bash
git var GIT_AUTHOR_IDENT     # must show a real GitHub-registered address
```

*Two things were wrongly blamed first, so they are recorded here as ruled
out:* a `.nvmrc` pinning Node 26 against a project set to 24.x (plausible, and
Vercel does read `.nvmrc` — but it was not this), and a build-queue backlog
from many pushes. Neither was the cause. `.nvmrc` was deleted anyway and the
commands above derive the node path instead, which is the better arrangement
regardless.

Also absent: `timeout` (GNU coreutils, not a macOS builtin), and `python3` is
3.14 where the old venv was 3.11 — every dependency is `>=`-pinned, so 3.14
resolves clean and the whole suite passes on it.

*Windows, the previous machine.* On the OneDrive-synced copy, `node`/`npm`
were installed but invisible to both the Bash tool and PowerShell's
`Get-Command` — reached through `cmd /c "npm test"`. And `.venv` had been
created under a different Windows user profile, so `.venv/Scripts/python.exe`
resolved to a path that did not exist (`C:\Users\thnge\...`).

**A venv and a `node_modules` do not survive a machine move, and they fail
differently (2026-08-06).** Both are gitignored, so a repo copied between
machines carries neither correctly — but only one of them says so.

- The **venv** is a directory of absolute paths to an interpreter that is not
  there. Obvious the moment anything runs.
- **`node_modules` is the quiet one.** npm installs *platform-specific* native
  binaries, so a tree installed on Windows holds `@esbuild/win32-x64` and
  `@rollup/rollup-win32-*` and nothing that can run on a Mac. It looks
  complete, `npm test` looks like it should work, and the failure reads as a
  broken build rather than a wrong architecture. Confirm with
  `ls frontend/node_modules/@esbuild` — the answer should name the host you
  are on. The fix is `rm -rf` and reinstall, not a repair.

Recreating both after a move:

```bash
rm -rf .venv && python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt

rm -rf node_modules frontend/node_modules
npm install && (cd frontend && npm install)
```

The backend serves the frontend only if `frontend/dist` exists — that is why
local dev without a build still works, and why the Dockerfile builds it in a
node stage.
