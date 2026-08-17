# Chrome Web Store submission — everything needed, in one place

Paste-ready copy for the Developer Dashboard, plus the exact files to upload.
Written 2026-08-11 against extension version `0.2.1`; **updated 2026-08-17 for
`0.3.0`, which is an update to a listing that is already public and live.**

**Why this upload is urgent rather than routine.** The published item is `0.2.1`
and production's `/health` publishes `min_extension_version: "0.3.0"`, so the
panel refuses to send on every install from the store — *"This version of
BreezeFill is out of date and will not send anything."* The listing is live and
currently non-functional for anyone who installs it. Publishing `0.3.0` is what
clears that; the alternative (lowering the floor) was considered and rejected,
because `0.2.1` is the build that sends the patient's identifiers to the server
and the floor was raised to disown it.

**Two things in this file are stale and are not corrected below**, because they
describe decisions rather than steps: it says to set Distribution to *Unlisted*,
and the item is now **public**; and it describes a first submission, whereas this
is an update to a live listing. A new package restarts the review clock, and
until the review clears, `0.2.1` is what users get.

Everything below is drawn from what the extension actually does. Where a claim
here and the code ever disagree, the code wins and this file is wrong — the
listing has to survive a reviewer installing it and trying it.

---

## 0. What the `.zip` is

`breezefill-store-v0.3.0.zip` in the repo root **is the extension itself** —
the thing the store hosts and installs. It is not a screenshot bundle and not a
backup. On the dashboard it goes in *"Upload new package"*, and everything else
in this document is metadata wrapped around it.

It is **gitignored on purpose**, so it is build output rather than a tracked
file, and it must be **rebuilt rather than reused** whenever anything under
`extension/` changes:

```bash
cd extension && rm -f ../breezefill-store-v0.3.0.zip \
  && zip -rX ../breezefill-store-v0.3.0.zip . -x "*.test.js" ".*" "__MACOSX*" "README.md"
```

Build it from **inside** `extension/`. Zipping the folder from outside nests
everything under a `extension/` directory and the store rejects the package for
having no `manifest.json` at the root.

Everything the command excludes is deliberate. `*.test.js` keeps the four test
files out of a package Chrome unpacks on every install. `README.md` is internal
engineering documentation with no runtime purpose, and a `.crx` is a zip that
anyone who installs can read — nothing in it is secret, but the smallest
package is the easiest to review. `-X` drops macOS resource forks.

The result is **22 files, ~121 KB**, `manifest.json` at the root. It grew from
0.2.1's 13 files / 78 KB when redaction moved into the browser — `privacy/`
ships now, and the panel grew with it.

Check it carries the build you think it does before uploading:

```bash
unzip -l breezefill-store-v0.3.0.zip          # 22 files, manifest.json at root
unzip -p breezefill-store-v0.3.0.zip manifest.json | grep version
```

**A version number is consumed by an upload even if the review rejects it —
and even if the item never leaves draft.** That is not a rule of thumb here:
`0.2.0` was built and its upload failed repeatedly, with the package itself
verified clean every time, so the version being already taken is the leading
explanation. `0.2.1` was cut on 2026-08-11 for exactly that reason.

So each upload attempt needs its own number. Bump **both** places together —
`"version"` in `extension/manifest.json` *and* the zip filename — then rebuild
and re-verify. The filename is cosmetic to the store but it is what stops you
uploading last attempt's package by mistake.

---

## 1. Files to upload

| Dashboard field | File | State |
|---|---|---|
| Package | `breezefill-store-v0.3.0.zip` (repo root) | **Built 2026-08-17: 22 files, 121 KB.** Verified: `manifest.json` at root at `0.3.0`, no BOM on either JSON, every manifest- and runtime-referenced file present, all four icons matching their declared sizes, `panel.html`'s own references resolving, no test files, no README, no external URLs |
| Store icon, 128×128 | `assets/logo/chrome-store-listing-128.png` | Ready. Upload it even though the manifest declares a 128 icon too — the manifest's is what Chrome draws in the browser, this is what the store page shows. Same file, two surfaces |
| Small promo tile, 440×280 | `assets/logo/chrome-store-promo-440x280.png` | Ready. **Required** — the listing cannot be submitted without it |
| Screenshots, 1280×800 | `~/Documents/breezefill-store/store-1280x800-*.png` | Four, ready |
| Marquee promo tile, 1400×560 | — | Optional. Skip |
| YouTube video | — | Optional. Skip |

**Screenshot order matters — put `3.45.53` first.** It shows the panel having
read the note, found four of seven details, and *asking* about the two it
refused to guess. That single frame is the product's argument: it read the
note, declined to guess, and handed the decision to the clinician. The others
follow in step order (`3.45.30`, `3.45.38`, `3.46.57`).

---

## 2. Store listing tab

