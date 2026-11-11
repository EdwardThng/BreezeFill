# Next steps

Ordered by what unblocks the most. Items 1 and 2 are the only ones that are
not waiting on something.

**1. Get a learn-mode dump from a live ClaimEZ page — one per step.**
Everything about the real target is currently a verbal description. A dump
gives the field labels, the dropdown option text, the `<legend>` that names
each step, and whether the controls are native or custom widgets. It is
read-only, does not consume the `?pid=` token, and unblocks items 3, 4 and 5
at once. Paste `extension/learn/dump.js` into the console on the form page,
run `breezefillLearn.dump()` per step, then `mergeDumps([...])`. Read it before
sharing it — see `extension/README.md` for the residual risks.

**Four open questions now wait on this one dump**, and it is worth listing them
together because each has been deferred rather than guessed:

1. Should a step hidden behind `display:none` be filled? (`isFillable`)
2. Should `enrich` refuse a taken control the way `locate` does?
3. How do you tell a grid-layout question row from a repeating-entry opener?
   Today you cannot, and on a wholly grid-laid-out form that refuses every
   demographic control — see the trap.
4. What wordings do the real labels use? The demographic alias table is
   narrower than ordinary phrasing (`Contact No.` yes, `Contact Number` no)
   and widening it on a guess is how the wrong label starts resolving.

Three of the four were found by building things against a verbal description
and finding the description did not decide them. That is the argument for
getting the dump before writing more mechanism, not after.

**2. ~~Finish the Vercel migration~~ — done 2026-08-05.** Production is live and
public, the key is set for both environments, `DEFAULT_API_BASE` points at it,
and Fly is destroyed. One residual: **previews sit behind Deployment
Protection**, so the extension cannot be pointed at a preview URL (its `fetch`
401s and reads as "Could not reach the backend"). Production is public, so
testing against production works — turn protection off only if you want preview
builds testable too.

**2b. ~~Get the extension onto the Chrome Web Store~~ — DONE, and it is public.**
The listing went live on 2026-08-17 at version `0.2.1`. **Unlisted** is what this
file recommended and is no longer what happened; the reasoning below is kept as
the record of the decision, not as an instruction.

The argument for the store still holds and is worth keeping, because the stopgap
now on the site contradicts it: "download a zip, enable Developer Mode" is not
something a GP will do, and Chrome blocks self-hosted `.crx` outside enterprise
policy, so the store is the only real route. `#/get` step 2 points at
`/download` anyway right now, because the published version does not run — a
worse install that works beats a better one that does not. **It is temporary.
Revert it when 0.3.0 is approved.**

**The work now is the 0.3.0 upload**, which is an update to a live listing rather
than a first submission. See the version table at the top of Status.

**The owner's call, 2026-08-08: submit now and keep refining while the review
runs.** Review takes weeks, so the queue time is free if the work continues in
parallel — and an unlisted item can be updated after approval. What this
decision accepts, explicitly, is that **the extension has still never filled a
real insurer form** (next steps item 1), so the first version in the store is
one whose core path is proven only against RoboForm and synthetic fixtures.

**Status 2026-08-12 — every asset exists; the listing form is the work.**
The full state is in the store-submission table under Status, and every string
to paste is in **`docs/release/chrome-web-store-submission.md`** — that file is the
one to open, not this one.

Cleared since this was written: the four screenshots, the 440×280 promo tile,
the permission justifications and single-purpose statement, the remote-code
answer, and the package itself at `0.2.1`.

What is left:

1. **Finish the listing form and submit.** Long description, category,
   language, the four screenshots (lead with `3.45.53`), icon, promo tile, the
   Privacy tab. Distribution is **public** as of 2026-08-17 — this line said
   Unlisted, and that is not what shipped. Name and short description come from
   the manifest and cannot be edited there.
2. **If the upload fails again, get the exact error text.** The package has
   been verified clean offline every way available — root manifest, no BOM,
   valid JSON, every internal reference resolving, icons at their declared
   sizes, 78 KB against a 20 MB limit — so the next signal has to come from
   the dashboard rather than from another local check.

