# What running it actually broke, and what fixed it

Everything below was found by loading the extension in Chrome and clicking
things. None of it was findable from the test suites, and that is the point
worth internalising: the test suites cover logic the extension owns, and every
single failure so far has been at a **boundary the tests stub out** — Chrome's
permission model, Chrome's side-panel lifecycle, DNS, and the CORS envelope
around an unhandled exception. Budget for browser time accordingly; do not read
a green suite as readiness.

| Symptom the doctor sees | Real cause | Fix |
|---|---|---|
| Extension absent from `chrome://extensions` | Nothing wrong with the code — manifest was valid, all 8 referenced files present, OneDrive files were real and not cloud placeholders, Chrome 150 was past the 114 floor. It was the load step | Developer mode → Load unpacked → select `extension/` |
| "BreezeFill has no access to this tab", on a page plainly in view | `setPanelBehavior({openPanelOnActionClick: true})` opens the panel but grants **no `activeTab`** — Chrome handles the click itself, so `action.onClicked` never fires, and a click that never reaches the extension is not an invocation | Take `action.onClicked` and call `sidePanel.open({tabId})` from inside it. That *is* the canonical `activeTab` trigger |
| `Error: No SW` in the worker console, every start | `chrome.sidePanel.setPanelBehavior()` throws from the worker's top level **and** from `onInstalled`. Moving it to another lifecycle event was tried and failed | Delete the call. `false` is already the default, so it could never have helped a clean install — it was pure liability |
| "Could not reach the backend" | `formfill-backend.fly.dev` returns NXDOMAIN — destroyed or renamed, not stopped. Confirmed against `example.com` returning 200 from the same shell | `DEFAULT_API_BASE` → `http://localhost:8000` until a deploy exists |
| "Failed to fetch" with no status code, on Map fields | A missing `ANTHROPIC_API_KEY` makes the SDK raise a plain **`TypeError`** ("Could not resolve authentication method"), not an `anthropic.APIError`, so it escaped both `except` clauses. Starlette's `ServerErrorMiddleware` sits **outside** `CORSMiddleware`, so the resulting 500 carried zero `Access-Control-*` headers and the browser could not even report the status | Broad `except Exception` in `_review_rows` → 503 when the key is absent, 502 otherwise. Log the exception **type only**; a message or traceback can quote clinical text |
| Values silently cleared from fields the doctor had typed into | `applyOne` treated an absent value as an empty one and wrote `""` over it — then reported it filled | Absent-vs-empty guard at the top of `applyOne`, plus three tests |
| Fill refused on a 39-field page | Read at the time as the schema-mismatch refusal working. **It was not.** See the row below — the page had no usable labels at all, so no schema could ever have matched it | `MIN_MATCHED = 3` alongside `MIN_MATCH_RATE` is still right and still needed — but it was not what refused here |
| **36 of RoboForm's 39 controls had an empty label**, and an empty label scores 0, so nothing could match on that page whatever the schema said | The dumper's last-resort rule read `el.previousElementSibling`, which is **nothing at all** on a grid layout: the question sits in one `<div>` and the control in the next one over. Print-derived insurer forms use this as freely as they use tables. Not visible from any test — the fixture used `<label for>` and tables throughout | Rule 6 in `rawLabelFor`: walk up two hops and read the *container's* previous sibling. Bounded hard — stops at the form or fieldset, never reads headings or paragraphs, never reads a node containing a control. All 39 now resolve |
| The 3 controls that *did* have labels had junk ones — a `<select>`'s "label" was the option list of the `<select>` beside it | Same rule 5, no check that the neighbour was a control. Worse than junk: option text bypasses `buildOptions`'s withholding rule, which exists precisely because option lists enumerate patients | `NEVER_A_LABEL` — controls, headings, prose, and anything over 200 chars |

## The demo failure (2026-08-03) — two symptoms, one cause

Reported as *"failed to fetch, and no specific form listed in the dropdown"*.
Both come from the same thing: **no backend was running.** Confirmed after the
fact — `curl http://localhost:8000/health` returned nothing at all.

The chain is worth writing down because the two symptoms look unrelated and
the useful message is destroyed before it can be read:

1. On open, `loadForms()` fetches `/forms`, throws, and its `catch` does two
   things: writes *"Could not reach the backend. Check the URL under
   Advanced."* into `#map-status`, and calls `showPicker("No forms loaded.")`,
   which reveals an **empty `<select>`**. That is the missing dropdown entry —
   not a form-detection bug.
2. `detectForm()` then returns immediately on `if (!state.forms.length)`, so no
   host matching is even attempted.
3. Clicking **Map fields** calls `setStatus(status, "Redacting and mapping…")`
   on that *same element*, **overwriting the one actionable message on screen**,
   and then fails with the browser's raw `TypeError: Failed to fetch`.

So the panel knew the right answer at load and then threw it away on the first
click. Two consequences to fix rather than document around:

- `onMap` should not clobber a standing connectivity error, and a bare
  "Failed to fetch" should be translated the way the HTTP statuses already are
  — a doctor cannot act on it, and neither could the owner mid-demo.
- With an empty `<select>`, `$("form-id").value` is `""`, so even a backend
  that came back mid-session would 404 until the panel is reopened.

**The lesson, and it is not a UI one:** the product currently cannot be shown
to anyone without a terminal running `uvicorn`. Redeploying is still next steps
item 1.

Both UI consequences above are now fixed and pinned by `panel.test.js`, which
did not exist before: a network `TypeError` maps to a fixed sentence, `onMap`
retries `loadForms` rather than posting a `""` form id, Map refuses when no
form is selected, and a failed parse reports itself in the details drawer so
two messages never compete for one status line. A third was found while
testing: an empty form list was reported as "could not reach the backend",
which sends someone to check the URL of a server that answered.

## The RoboForm route (2026-08-03) — a demo that needs no API key

`roboform_test_v1` is a `fill_mode: "web"` schema against RoboForm's public
39-field test page. Every field is `demographics.*`, so `map_fields` returns
early without an LLM call, and with `FORMFILL_DISABLE_SWEEP=1` the whole path
— paste, parse, map, review, fill — runs with **no `ANTHROPIC_API_KEY`**.
That matters beyond convenience: the key was the thing blocking a demo.

**Run in Chrome on 2026-08-03 and the fields filled.** Paste → parse → map →
review → fill, end to end, no API key. Everything before this date that said
"nothing has been successfully filled anywhere" is now out of date.

Dry-run against the real page markup in jsdom: 5 of 6 matched, rate 0.83,
`safeToFill` true, five values in the right controls. The sixth is deliberate
— three `<select>`s share the label "Date Of Birth", so the matcher calls it
ambiguous and fills none of them. A test schema that only demonstrated success
would not be worth having.

It is `internal: true`, so it needs `FORMFILL_SHOW_INTERNAL=1` to appear in the
picker. It is also the first schema to declare `hosts`, so it is the first
thing that exercises host auto-detection at all.