### Two fields are already filled, and you cannot edit them here

The name and the short description come from `manifest.json`, not from this
tab. Chrome's own guidance is blunt about it: *"After uploading your item, you
won't be able to edit the metadata of your manifest in the developer
dashboard."* Expect both to appear pre-filled and greyed out — that is the
manifest doing its job, not a duplicate to resolve.

| Field | Comes from | Current value |
|---|---|---|
| Item name | `manifest.name` | `BreezeFill` |
| Short description | `manifest.description` | `Fills insurer claim forms from a clinical note. Fills in place; never submits.` — 78 chars, limit 132 |

Both are accurate as they stand, so leave them. Changing either means editing
`extension/manifest.json`, bumping the version, rebuilding the zip and
uploading again — the short description is not worth that, and the name
certainly is not.

### What you do fill in here

**Category:** Workflow & Planning
**Language:** English

**Description** — the long one, and the only text field on this tab that is
actually yours to write

```
BreezeFill helps a clinician fill in an insurer's medical claim form without retyping the consultation.

Open the claim form, click the BreezeFill icon, and paste the consultation note into the side panel. BreezeFill reads the questions on the form in front of you, maps the note onto those questions, and shows you every proposed answer before anything is written. You confirm or correct each one. Then it writes the confirmed answers into the insurer's own form.

It never submits the form. You review what it wrote, sign it, and submit it yourself.

HOW IT WORKS

1. Name the patient. BreezeFill never guesses a name — a name has no shape a pattern can find, so you type it.
2. Paste the consultation exactly as it sits in your clinical system. Messy is fine.
3. BreezeFill pulls the patient's details out of the paste by pattern matching, never by an AI model.
4. Check what it found, and correct anything wrong.
5. Review every proposed answer, with the part of your note that supports it.
6. Fill. The values are written into the form on your screen.

WHAT IT REFUSES TO DO

These are deliberate, and they are the point of the product:

- It never submits a form, and never clicks a button on the page.
- It never overwrites an answer already in a field.
- When your note gives two possible values for one field — two phone numbers, two policy numbers — it fills neither and asks you which one is the patient's.
- When it cannot tell which question on the form a piece of information belongs to, it leaves that question blank rather than guessing.
- A wrong answer on a claim form is worse than a blank one, because you sign it. BreezeFill is built around that.

PRIVACY

- The patient's name, ID number, date of birth, phone, address and policy number are removed from the consultation note before any of it is sent for processing. Those details are found by pattern matching in the extension's backend, never by an AI model, and they are used as the dictionary the note is scrubbed against.
- The de-identified clinical text is then processed by an AI model to map it onto the form's questions.
- Nothing is stored. The service keeps no record of a claim after the request that carried it.
- The extension requests no access to any website until you click its icon on the tab you want filled, and it asks for no storage permission — nothing is written to disk.

Full privacy policy: https://breezefill.com/privacy

BreezeFill assists with completing a form. The reviewing clinician remains responsible for the accuracy of everything submitted.
```

---

## 3. Privacy tab

### Single purpose

```
BreezeFill has one purpose: to help a clinician complete an insurer's medical claim form that is open in their browser.

It reads the questions on the form in the tab the user has granted it access to, maps a consultation note the user has pasted onto those questions, shows every proposed answer to the user for confirmation or correction, and writes the confirmed answers into that same form. It does not submit the form.
```

### Permission justifications

**`activeTab`**

```
BreezeFill declares no host permissions and no content scripts, so it has no standing access to any website. activeTab is how the user grants access to one page at a time: clicking the BreezeFill toolbar icon on the tab holding their claim form is the permission grant, and it is the only way the extension can reach a page at all.

That access is needed twice in one session, both on the tab the user just clicked: to read the questions on the claim form so they can be answered, and to write the answers the user has confirmed back into the fields of that same form.

Access does not persist. The user re-grants it by clicking the icon again.
```

**`scripting`**

```
scripting is how BreezeFill reads and fills the form on the page the user granted access to with activeTab. It injects the extension's own filler script into that one tab, at the moment the user asks for it, and never anywhere else.

The script does two things: it collects the form's question labels and field types so the questions can be mapped, and it writes the values the user confirmed into the matching fields. It never clicks a button and never submits the form.

No remote code is involved. Every script injected ships inside this package.
```

**`sidePanel`**

```
The side panel is the extension's entire user interface. It has to sit beside the insurer's claim form rather than over it, because the user pastes the consultation note and then reviews every proposed answer against the form they are looking at.

A popup cannot do this: it closes as soon as the user clicks the page, and the review step requires reading and confirming each proposed value one at a time while the form stays visible.

The panel also holds the claim in memory only. There is no storage permission, so nothing the user pastes is written to disk.
```

### Remote code

Select **"No, I am not using remote code."**