Four screenshot traps, all met on the first attempt (2026-08-11), all still
true for a retake:

   - **Crop, or the argument is unreadable.** A whole-window capture puts the
     panel's copy at ~9px. `scripts/store_screenshots.py --crop right:62` was
     the balance; a step whose content sits lower in the panel wants an
     explicit `x,y,w,h` box instead, because the fractional form anchors at the
     top.
   - **`Cmd+Shift+B` first.** The bookmarks bar puts personal browsing into a
     public listing and survives the crop.
   - **Turn off the floating thumbnail.** Three of four retakes were lost to
     it — see Known gotchas.
   - **Reload the extension before shooting.** The first set photographed a
     stale build and showed problems that were already fixed.

The **data-safety disclosures** must agree with `privacy.html` line for line;
the store asks the same questions and a mismatch is a rejection, not a query.
Tick PII, Health information **and Website content** — the third is the one
that gets missed, and `/map-live` genuinely sends the page's question labels.

Icons are done. Expect weeks rather than days: health data plus a permissions
story means manual review, and a rejection restarts the clock.

One thing that no longer blocks it: **the Vercel plan is Pro since
2026-08-06**, so commercial use is permitted and the pricing page is unblocked.
And note that the "synthetic notes only" rule that used to be listed here was
**overridden by the owner on 2026-08-06** — real consultation notes are in
scope, and the privacy policy discloses the out-of-region transfer rather than
forbidding the data. See the guardrail; do not reinstate the old rule here.

Owner's terminal for anything holding the key — a key pasted into a transcript
is a key to rotate.

**2c. Build the paid tier, in this order.** The design is settled — see
"Pricing, and the gate that does not exist yet". Nothing here blocks the store
submission, and the submission should not wait for it.

1. **Stripe payment link + price** (owner). Setting `VITE_STRIPE_PAYMENT_LINK`
   at build time is all the site needs to turn the pricing card's placeholder
   into a working Subscribe button.
2. **A post-payment page** that hands over the licence key and the store link.
3. **Licence verification in the backend**, by asking Stripe whether the
   subscription is active — no subscriber table of this repo's own.
4. **A licence field in the panel.** This is the part that costs a second
   store review, so it is last.

Two things to settle before the first real charge, both the owner's: the
**legal entity** on the Stripe account (moving from sole trader to a company
later means a new account and re-onboarding every card), and whether the free
pilot installs are grandfathered — Chrome's terms say they must be.

**2d. Gate the deploy on CI.** `.github/workflows/tests.yml` runs the three
suites on every push but only reports; `main` is production and Vercel deploys
it regardless, so a red suite still ships. The shape that fits this repo's
"commit after every file change" habit is to **turn off Vercel's automatic Git
deploys and deploy from the workflow after the tests pass** — pushing stays
exactly as it is, production simply updates a few seconds later and only when
green. Needs a Vercel token in GitHub secrets, which is the only secret in the
whole setup. Add a post-deploy smoke check on `/health`, `/forms` and the
download route while the store review is running.

**3. ~~Wizard support~~ — built 2026-08-04, first exercised 2026-08-06.**
`tests/fixtures/wizard_like.html` and `wizard_test_v1` (`internal: true`) turn
it on: `<legend>`-named steps, three question types each, a URL that never
changes, and a repeating question with an "add another" button. Against the
two-step version of that fixture, whole-plan `locate` scored 3/6 and refused
while `locateSteps` scored 3/3 and filled — the exact failure the per-step
guard was written for.

**Reworked 2026-08-15 into three steps, and it is now also the form the
website's demo video is shot against.** What that added, each of which was
uncovered by any fixture before: a demographic step (since 2026-08-09
`_live_sources` answers those controls from the record and removes their
questions from the mapping call), the repo's only native `<input type="date">`,
a checkbox group carrying an explicit "None of the above", two grid-layout
labels, and a pre-filled control for the never-overwrite guard. The third step
asks about a hospital admission the panel's sample note cannot answer, on
purpose — a demo where every box fills teaches the opposite of the product's
bet, so the blanks are part of the shot.

**The pre-filled control moved on 2026-08-17, and where it sits is the point.**
It was `Insurer`, hardcoded to "AIA Singapore", and that made the insurer
*inference* unobservable on the one page in the repo that could show it:
never-overwrite is absolute, so the panel's value would have been declined
whatever it worked out. Insurer is now empty and fills from the form, and the
guard moved to **MC days in step 2, pre-filled with 7 against the note's 14** —
deliberately disagreeing, because a pre-fill that matches what the note produces
cannot demonstrate a refusal at all. If that box reads 14 after a fill, the guard
is broken. A clinical value is also the stronger test: BreezeFill has a competing
answer for it and must still decline. `wizard_test.json` now declares
`insurer: "AIA"` — the canonical name `_normalised` writes — where it previously
said "Test" while the page said "AIA Singapore", so the fixture and its schema
were modelling two different insurers.

**The step-1 labels are exact and must not be reworded casually.**
`demographic_field_for_label` normalises to letters and strips only *patient*
qualifiers, so `Contact No.` resolves and `Contact Number` does not; likewise
`NRIC / FIN` against `NRIC / FIN Number`, and `Patient's Full Name` against
`Patient's Full Name (as in NRIC)`. The near-misses are documented at the top
of the fixture and deliberately kept out of the form — a box that silently
declines to fill is the wrong thing to put in front of a camera. It is also a
standing signal that **the alias table is narrower than the wordings real forms
use**; the ClaimEZ dump is what would say by how much.

The fixture also has a **mount/unmount toggle**, because the open question
(should a step hidden behind `display:none` be filled?) is still open —
`isFillable` checks `disabled` and `readOnly` but not visibility, and the
dumper does report `visible` correctly, so the information exists and only the
decision is missing. Answering it needs the real page, not the fixture.

**4. The AIA schema itself — now the thing that switches item 3 on.** Blocked
on the same dump. Write `step` on every field (from the `<legend>` the dumper
records) and `options` on every dropdown and yes/no group; both are inert
elsewhere and load-bearing here. An expired link renders
an error page with no fields, `submit-offline` is post-submission only, and the
portal is a JS-rendered SPA so no fetch-based tool can see its DOM.
`roboform_test_v1` and `wizard_test_v1` are the only schemas declaring
`hosts` (`roboform.com`, `localhost`), and both are `internal: true`, so on any
real insurer page the picker is the expected outcome rather than a bug.

**5. Prove a write lands in a *framework-rendered* field.** RoboForm is plain
HTML, so filling it says nothing about React's `_valueTracker` — the failure
that looks correct: right value on screen, stale value submitted.
`tests/fixtures/portal_like.html` is static too. Either add a small React page
with a controlled input, or get onto a real portal.

**6. Exercise the schema-free fallback in a browser.** Tested but never run
against a real unknown page — RoboForm is in the bank now, so it proves the
wrong branch. Any public form with labelled fields that no schema describes
will do. Watch two things tests cannot see: how many of a real page's controls
come back unlabelled, and whether `MAX_LIVE_FIELDS = 50` is anywhere near
right.

**7. Proof mode.** Outline each filled control and stamp its field id — the
port of `calibrate_overlay.py --proof`. Same reasoning as the overlay forms:
adjacent controls are usually different questions, and a misplaced value is
obvious in a render and invisible in a report.

**8. SG-region inference.** Both calls run `claude-opus-5` on the first-party
API, which is not SG-region, and workspace geo — where data sits at rest — is
US-only and fixed at workspace creation. Needs Bedrock `ap-southeast-1`, where
the region comes from the endpoint rather than a parameter.

This item used to read "before any real patient note", and **that is no longer
the rule** — the owner put real notes in scope on 2026-08-06 and the privacy
policy discloses the out-of-region transfer instead of forbidding the data. See
the guardrail. What is still true is that the disclosure names a PDPA
comparable-protection agreement that **is not in place**, so this remains the
item that would let that paragraph be rewritten rather than merely honest. Repo
fixtures stay synthetic regardless.

**9. Smaller, worth doing once the pilot has pasted real CMS exports.** The
label synonyms in `demographics.py` are a guess at what ClinicAssist emits.