Selecting No often means no justification box appears at all. If one does — or
if a reviewer queries it, which is plausible for an extension that plainly
talks to a server — this is the answer:

```
BreezeFill does not use remote code. Every script it executes is included in this package: the side panel UI, the service worker, and the four scripts injected into the page (learn/dump.js, fill/locate.js, fill/apply.js, content/fill.js). None of them is fetched from a server, and the extension contains no eval() and no new Function().

The extension does make HTTPS requests to its backend at api.breezefill.com. Those requests exchange data, not code: it sends the de-identified consultation text and the form's question labels, and receives back proposed answers as JSON. Nothing in a response is executed, and no response can alter the extension's behaviour beyond the values shown to the user for confirmation.
```

Why that distinction matters, if it comes up: Chrome's remote code policy is
about *executing* code fetched at runtime. Calling an API for data is not
remote code, and the second paragraph exists to say so before anyone has to
ask.

### Data disclosures

Tick these three, and the third is the one that gets missed:

| Type | Tick | Why |
|---|---|---|
| Personally identifiable information | **Yes** | Name, address, phone, ID number and date of birth are read from the pasted note |
| Health information | **Yes** | The consultation note is clinical text |
| **Website content** | **Yes** | The question labels on the claim form are sent so the answers can be matched to the right fields |

Leave unticked: authentication information, personal communications, financial
and payment information, location, web history, user activity.

**Certifications.** The two straightforward ones are true: the data is not used
or transferred to determine creditworthiness or for lending, and it is not used
for any purpose unrelated to the single purpose above.

**Read the third one carefully before ticking it** — "I do not sell or transfer
user data to third parties, apart from the approved use cases." De-identified
clinical text *is* sent to an AI provider to be processed. That is normally the
approved "transferring for processing by a service provider" case, which is why
it is tickable, but it is a transfer and the privacy policy says so plainly. If
the wording on screen differs from what is described here, believe the screen.

**Privacy policy URL**

```
https://breezefill.com/privacy
```

The listing's disclosures and that page must agree line for line. The store
asks the same questions, and a mismatch is a rejection rather than a query.

---

## 4. Distribution tab

- **Visibility: Unlisted.** One-click install from a link, not publicly
  discoverable. The review is the same either way, and it still auto-updates
  every install — which is what stops a doctor running a stale build.
- **Pricing:** Free.
- **Regions:** Singapore at minimum; all regions is fine.
- **Not** a Chrome OS-only item; no in-app purchases.

---

## 5. Test instructions for the reviewer

No account, no login, no payment. Paste this into the *"How to test"* field:

```
No sign-in, no account, and no payment is needed. A synthetic sample note is built into the extension — please do not use real patient information.

1. Install the extension.
2. Open https://www.roboform.com/filling-test-all-fields
   This is a public test form with no login. It stands in for an insurer's claim form.
3. Click the BreezeFill icon in the toolbar WHILE THAT TAB IS OPEN. This click is what grants access to the page; the extension can do nothing before it.
4. Step 1, "Who is this claim for?" — type any name, for example "Tan Wei Ling", then "Continue".
5. Step 2, "Paste the clinical note" — click "Use a sample note" to load the built-in synthetic consultation, then "Find patient details".
6. Step 3, "Verify" — the patient details found by pattern matching are shown. Two fields (phone, policy number) will show two candidates each, because the sample note contains two of each and the extension refuses to guess between them. Click one of the offered buttons for each, then "Save and look at this page".
7. Step 4, "Check the answers" — click "Map these questions". Every proposed answer is then listed; confirm the ones you want.
8. Click "Fill". The values are written into the page.

The confirmed values are written into the RoboForm page. Nothing is submitted: the form is left filled for the user to check and submit themselves.

Note on network use: the extension sends the de-identified note and the page's question labels to https://api.breezefill.com for processing, and receives the proposed answers back. As of this version, patient identifiers are found and removed in the browser, before the request leaves the tab, and the key that maps them back never leaves it either; the server checks again on arrival as a backstop. Nothing is stored server-side.
```

---

## 6. Submit

Dashboard → the item → **Submit for Review**, with automatic publishing.

## 7. After submitting

- **Expect weeks, not days.** Health data plus a permissions story means manual
  review, and a rejection restarts the clock. Batch any further changes rather
  than uploading into the queue.
- **Production is part of the submission.** The reviewer's test hits
  `api.breezefill.com`, every push to `main` auto-deploys there, and a broken
  route during review reads to them as a broken extension.
- An unlisted item **can** be updated after approval, which is the whole reason
  for submitting before the product is otherwise finished.

## What this submission does not claim

Worth holding in mind if the reviewer asks: the extension has been exercised
end to end against RoboForm's public test form and against synthetic fixtures,
and it has **never filled a real insurer's form**. Nothing in the listing says
otherwise, and nothing in it should.