~~The parser cannot find an insurer implied only by a policy prefix~~ — **done
2026-08-11, and the owner's call was to take it from the form rather than from
the note.** `assemble_claim` falls back to the schema's own `insurer` when the
record carries none. The reasoning is worth keeping, because it is the one
demographic where the form knows better than the paste: a note names its
insurer in passing if at all (`(AIA Singapore)` after the policy number) while
the schema states it outright, and the insurer that belongs on a claim form is
the one whose form it is. A note naming a different insurer than the form being
filled is answering a question nobody asked.

Two properties to preserve. It **only ever fills a blank** — a doctor who typed
an insurer has decided, and this is a fallback rather than a correction. And a
**live schema carries no `insurer`**, so on the schema-free path the box stays
blank and the doctor types one line.

**The extension never reached that fallback at all, and does now (2026-08-17).**
The paragraph above only ever described `POST /map` and the PDF path. The panel
calls `/map-redacted`, whose schema is built by `_live_schema` — which carries no
`insurer` — so `assemble_claim`'s fallback was unreachable from the extension and
the box came back blank on **every** claim, schema matched or not.

`inferInsurer` in `panel.js` closes it, and the shape matters: this was recorded
here as needing "the panel sending the best-fitting schema's insurer alongside
the page's controls, which is a change to the request shape". **It is not.**
`GET /forms` already returns each schema's `insurer`, the panel already holds the
matched schema in `state.schema`, and demographics are already filled in the
panel rather than on the server (`assemble_redacted` returns `fill_from` and no
value). Nothing new goes on the wire.

It writes into **the panel's own insurer box on detection**, not into the review
row, and that is the load-bearing choice rather than a UI nicety: a demographic
reaches the doctor already green — it skips both the model and the review confirm
— so an inferred value has to be visible and editable in the details drawer
*before* Map runs, instead of appearing for the first time as an answer nobody
was asked about. Two further refusals: it never marks the field `touched`, so a
note that names an insurer still wins; and it stands aside when `choices` is
asking the doctor which of two insurers the note meant.

The rejected alternative, so it is not re-opened: scanning the note for known
insurer names. It puts world knowledge into a module that is otherwise pure
shape, the list goes stale as insurers rename and merge, and a demographic
reaches the doctor **already green** — so a false positive is a wrong value
that bypasses both the model and the review confirm.

**10. Deferred.** Sweeping the `FORMFILL_*` environment variables to
`BREEZEFILL_*`; the naming note at the top of this file explains why it has not
happened. Coordinate-overlay fill for the three scanned forms.

## Answered, so nobody re-opens them

- **Does an action click that opens the side panel grant `activeTab`?** No.
  `setPanelBehavior({openPanelOnActionClick: true})` makes Chrome handle the
  click, so `action.onClicked` never fires. Fixed by taking `action.onClicked`
  and calling `sidePanel.open({tabId})` inside it. Do not simplify it back.
- **Does the portal's CSP block the extension?** No. A content script runs in
  an isolated world and is not governed by the page's CSP. A site cannot refuse
  the extension that way.
- **Does the wizard need `optional_host_permissions`?** No — the URL does not
  change between steps, so `activeTab` survives all four.
- **Is the extension loadable and does it fill?** Yes, Chrome 150, 2026-08-03,
  RoboForm's test page. Five fields filled, Date Of Birth correctly refused as
  ambiguous.

## Still unknown, and each fails in a way tests cannot see

- Whether an isolated-world write defeats React's `_valueTracker`.
- Whether the form is inside an **iframe** — injection is not `allFrames`, so
  it would read as a page with no controls.
- Whether controls sit in a **shadow root** — `querySelectorAll` does not
  pierce one; a *closed* root cannot be reached at all.
- Whether the controls are **real controls**. A `<div role="combobox">` or a
  rich date picker is invisible to the query, and ones that do render an
  `<input>` often ignore a written value — they want a click on an option.
  This is the likeliest shape of "the portal looks filled but submits nothing".

The first is answered by item 5; the other three by one dump.
