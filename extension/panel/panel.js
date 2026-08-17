/**
 * BreezeFill side panel.
 *
 * Holds the whole claim in memory for as long as the doctor has the panel
 * open, and nowhere else. There is no `chrome.storage` call in this file and
 * the manifest requests no storage permission, so a clinical note cannot reach
 * disk even by mistake. Closing the panel is what discards the claim — the
 * extension equivalent of the server's in-memory claim store, except that
 * here there is no server copy to purge afterwards.
 *
 * ---------------------------------------------------------------------------
 * How this gets access to the insurer's page
 * ---------------------------------------------------------------------------
 *
 * It does not have any, until the doctor clicks the BreezeFill toolbar icon on
 * the tab they want filled. That click grants `activeTab` for that tab and
 * that visit, and nothing else: no host permission is held between sessions,
 * no URL is read, and the "tabs" permission — which would expose every tab's
 * address — is deliberately not requested. The panel never learns what site it
 * is looking at until the injected script tells it, and the injected script
 * only exists because the doctor put it there.
 *
 * The visible cost is that opening the panel on one tab and then switching to
 * another means clicking the icon again on the second tab. That is the grant
 * working as intended rather than a bug to route around, so the error message
 * says exactly that.
 */

// Overridable in the Advanced section, in memory only. A wrong value here
// costs a failed request, not a leak: the panel only ever posts to it.
//
// The deployed backend (Vercel production, region sin1). A doctor will not be
// running uvicorn, so this has to be a URL that answers on its own.
//
// Moved off Fly on 2026-08-05, and the reason is worth keeping: Fly was last
// deployed on 2026-08-03 and had become a *stale* backend rather than an idle
// one. A tester who installed the extension pointed at it got the 2026-08-03
// product — old enough to still carry the product's previous name in its UI,
// and without the options, steps, date-format and enrichment work that
// followed. Nothing about that failure named the real cause.
//
// The lesson for whoever moves this next: a default backend URL is a version
// pin. Pointing it at a deployment nobody redeploys means shipping that day's
// build forever, and the symptoms surface as unrelated bugs in the extension.
//
// So this points at a hostname WE own (2026-08-06), not at Vercel's. The
// previous default was `breezefill-livid.vercel.app`, where `livid` is a
// suffix Vercel generated for the project — it lives in Vercel's namespace,
// survives only as long as that project does, and changes if the project is
// ever renamed or recreated. Every install bakes this string in and no
// installed extension can be edited afterwards, so a default aimed at a host
// someone else names is a version pin with a second failure mode bolted on.
//
// `api.` rather than the apex on purpose: the site and the API are one Vercel
// project today, and this lets them be separated later — a different host, a
// different region, Bedrock for SG-region inference — without breaking a
// single extension already in a doctor's browser.
//
// The DNS must exist BEFORE a build carrying this is handed to anyone. There
// is no fallback to the old URL: the panel would report "could not reach the
// backend" and the doctor's only route out is Advanced → Backend URL.
//
// Point this at http://localhost:8000 under Advanced for the RoboForm test
// route: `roboform_test_v1` is `internal: true` and FORMFILL_SHOW_INTERNAL is
// deliberately unset in production, so the deployed backend does not offer it
// — a doctor must never be shown a form that is not a real insurer's.
const DEFAULT_API_BASE = "https://api.breezefill.com";

// Order matters: the orchestrator expects the other three to have registered
// themselves on globalThis by the time it runs.
const INJECT_FILES = [
  "learn/dump.js",
  "fill/locate.js",
  "fill/apply.js",
  "content/fill.js",
];

// The demographic inputs, and the PatientRecord key each one carries.
const DEMOGRAPHIC_FIELDS = {
  "full-name": "full_name",
  nric: "nric",
  dob: "dob",
  phone: "phone",
  "policy-number": "policy_number",
  insurer: "insurer",
  address: "address",
};

// Without these there is no claim: the first four are required by the form
// schemas, and full_name doubly so — it is the only identifier redaction
// cannot find by shape, so an absent name is a name left in the text.
// Insisted on, and each for its own reason rather than because a form happens
// to have a box for it.
//
// `full_name` because a name has no shape: `redaction.py` pass 1 can only
// remove it because the doctor typed it, and pass 2 finds identifiers by
// pattern. `dob` because there is no pattern rule for a bare date either, so a
// missing one stays in the text sent to the model.
//
// NRIC, phone and policy number are all shaped and are caught by pass 2 even
// when absent here, so they are wanted rather than required. `insurer` was on
// this list and should not have been: it plays NO part in redaction — pass 1
// never reads it — and exists only because some forms have a box for it.
// Blocking a doctor over an insurer their form does not ask about is asking
// for something the product does not need.
const REQUIRED_FIELDS = ["full-name", "dob"];

// A synthetic note for trying the panel without a real patient, and for
// demonstrating it. Every identifier in it is invented — repo fixtures are
// synthetic only, and this ships inside the extension.
//
// It is deliberately awkward rather than tidy, because a sample that parsed
// cleanly would demonstrate the wrong thing. It carries two phone numbers, so
// the sole-match rule in demographics.py has to refuse both rather than guess;
// a policy number written two ways, which resolves rather than refusing,
// because both renderings name one policy; and a first-consult date that is
// not the consultation date, which is exactly the distinction a schema
// description exists to draw.
const SAMPLE_NOTE = `Tan Wei Ling, F, 47
NRIC S8012345D  DOB 14/03/1978
HP 9123 4567 / 6123 4567
Policy GHS-88213004 or GH-88213004 (AIA Singapore)
Blk 118 Bishan St 12 #07-21, S570118

Seen 02/08/2026. 3 days sore throat, fever 38.4, odynophagia.
O/E tonsils enlarged with exudate, tender cervical nodes.
Dx acute tonsillitis. Rx oral amoxicillin 500mg TDS x 7 days.
First consult for this episode 31/07/2026. MC 2 days.`;

// Whether to animate a scroll. Read once: the panel is not open long enough
// for the setting to change under it, and asking per frame is wasteful.
const REDUCED_MOTION = globalThis.matchMedia
  ? globalThis.matchMedia("(prefers-reduced-motion: reduce)")
  : { matches: false };

const state = {
  forms: [],
  /** field_id of the row the note pane is currently marking. */
  reading: null,
  /** Whether the last /forms call failed, as opposed to returning nothing. */
  formsFailed: false,
  /** Review rows from POST /map. */
  rows: [],
  /**
   * Whether a fill has landed on this page. Presentation only — it moves the
   * header's step counter to its last position and nothing else reads it.
   * Deliberately not reset by a second fill: "Fill again" is expected on a
   * wizard, and the doctor has not gone backwards by pressing it.
   */
  filled: false,
  /** Which step the panel is showing. Presentation only. */
  step: "name",
  /** field_id -> doctor's value, when they have changed one. */
  edited: new Map(),
  /** field_ids the doctor has explicitly confirmed. */
  confirmed: new Set(),
  /**
   * Input ids the doctor has typed in themselves.
   *
   * Parsing re-runs on every pause in typing, and a doctor who corrected a
   * misparsed name would watch the next parse put the wrong one back. Their
   * edit wins from then on, for that paste.
   */
  touched: new Set(),
  /** Cancels the debounce when the paste changes again before it fires. */
  parseTimer: null,
  /** Whether the details drawer has already opened itself for this paste. */
  openedForMissing: false,
  /**
   * The questions read off the page the doctor is looking at NOW.
   *
   * Refreshed by scanPage on every page change, and deliberately not the same
   * thing as `rows`: these are questions nobody has answered yet. Mapping is
   * what turns them into rows, and it only happens on a click.
   */
  pageFields: [],
  /**
   * Whether the doctor picked the form themselves.
   *
   * Detection re-runs when a wizard step renders, and it must never overrule
   * a human. Someone who reached for the picker did so because the automatic
   * choice was wrong, and silently changing it back on the next step is the
   * kind of thing that gets noticed after the form is submitted.
   */
  formChosenByHand: false,
  /**
   * The schema whose instructions sharpen this page's questions, or null.
   *
   * Null is an ordinary state, not a failure: it means the page's own wording
   * is the best instruction available, and every question on it is still
   * answered and still filled.
   */
  schema: null,
  /**
   * The host of the page being filled, as the injected script reported it.
   *
   * Kept so the "reading the questions on this page" line can name it again
   * after the doctor changes the picker, without another survey. The panel has
   * no `tabs` permission and cannot ask Chrome what site it is on — this is
   * the only place that answer exists.
   */
  host: "",
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function apiBase() {
  return ($("api-base").value || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

/** The value that would actually be written: the doctor's edit wins. */
function valueOf(row) {
  return state.edited.has(row.field_id) ? state.edited.get(row.field_id) : row.value;
}

/** A value that cannot be written cannot be wrong. */
function hasValue(row) {
  const v = valueOf(row);
  if (typeof v === "string") return v.trim() !== "";
  return v !== null && v !== undefined;
}

/**
 * Rows cleared for writing.
 *
 * The guardrail is that nothing the model inferred reaches the form without an
 * explicit confirmation, and this is where it is enforced. Rows with no value
 * are excluded rather than gated: they are not written, so confirming them
 * would be busywork that trains the doctor to click through the one screen
 * that exists to be read. They still appear in the review list, because
 * "missing" is what tells the doctor what they have left to write by hand.
 */
function readyRows() {
  return state.rows.filter(
    (row) => hasValue(row) && (!row.needs_review || state.confirmed.has(row.field_id))
  );
}

/**
 * The plan handed to the matcher.
 *
 * Only rows we intend to fill, which is what makes the match rate meaningful:
 * the denominator is fields we were actually going to write, so a form with
 * many blanks does not read as a redesigned portal.
 */
function fillPlan() {
  // `step` travels with the field so the matcher can evaluate its guard
  // against the step on screen rather than against a whole wizard that is
  // never in the DOM at once. Absent for every stepless schema, which is the
  // case that behaves exactly as it always has.
  return readyRows().map((row) => ({
    fieldId: row.field_id,
    label: row.label,
    step: row.step || "",
  }));
}

function fillValues() {
  return Object.fromEntries(readyRows().map((row) => [row.field_id, valueOf(row)]));
}

// ---------------------------------------------------------------------------
// Step 1 — patient and note
// ---------------------------------------------------------------------------

/**
 * Does this tab's host belong to a schema?
 *
 * Host only — never the path or query. A ClaimEZ URL's `?pid=` is a bearer
 * credential for one patient's claim, and a match key is exactly the sort of
 * value that gets copied into a schema file and committed.
 *
 * A pattern also matches its subdomains, so `aia.com.sg` covers
 * `claimez.aia.com.sg`. Schemas are authored in this repo rather than supplied
 * by anyone else, and the cost of a too-broad pattern is bounded: the wrong
 * schema means the matcher fails to find its fields and refuses to fill.
 */
function hostMatches(host, patterns) {
  const h = String(host || "").toLowerCase();
  return (patterns || []).some((raw) => {
    const pattern = String(raw || "").toLowerCase().replace(/^\*\./, "");
    return Boolean(pattern) && (h === pattern || h.endsWith(`.${pattern}`));
  });
}

/**
 * Say what is going on, and open the picker.
 *
 * Only for the cases where something is genuinely wrong and a human choice
 * might help — not for "the bank does not describe this page", which is an
 * ordinary outcome handled by selectForm(null).
 */
function showPicker(message) {
  const detected = $("form-detected");
  detected.textContent = message;
  detected.classList.add("unknown");
  $("form-id").hidden = false;
  $("form-override").hidden = true;
}

// Thresholds for *identifying* a form, which are deliberately looser than the
// ones for filling it. A wizard shows one step at a time, so the right schema
// may only find a third of its fields on the page in front of us — demanding
// fill-grade confidence here would mean never recognising a multi-step form.
//
// Being loose is safe because identifying is not deciding: whatever is chosen
// here still has to clear MIN_MATCHED and MIN_MATCH_RATE in locate.js before a
// single value is written. This picks which schema to *try*.
const IDENTIFY_MIN_RATE = 0.4;
const IDENTIFY_MIN_MATCHED = 3;
// Two schemas fitting equally well is not a winner. Same insurer often means
// several forms with overlapping questions.
const IDENTIFY_MARGIN = 0.15;

/** The schema's own field labels, which is what the page is scored against. */
function candidatesFor(forms) {
  return forms.map((form) => ({
    formId: form.form_id,
    fields: (form.fields || []).map((f) => ({
      fieldId: f.id,
      label: f.label,
      step: f.step || "",
    })),
  }));
}

/**
 * How well a schema explains this page.
 *
 * For a wizard, that is its best-fitting single step, not its whole field
 * list: a four-step schema scored whole against one rendered step reads as
 * mostly absent, and would lose to a small unrelated schema that happens to
 * share three labels. What identifies a form here is "this page is one of my
 * steps".
 */
function fitOf(score) {
  return score.bestStepRate == null
    ? { rate: score.matchRate, matched: score.matched }
    : { rate: score.bestStepRate, matched: score.bestStepMatched };
}

/**
 * The best-fitting schema, or null when nothing fits or two things fit.
 */
function bestCandidate(scores) {
  const ranked = scores
    .map((s) => ({ ...s, fit: fitOf(s) }))
    .filter((s) => s.fit.matched >= IDENTIFY_MIN_MATCHED && s.fit.rate >= IDENTIFY_MIN_RATE)
    .sort((a, b) => b.fit.rate - a.fit.rate);

  if (!ranked.length) return null;
  const [best, runnerUp] = ranked;
  if (runnerUp && best.fit.rate - runnerUp.fit.rate < IDENTIFY_MARGIN) return null;
  return best;
}

/**
 * Record what will be used to sharpen this page's questions, and say so.
 *
 * `form` may be null, and that is a normal outcome rather than a failure
 * state: it means the page's own wording is the best instruction available.
 * Either way the panel is ready to map — nothing here disables anything.
 */
function describeSelection(form) {
  const detected = $("form-detected");
  // The picker is kept in step with the state rather than assumed to already
  // agree with it. It disagrees in both directions otherwise: a select with
  // nothing chosen shows its first option, and a doctor who picks one by hand
  // leaves the sentence above it describing the previous answer.
  $("form-id").value = form ? form.form_id : "";

  if (form) {
    detected.textContent = form.insurer
      ? `${form.insurer} — ${form.display_name}`
      : form.display_name;
    detected.classList.remove("unknown");
    return;
  }

  // Deliberately not phrased as a problem. Nothing is broken and there is
  // nothing for the doctor to do: BreezeFill reads the questions on the page
  // and answers those. Naming the host is the one useful detail, because it
  // is how they would tell us which form to describe properly later.
  detected.textContent = state.host
    ? `Reading the questions on this page (${state.host})`
    : "Reading the questions on this page";
  detected.classList.add("unknown");
}

function selectForm(form, host) {
  state.schema = form || null;
  if (host) state.host = host;
  describeSelection(state.schema);

  // The picker stays reachable, never required. A doctor who knows the bank
  // has a better description for this form than the page does can say so.
  $("form-id").hidden = true;
  $("form-override").hidden = false;
}

/**
 * Work out which schema this page needs, instead of asking.
 *
 * Runs when the panel opens, which is immediately after the doctor clicked the
 * BreezeFill icon on this tab — so the survey is inside the access they just
 * granted, and it only reads: `survey` writes nothing.
 *
 * Two signals, in order. The host is the strong one and costs nothing, but
 * only a schema that declared `hosts` can use it. The fingerprint — how many
 * of a schema's fields this page actually carries — works on any schema and
 * survives a redesign that changes the URL, so it is what decides between
 * several forms on one insurer's domain.
 *
 * Failing here is not an error state. It means the picker, which is also what
 * a form nobody has written a schema for looks like.
 */
/**
 * Which schema, if any, describes the page in front of the doctor.
 *
 * This used to decide whether BreezeFill would work at all: no match meant a
 * picker, and picking wrong or not at all meant no fill. That was the wrong
 * question. The doctor has to submit the form on their screen whatever this
 * server knows about it, so the answer to "is this in the bank" can only
 * change how *well* each question is answered, never whether they are
 * attempted.
 *
 * So it is now an enrichment lookup, and nothing in the flow waits on it. A
 * hit means every question it describes is answered with a real instruction
 * ("the date the patient FIRST consulted this doctor for this condition") and
 * that its own wording, not the page's, is what leaves the browser. A miss
 * means the page's questions are answered from the page's own words. Both
 * fill.
 */
async function detectForm() {
  if (!state.forms.length) return;
  // A human already answered this question. Detection re-runs on every wizard
  // step, and quietly overturning a doctor's choice between steps would change
  // which form is being filled without anyone being told.
  if (state.formChosenByHand) return;

  let response;
  try {
    response = await ask({
      action: "survey",
      plan: [],
      candidates: candidatesFor(state.forms),
    });
  } catch {
    showPicker("Could not read this page — pick the form yourself, or click the BreezeFill icon on the tab you want to fill.");
    return;
  }

  const { host } = response;
  const byHost = state.forms.filter((form) => hostMatches(host, form.hosts));
  // A host match narrows the field; it does not settle it, because an insurer
  // serves several forms from one domain.
  const shortlist = byHost.length ? byHost : state.forms;
  const ids = new Set(shortlist.map((f) => f.form_id));

  const best = bestCandidate((response.candidates || []).filter((c) => ids.has(c.formId)));
  const match =
    (best && state.forms.find((f) => f.form_id === best.formId)) ||
    // The page did not look like it, but the host was registered for it and
    // nothing else fit. Worth using: a wizard's first step carries few enough
    // fields to score badly while still being the right form.
    (byHost.length === 1 ? byHost[0] : null);

  selectForm(match, host);
}

async function loadForms() {
  const select = $("form-id");
  try {
    const response = await fetch(`${apiBase()}/forms`);
    if (!response.ok) throw new Error(String(response.status));
    state.forms = await response.json();
    state.formsFailed = false;
  } catch {
    // Recorded rather than inferred from an empty list. A backend that is
    // running and offers no forms is a different problem from one that is not
    // running, and telling a doctor to check the URL of a server that
    // answered is how twenty minutes get spent on the wrong thing.
    state.formsFailed = true;
    // Not fatal any more, and the wording says so. Without the bank the page's
    // questions are still answerable from their own labels — what is lost is
    // the sharper instruction behind each one, not the fill. The mapping call
    // itself will report the backend properly if it is really unreachable.
    setStatus($("map-status"), UNREACHABLE, "error");
    return;
  }

  select.replaceChildren();
  // No form is a choice, not the absence of one, and it needs an entry to be
  // choosable at all. A <select> has no empty state: without this its first
  // option stands selected whether or not anyone picked it, so a doctor who
  // opened the picker could name a form and never take one back — and the
  // control claimed a schema was in use while `state.schema` was still null.
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No form — use this page's own wording";
  select.append(none);

  for (const form of state.forms) {
    const option = document.createElement("option");
    option.value = form.form_id;
    option.textContent = form.insurer ? `${form.insurer} — ${form.display_name}` : form.display_name;
    select.append(option);
  }
}

/** The visible wording of a field, so a message can name it the way the
 *  doctor sees it rather than by its id. */
function labelOf(id) {
  // Two shapes carry a demographic input: the name's plain `.field` at step 1
  // and the badged `.review-row` cards on the check screen. Asking for either
  // keeps this working wherever a field is moved to next.
  const row = $(id).closest(".review-row, .field");
  const span = row && (row.querySelector(".label") || row.querySelector("span"));
  return (span ? span.textContent : id).toLowerCase();
}

/**
 * Everything the doctor pasted, as one body of text.
 *
 * One box now. There used to be a second, for the things a claim form asks
 * about that a consultation note does not hold — an admission reference, a
 * ward class, a billing code — and this function existed to join them, because
 * identifiers can appear in either and redaction works on one corpus with one
 * dictionary. Two boxes that were always concatenated before anything read
 * them were one box with a step in between, so the step went and the doctor
 * types those lines under their note.
 *
 * Kept as a function rather than inlined, because the invariant it names is
 * the one that matters: the demographics parse and the mapping call read the
 * same text. Anything that later adds a second source of pasted text adds it
 * HERE, and a path that redacted one source and not the other would be a leak
 * with a plausible-looking cause.
 */
function pastedText() {
  return $("paste").value.trim();
}

function patientRecord() {
  const value = (id) => $(id).value.trim();
  const record = {
    full_name: value("full-name"),
    nric: value("nric"),
    dob: $("dob").value,
    phone: value("phone") || null,
    address: value("address") || null,
    policy_number: value("policy-number") || null,
    insurer: value("insurer"),
    // The whole paste is the note, both boxes. Redaction runs over all of it
    // with the demographics above as its dictionary, so the header lines come
    // back as [PATIENT] and [NRIC] like anything else.
    clinical_text: pastedText(),
  };

  if (!record.clinical_text.trim()) throw new Error("Paste the consultation first.");
  const missing = REQUIRED_FIELDS.filter((id) => !$(id).value.trim());
  // Names the empty fields, never their contents.
  if (missing.length) {
    $("found").open = true;
    throw new Error(`Still needed: ${missing.map(labelOf).join(", ")}.`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Reading the paste
// ---------------------------------------------------------------------------
//
// The identifiers are found by pattern on the server (backend/demographics.py),
// never by a model, and that ordering is the privacy model rather than a
// preference: redaction pass 1 uses these values AS THE DICTIONARY it scrubs
// the paste with, because a name has no shape for a regex to find. A model
// asked to split the block would have read the name before any dictionary
// existed — and the note could no longer be scrubbed of it either.
//
// It is also why parsing is not done here in JavaScript. A second copy of
// redaction.py's patterns that drifted from the Python one is a leak.

const PARSE_DEBOUNCE_MS = 400;

function scheduleParse() {
  clearTimeout(state.parseTimer);
  if (!pastedText()) {
    state.openedForMissing = false;
    return;
  }
  state.parseTimer = setTimeout(parsePaste, PARSE_DEBOUNCE_MS);
}

async function parsePaste() {
  let parsed;
  try {
    // In this tab, and nowhere else. This used to be POST /parse, which sent
    // the WHOLE pasted note — un-redacted, because finding the name is what
    // has to happen before the name can be removed. So the raw note left the
    // browser one request before redaction had anything to work with.
    //
    // The name goes with the paste. Step 1 asked for it before this box
    // existed, so the parser never has to work out which piece of a header
    // block is the patient — it checks, which cannot be wrong, and the piece
    // beside it stays unclaimed instead of being read as a name.
    parsed = breezefillParse.parseDemographics(pastedText(), $("full-name").value.trim());
  } catch {
    // Deliberately quiet. Parsing is an assist, not the path: the fields
    // below are still typeable, and Map reports the real problem in one
    // place rather than two messages competing for the same line. The only
    // way this throws now is the shared shapes failing to load, which Map
    // refuses on outright.
    $("found-summary").textContent = "Patient details — could not read the paste, fill these in";
    $("found").open = true;
    return;
  }

  for (const [id, key] of Object.entries(DEMOGRAPHIC_FIELDS)) {
    if (state.touched.has(id)) continue;
    const value = parsed[key];
    $(id).value = value == null ? "" : value;
  }
  renderChoices(parsed.choices || {});
  updateFound();
}

/**
 * Ask, where the parser refused for having found more than one.
 *
 * The refusal itself is right and is not what changes here. What changes is
 * that it becomes visible: an empty box is also what the panel shows when the
 * note mentions no number at all, so a deliberate "the note says two things
 * and I will not choose between them" was indistinguishable from "I found
 * nothing" — and read as the product failing to look.
 *
 * The doctor picks. Nothing is pre-selected, nothing is ordered by preference,
 * and no candidate is written into the box on the doctor's behalf: the list is
 * in the order their own note wrote it, and the refusal to guess is unchanged.
 */
function renderChoices(choices) {
  for (const [id, key] of Object.entries(DEMOGRAPHIC_FIELDS)) {
    const box = $(`choices-${id}`);
    // full_name has no slot: it has no shape, so it cannot produce candidates
    // without guessing which words are a value. The insurer does have one — a
    // closed list of names — so a note mentioning two of them asks here.
    if (!box) continue;
    box.textContent = "";

    const options = choices[key] || [];
    // A value the doctor typed, or one an earlier pass resolved, is an answer.
    // Re-asking would invite them to undo a decision they already made.
    if (!options.length || state.touched.has(id) || $(id).value.trim()) continue;

    const why = document.createElement("p");
    why.className = "choices-why";
    // A single candidate only ever reaches here for the date of birth, which
    // is never taken from unlabelled text however alone it is. For every other
    // field a lone match is the value, so it arrives filled rather than asked.
    why.textContent =
      options.length === 1
        ? "Found in the note — is this the patient's?"
        : `${options.length} found in the note — pick the patient's:`;
    box.appendChild(why);

    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      button.textContent = option;
      button.addEventListener("click", () => {
        $(id).value = option;
        // Picking is deciding, so it counts as a correction: the next parse
        // must not put the question back or overwrite the answer.
        state.touched.add(id);
        box.textContent = "";
        updateFound();
      });
      box.appendChild(button);
    }
  }
}

/** How many fields are still waiting on the doctor to choose. */
function pendingChoices() {
  return Object.keys(DEMOGRAPHIC_FIELDS).filter(
    (id) => $(`choices-${id}`) && $(`choices-${id}`).querySelector("button")
  ).length;
}

/**
 * Say what was found and what is still missing.
 *
 * The drawer opens itself when something required is absent, but only once
 * per paste — re-opening it on every keystroke would fight the doctor who
 * just closed it.
 */
/**
 * The badge above one demographic field, in the review row's own vocabulary.
 *
 * The three states are what the legend used to spell out in a key nobody
 * reads twice: a value is here, a value is being asked about, or there is
 * nothing. Saying it on the field itself is what let the legend go.
 *
 * "You typed this" is not decoration. A value the doctor entered and a value
 * a pattern found carry different weight when they are checking whether the
 * redaction dictionary is right, and the panel is the only thing that knows
 * which is which.
 */
function badgeFor(id) {
  if ($(`choices-${id}`) && $(`choices-${id}`).querySelector("button")) {
    return ["inferred", "Needs checking"];
  }
  // "— fill by hand" went when Add arrived: the row now carries the way in,
  // so the badge saying it too was an instruction next to the button that
  // carries it out.
  if (!$(id).value.trim()) return ["missing", "Nothing found"];
  return state.touched.has(id)
    ? ["demographic", "You typed this"]
    : ["extracted", "Found in the note"];
}

function updateFound() {
  const ids = Object.keys(DEMOGRAPHIC_FIELDS);
  const found = ids.filter((id) => $(id).value.trim()).length;
  const missing = REQUIRED_FIELDS.filter((id) => !$(id).value.trim());

  for (const id of ids) {
    // `full-name` is asked for at step 1 and has no card here, which is the
    // one place this list and the markup deliberately disagree.
    const badge = $(`badge-${id}`);
    if (!badge) continue;
    const [status, text] = badgeFor(id);
    badge.className = `badge ${status}`;
    badge.textContent = text;
    // Toggled rather than assigned. `detail` is in the markup and is what
    // gives this row its whole layout, so writing the class list out in full
    // here — which is what this used to do — deleted it on the first
    // keystroke and left the card to fall back to the mapped row's.
    const row = $(`row-${id}`);
    row.classList.toggle("pending", status === "inferred");
    row.classList.toggle("missing", status === "missing");
    row.classList.toggle("confirmed", status !== "inferred" && status !== "missing");
  }
  // Said on the summary line, not only inside the drawer: the drawer can be
  // shut, and a question nobody sees is the blank box this replaced.
  const pending = pendingChoices();
  const toChoose = pending ? `, ${pending} to choose` : "";

  $("found-summary").textContent = missing.length
    ? `Patient details — ${missing.map(labelOf).join(", ")} still needed${toChoose}`
    : `Patient details — ${found} of ${ids.length} found${toChoose}`;

  if ((missing.length || pending) && !state.openedForMissing) {
    $("found").open = true;
    state.openedForMissing = true;
  }
}

// Where a doctor reports a failure, and the code they quote when they do.
//
// Every message below names one. A doctor cannot read a stack trace and
// should not be asked to describe a fault in their own words — "it did not
// work" is what actually arrives otherwise. A short code turns a support
// email into a lookup: BF-503 is the key, BF-NET is the network, and the two
// need completely different answers.
const SUPPORT_EMAIL = "thngedward@gmail.com";

/** A doctor-facing sentence, with the code that identifies it. */
function reportable(sentence, code) {
  return `${sentence} If this keeps happening, email ${SUPPORT_EMAIL} and quote ${code}.`;
}

// A network throw carries no status code — the request never reached a
// server, or reached one whose 500 came out of Starlette's error handler,
// which sits outside the CORS middleware and so answers with no
// Access-Control headers at all. Either way the browser hands us a bare
// TypeError: "Failed to fetch", which no doctor can act on.
const UNREACHABLE = reportable(
  "Could not reach BreezeFill's server. Check your internet connection, then try again.",
  "BF-NET"
);

function messageFor(error) {
  return error instanceof TypeError ? UNREACHABLE : error.message || "Mapping failed.";
}

/** Did the bank describe any of this page? Reporting only — never a gate. */
function mappingLive() {
  return !state.schema;
}

/**
 * The page's questions, each carrying the best instruction available for it.
 *
 * Every fillable control becomes a field to answer. The ones the matched
 * schema describes carry its wording and its instruction; the rest carry the
 * page's own. The join happens in the page (see `locate.enrich`), so the
 * schema's instructions reach the controls without page structure being sent
 * anywhere to arrange it — and a control the schema described contributes no
 * page text to the request at all.
 *
 * Labels have been through the dumper's scrubber by the time they get here;
 * the backend runs the same patterns again on the way in.
 */
async function liveFields() {
  const response = await ask({
    action: "survey",
    plan: [],
    enrichWith: state.schema ? schemaFieldsOf(state.schema) : [],
  });
  state.host = response.host;
  return (response.liveFields || []).map((field) => ({
    label: field.label,
    type: field.type,
    options: field.options || [],
    description: field.description,
  }));
}

/** A schema's fields in the shape `locate.enrich` joins against. */
function schemaFieldsOf(form) {
  return (form.fields || [])
    // Demographics are copied deterministically and never go to the model, so
    // a demographic field has no instruction to lend anything.
    .filter((f) => f.source === "llm")
    .map((f) => ({
      fieldId: f.id,
      label: f.label,
      // Normalised, because this crosses to the injected script and then to
      // the server: an absent key and an explicit null must not produce two
      // different requests for the same form.
      description: f.description || null,
      options: f.options || [],
    }));
}

/**
 * Put the patient back into the server's answers, in the panel.
 *
 * Two jobs the server can no longer do, because it was not given what they
 * need:
 *
 * 1. A demographic row arrives blank with `fill_from` naming the value it
 *    wants. The value is in the box the doctor checked two steps ago, and has
 *    never left this tab.
 * 2. Every other row arrives with the model's own tokens in it — "[PATIENT]
 *    was admitted on [DOB]" — because the map stayed here.
 *
 * A token that survives the substitution is one the model invented. It is
 * blanked and the row is held, which is the same rule the PDF path applies
 * server-side: a raw token must never reach a form, and a doctor must never
 * be shown a citation they cannot check rendered exactly like one they can.
 */
// The same sentence the server shows, because it is the same check. Kept
// verbatim rather than reworded: two wordings for one instruction is two
// things for a doctor to learn.
const DATE_RECHECK =
  "Check the day and month are the right way round — a date written 03/07 " +
  "is 3 July here and 7 March elsewhere.";

/** ISO, as an insurer's form wants it. */
function asFormDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(iso || "");
}

/**
 * Whether a date row has to be re-read, mirroring `_date_recheck`.
 *
 * Held only where both readings are possible, which is exactly where the day
 * is 12 or under. `25/07` is 25 July however the writer thinks about date
 * order, and a confirm click that is never the interesting one is how the
 * clicks that are get skimmed past.
 */
function dateRecheck(type, value) {
  if (type !== "date" || typeof value !== "string") return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(value.trim());
  if (!match || Number(match[1]) > 12) return null;
  return DATE_RECHECK;
}

function localise(rows, map) {
  const stillTokenised = (text) => typeof text === "string" && /\[[A-Z][A-Z0-9_]*\]/.test(text);

  return rows.map((row) => {
    if (row.fill_from) {
      const id = Object.keys(DEMOGRAPHIC_FIELDS).find(
        (key) => DEMOGRAPHIC_FIELDS[key] === row.fill_from
      );
      const raw = id ? $(id).value.trim() : "";
      // The date input holds ISO; a form wants it the way a form wants it,
      // which is what the server used to convert. Same conversion, same place
      // the value already is.
      const value = row.fill_from === "dob" ? asFormDate(raw) : raw;
      // A date the parser resolved by RULE rather than by reading — Singapore
      // writes day first, and a note that did not is misread silently and
      // identically every time. Held for the same reason and with the same
      // sentence the server uses, and only where both readings are possible.
      const recheck = dateRecheck(row.field_type, value);
      return { ...row, value: value || null, recheck, needs_review: Boolean(recheck) };
    }

    const value = breezefillRedact.remerge(row.value, map);
    if (stillTokenised(value)) {
      return { ...row, value: null, status: "missing", needs_review: true, source: null };
    }
    const source = breezefillRedact.remerge(row.source, map);
    return {
      ...row,
      value,
      source: stillTokenised(source) ? null : source,
      reasoning: stillTokenised(row.reasoning) ? null : breezefillRedact.remerge(row.reasoning, map),
    };
  });
}

async function onMap() {
  const status = $("map-status");

  // The form list is loaded once, when the panel opens. A backend started
  // afterwards used to mean the bank was empty for the whole session, so try
  // again here rather than making the doctor work that out.
  //
  // It is no longer fatal if this fails. An empty bank costs the sharper
  // instructions, not the fill: the page's own questions are still there to
  // answer. Only a backend that cannot be reached at all stops the mapping,
  // and that surfaces from the request below.
  if (!state.forms.length) {
    await loadForms();
    await detectForm();
  }

  if (await checkVersion()) {
    setStatus(
      status,
      "This version of BreezeFill is out of date and will not send anything. " +
        "Update it at chrome://extensions, then reopen this panel.",
      "error"
    );
    return;
  }

  // Nothing is sent until the shapes are in. Awaited rather than checked, so
  // a click that lands during the first hundred milliseconds waits instead of
  // taking the "not loaded" branch.
  await privacyReady;
  if (!breezefillRedact.ready() || !breezefillParse.ready()) {
    setStatus(
      status,
      reportable(
        "BreezeFill cannot remove the patient's details from this note, so it will not send it. Reload the extension.",
        "BF-SAFE"
      ),
      "error"
    );
    return;
  }

  // REDACTED HERE, AT SEND TIME, AND NOWHERE ELSE.
  //
  // Not at paste time and never cached. The doctor types after pasting — a
  // correction to a misparsed name, another sentence at the bottom of the box
  // — and text redacted against the dictionary as it stood ten seconds ago is
  // text redacted against the wrong dictionary. Rebuilding it costs
  // milliseconds; re-using it is how a name added after the parse goes out
  // unmasked.
  //
  // And it FAILS CLOSED. Everything below is inside the same try, so anything
  // that throws — patterns unloaded, no name, no date of birth — leaves
  // through the catch with nothing sent. There is no branch in this function
  // that posts the note as it was typed.
  let redacted;
  try {
    redacted = breezefillRedact.redact(patientRecord(), pastedText());
  } catch (error) {
    // The refusal names a field, so take the doctor to it.
    //
    // Every value the redactor needs lives on the check step, and this
    // refusal is raised on the page step — so "Still needed: date of birth"
    // arrived on a screen with no date of birth on it and nothing pointing
    // anywhere. The doctor had to already know the box was behind the Verify
    // row in the ledger. Found by clearing the field and pressing Map in a
    // real browser; the message was right and completely unactionable.
    setStatus(status, error.message, "error");
    sendToMissingDemographic();
    return;
  }

  $("map-btn").disabled = true;
  setStatus(status, "Reading this page, then mapping…", "busy");

  try {
    // One path now. The page in front of the doctor is always what gets
    // mapped; the bank only changes how well each of its questions is put.
    //
    // What goes on the wire is the questions and the tokenised note. No name,
    // no NRIC, no date of birth, and not the map that could turn a token back
    // into any of them.
    const request = {
      fields: await liveFields(),
      redacted_text: redacted.redacted_text,
    };
    if (!request.fields.length) {
      throw new Error(
        "No fillable questions found on this page. Click the BreezeFill icon on the tab with the form open."
      );
    }
    const response = await fetch(`${apiBase()}/map-redacted`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      // Fixed strings keyed on status, never the response body: the backend
      // keeps clinical text out of its own errors and echoing an uninspected
      // body would reintroduce it.
      throw new Error(
        {
          // Plain sentences, not diagnoses. The old 503 told a GP to set
          // ANTHROPIC_API_KEY in a terminal and restart it — a developer's
          // note on a doctor's screen. The code carries that detail instead.
          502: reportable("BreezeFill could not reach the service that reads notes.", "BF-502"),
          503: reportable("BreezeFill's server is not set up to answer yet.", "BF-503"),
          404: reportable("BreezeFill's server does not know this form.", "BF-404"),
          // Both of these used to arrive as a bare "Request failed (422)",
          // which is what a tester saw and could do nothing with. The backend
          // knew exactly what was wrong in each case; the panel was throwing
          // it away. Still keyed on the status and not the body — a 422 from
          // FastAPI's own validation quotes the input that failed, and the
          // input here carries the clinical text.
          413: reportable(
            "This page has more questions than BreezeFill can map at once. Try one section of the form at a time.",
            "BF-413"
          ),
          422: reportable(
            "BreezeFill could not read any questions on this page. Its fields may have no labels, or the form may sit inside a frame it cannot see.",
            "BF-422"
          ),
        }[response.status] || reportable("BreezeFill's server refused the request.", `BF-${response.status}`)
      );
    }
    const body = await response.json();
    // The last step that touches a patient's details, and it happens here.
    // The server answered in tokens because it was never given anything else;
    // the map that turns them back is in this tab and goes no further.
    state.rows = localise(body.fields, redacted.redaction_map);
    state.edited.clear();
    state.confirmed.clear();
    renderRows();
    // showStep is called anyway — this is where mapping is pressed from, and
    // saying so keeps the panel consistent when it is driven directly rather
    // than walked through.
    showStep("page");
    // The offer is spent: these questions have been mapped, and the button
    // that offered them would now re-ask the model the same thing.
    $("map-prompt").hidden = true;
    $("mapped").hidden = false;
    setStatus(status, "");
  } catch (error) {
    setStatus(status, messageFor(error), "error");
  } finally {
    $("map-btn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Step 2 — review
// ---------------------------------------------------------------------------

const STATUS_TEXT = {
  extracted: "Extracted from the note",
  inferred: "Inferred — check this",
  missing: "Not found — fill by hand",
  demographic: "From the details you entered",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A date spelled out in words, and the other date it might have been.
 *
 * The recheck the server asks for is only answerable if the doctor can see
 * what they are being asked about, and "03/07/2026" is exactly as ambiguous in
 * the review panel as it was in the note. Spelling it out turns the check into
 * a one-second read; naming the rival reading turns it into the right check,
 * because the question is never "is this a date" but "is it the right way
 * round".
 *
 * Display only. It never alters what gets written, and it never invents a
 * century — a two-digit year is echoed exactly as given, which is the same
 * refusal `_apply_date_format` makes on the server for the same reason.
 */
function readableDate(value) {
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}(?:\d{2})?)\s*$/.exec(String(value ?? ""));
  if (!match) return "";
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3];
  if (day < 1 || day > 31 || month < 1 || month > 12) return "";

  const reading = `${day} ${MONTH_NAMES[month - 1]} ${year}`;
  // Only a day that could itself be a month is ambiguous: 25/07 has one
  // reading, and offering a doctor a second one that cannot exist is noise
  // that makes the real warnings easier to skim past.
  if (day > 12) return reading;
  return `${reading} — or ${month} ${MONTH_NAMES[day - 1]} ${year} if the note wrote the month first`;
}

function renderRow(row) {
  const confirmed = state.confirmed.has(row.field_id);
  const pending = row.needs_review && !confirmed && hasValue(row);

  const wrap = document.createElement("div");
  wrap.className = "review-row" + (pending ? " pending" : "") + (confirmed ? " confirmed" : "");
  // What renderRows matches against to tell a row that has just appeared from
  // one that was already on screen.
  wrap.dataset.fieldId = row.field_id;

  // Reading a row moves the note pane's highlight to the sentence that row's
  // value came from. Both events, because both are how a doctor arrives at a
  // row: the mouse, and the Tab key — and after a confirm click, focus lands
  // on the next row's button, so the highlight follows the work by itself.
  const read = () => {
    state.reading = row.field_id;
    markNote(row);
  };
  wrap.addEventListener("click", read);
  wrap.addEventListener("focusin", read);

  const badge = document.createElement("div");
  badge.className = `badge ${row.status}`;
  badge.textContent = STATUS_TEXT[row.status] || row.status;
  wrap.append(badge);

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = row.label;
  wrap.append(label);

  if (row.help) {
    const help = document.createElement("p");
    help.className = "help";
    help.textContent = row.help;
    wrap.append(help);
  }

  // Why this row is held when its badge says it came straight from the note.
  // Shown above the value rather than beside the Confirm button: the doctor
  // needs to know what they are looking for before they look at it.
  if (row.recheck) {
    const recheck = document.createElement("p");
    recheck.className = "recheck";
    recheck.textContent = row.recheck;
    wrap.append(recheck);
  }

  let input;
  // Options are checked FIRST, and the order matters. A checkbox question that
  // declares options is answered with one of them, not with true/false — so
  // rendering it as a tick box would show the doctor a control that cannot
  // represent the answer, and `valueOf(row) === true` would read every option
  // string as unticked.
  if (row.options && row.options.length) {
    // The form's own choices, so a doctor correcting this picks something the
    // control will actually accept. Retyping it as free text is how the value
    // gets refused again at fill time, which is the failure this whole path
    // exists to remove.
    input = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    // A model that found no answer leaves this field blank, and blank has to
    // stay reachable: "none of these" is a legitimate answer to a dropdown,
    // and the doctor filling it by hand afterwards is the designed outcome.
    blank.textContent = "— leave blank —";
    input.append(blank);
    for (const option of row.options) {
      const el = document.createElement("option");
      el.value = option;
      el.textContent = option;
      input.append(el);
    }
    input.value = row.options.includes(valueOf(row)) ? valueOf(row) : "";
  } else if (row.field_type === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = valueOf(row) === true;
  } else {
    input = document.createElement("textarea");
    input.rows = String(Math.min(4, Math.max(1, String(valueOf(row) ?? "").length / 44 + 1)) | 0);
    input.value = valueOf(row) ?? "";
  }

  // Editing a value is confirming it: the doctor typed it, so there is
  // nothing left for them to accept.
  input.addEventListener("input", () => {
    state.edited.set(row.field_id, input.type === "checkbox" ? input.checked : input.value);
    state.confirmed.add(row.field_id);
    wrap.classList.remove("pending");
    wrap.classList.add("confirmed");
    updateReviewMeta();
  });
  // These rows carry no <label> at all — the question is a plain <div> above
  // the control — so a screen reader reaching the input announces the value
  // and nothing about what it is being asked. The question is the name.
  input.setAttribute("aria-label", row.label);
  wrap.append(input);

  // The inference, in words, where it is being signed off.
  //
  // The pane above marks the sentence this was worked out FROM, and that
  // sentence does not contain the answer — so without this the doctor is shown
  // a citation that does not match the value and left to reconstruct the step
  // themselves. Only inferred rows carry it; assemble_claim drops it for every
  // other status rather than trusting the prompt.
  if (row.reasoning) {
    const why = document.createElement("p");
    why.className = "derived";
    why.textContent = row.reasoning;
    wrap.append(why);
  }

  // The value in words, kept in step with the box above it. A doctor
  // correcting a swapped date is the whole point of this row, and they must be
  // able to see that the correction took — retyping 07/03 and being shown
  // "7 March" is the confirmation the digits alone cannot give.
  if (row.field_type === "date") {
    const hint = document.createElement("p");
    hint.className = "date-hint";
    const render = () => {
      hint.textContent = readableDate(valueOf(row));
      hint.hidden = !hint.textContent;
    };
    render();
    input.addEventListener("input", render);
    wrap.append(hint);
  }

  if (row.needs_review && !confirmed && hasValue(row)) {
    const button = document.createElement("button");
    button.className = "confirm";
    button.type = "button";
    button.textContent = "Confirm";
    button.addEventListener("click", () => {
      state.confirmed.add(row.field_id);
      // Mutated rather than re-rendered. Rebuilding the list replayed every
      // row's entrance animation and destroyed the button holding focus — one
      // click, and the doctor's place in a twenty-field claim was gone. The
      // row's own state is the only thing that changed, so it is the only
      // thing touched; the count, bar and Fill button follow underneath.
      // Where this row sits on screen right now. Confirming changes both what
      // is above it — the readiness line and bar leave when the last value is
      // confirmed — and what is inside it, since the button goes. Either
      // slides the whole list under the doctor mid-read, and when the content
      // shrinks past the current scroll position the browser clamps and the
      // panel jumps hundreds of pixels. Measured at 900 -> 285 in a real
      // Chromium before this.
      const scroll = $("scroll");
      const anchor = wrap.getBoundingClientRect().top;

      wrap.classList.remove("pending");
      wrap.classList.add("confirmed");
      button.remove();
      updateReviewMeta();

      if (scroll) scroll.scrollTop += wrap.getBoundingClientRect().top - anchor;
      focusAfterConfirm(wrap);
    });
    wrap.append(button);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// The progressive flow
// ---------------------------------------------------------------------------
//
// One step is active; the ones behind it collapse to a summary row; the ones
// ahead render nothing. Only VISIBILITY moves — every input stays in the DOM
// throughout, so no value is lost by stepping forward or back, and the panel
// can still be driven directly without walking the flow.

const STEPS = [
  { key: "name", section: "step-name", title: "Patient" },
  { key: "note", section: "step-note", title: "Consultation note" },
  { key: "check", section: "step-check", title: "Verify", edit: "Edit details" },
  { key: "page", section: "step-page", title: "This page" },
];

/** Show one step, collapse everything behind it, hide everything ahead. */
function showStep(key) {
  state.step = key;
  const index = STEPS.findIndex((s) => s.key === key);

  for (const [i, step] of STEPS.entries()) {
    const el = $(step.section);
    if (!el) continue;
    el.hidden = i !== index;
  }

  const done = $("done-rows");
  // Rebuilt every time, deliberately — a done row reads the inputs at render
  // time, which is what makes it a record of the step as it was finished. But
  // a row that was already standing there has not entered, so advancing to the
  // last step must not replay the entrance of the three rows behind it.
  const standing = new Set([...done.children].map((el) => el.dataset.key));
  done.replaceChildren(
    ...STEPS.slice(0, index).map((s) => {
      const el = doneRow(s);
      if (standing.has(s.key)) el.classList.add("no-enter");
      return el;
    })
  );

  placeLedger();
  showNotePane();
  updateBackToReview();
  $("step-counter").textContent = `Step ${index + 1} of ${STEPS.length}`;
  // Not scrollIntoView: on a panel this narrow it fights the user's own
  // scrolling. Setting the container's scrollTop puts the new step where the
  // last one was without hijacking anything.
  const scroll = $("scroll");
  if (scroll) scroll.scrollTop = 0;
}

/**
 * The way back to a mapped review, on the two conditions that make it useful.
 *
 * `showStep` hides every step ahead of the one being shown. That is right on
 * the way through — those steps have not happened — and wrong once a mapping
 * has landed, because the answers HAVE happened and sit in `state.rows` the
 * whole time. Stepping back to check a spelling took them off screen.
 *
 * It exists when both of these hold, and the second one is the correction:
 *
 * 1. The doctor is not already looking at the review.
 * 2. The review has at least one ANSWER on it — not merely rows. A mapping
 *    that came back entirely `missing` produces a screenful of empty boxes,
 *    and a button offering to take somebody back to that is offering nothing.
 *    Rows alone were the old test, and they are why this appeared over a
 *    review with nothing in it.
 *
 * Both are read from state at render time rather than latched, so the button
 * leaves by itself when a wizard section change discards the answers. A route
 * back to an empty review is worse than no route: the walk-forward buttons
 * still reach that step, so nothing is unreachable without this.
 *
 * The count is in the label because it is the whole promise. "Back to the
 * mapped fields" cannot be checked before clicking; "Back to 12 answers" can.
 */
function updateBackToReview() {
  const button = $("back-to-review");
  if (!button) return;

  const answers = state.rows.filter(hasValue).length;
  button.hidden = !answers || state.step === "page";
  if (!button.hidden) {
    button.textContent = `Back to ${answers} mapped ${answers === 1 ? "answer" : "answers"}`;
  }
}


/** A finished step in one line: what actually went into it. */
function summaryOf(key) {
  if (key === "name") return $("full-name").value.trim() || "\u2014";
  if (key === "note") {
    // The note's opening line, not a word count. A doctor checking they
    // pasted the right consultation recognises how it starts; nobody has ever
    // recognised a claim by its length.
    const first = $("paste").value.split("\n").find((line) => line.trim());
    return first ? first.trim() : "\u2014";
  }
  if (key === "check") {
    const ids = Object.keys(DEMOGRAPHIC_FIELDS);
    const found = ids.filter((id) => $(id).value.trim()).length;
    return `${found} of ${ids.length} found`;
  }
  if (key === "page") {
    const n = state.rows.length;
    return n ? `${n} question${n === 1 ? "" : "s"}` : "\u2014";
  }
  return "";
}

/**
 * A finished step, as one hairline row.
 *
 * It used to be a card: a bordered box with a filled green disc, a chevron,
 * and a drawer holding the values under an uppercase mono caption. Three
 * things were wrong with that, and the third is the one that mattered.
 *
 * It was the heaviest chrome on the screen standing in for the least important
 * thing on it — a step already done, drawn with the same card, border and
 * radius as the live one beneath it. Changing a value cost two clicks, expand
 * then find the link, when going back to the step IS the only reason the row
 * exists. And the drawer's whole content was the value, so putting the value
 * on the row deletes the drawer rather than restyling it.
 */
function doneRow(step) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "done-row";
  row.dataset.key = step.key;

  const check = document.createElement("span");
  check.className = "done-check";
  check.textContent = "\u2713";
  // Decoration. Without this a screen reader reads the row as "tick Patient
  // Tan Wei Ling chevron" — the glyphs are the visual form of "done" and "go
  // back", and both are already said by the label below.
  check.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "done-name";
  name.textContent = step.title;

  const value = document.createElement("span");
  value.className = "done-value";
  value.textContent = summaryOf(step.key);

  const go = document.createElement("span");
  go.className = "done-go";
  go.textContent = "\u203a";
  go.setAttribute("aria-hidden", "true");

  // Named outright, because the visible parts otherwise run together into
  // "PatientTan Wei Ling" with nothing between them.
  row.setAttribute("aria-label", `${step.title}: ${summaryOf(step.key)}. Go back to this step.`);
  row.append(check, name, value, go);
  row.addEventListener("click", () => showStep(step.key));
  return row;
}

/**
 * Where the finished steps sit, which depends on what the doctor is doing.
 *
 * ABOVE while the history IS the work — the steps just completed, in the order
 * they were completed. BELOW once there are mapped values on screen, because
 * arriving at the review meant arriving at a list of steps already finished
 * with the values themselves pushed under the fold. And NOWHERE once a fill
 * has landed: a history of where you have been is the least useful thing to
 * show at the moment you asked what just happened.
 */
function placeLedger() {
  const rows = $("done-rows");
  const scroll = $("scroll");
  if (!rows || !scroll) return;

  if (state.filled) {
    rows.hidden = true;
    return;
  }
  rows.hidden = false;
  const below = state.rows.length > 0;
  rows.classList.toggle("below", below);
  if (below) scroll.append(rows);
  else scroll.prepend(rows);
}

function updateProgress() {
  const index = STEPS.findIndex((s) => s.key === state.step);
  if (index >= 0) $("step-counter").textContent = `Step ${index + 1} of ${STEPS.length}`;
}

/**
 * The readiness line, the bar and the Fill button — everything about the
 * review except the rows themselves.
 *
 * Split out of renderRows so that confirming one value can move all three
 * WITHOUT rebuilding the list. It is also called from the input handler, which
 * is what the markup beside the bar has always claimed ("only a confirm click
 * or an edit moves it") and what it did not actually do: editing a value
 * updated the Fill button and left the bar and the count behind.
 */
function updateReviewMeta() {
  const pending = state.rows.filter(
    (r) => r.needs_review && hasValue(r) && !state.confirmed.has(r.field_id)
  ).length;
  // Nothing left to confirm is not news. The sentence that stood here — "4 of
  // 5 fields ready to write. The rest are for you to complete by hand." —
  // appeared exactly when the doctor had stopped needing a sentence, directly
  // above the one button they were reaching for. It and the bar both leave,
  // and Fill is the only thing still talking.
  $("review-summary").hidden = pending === 0;
  $("review-progress-box").hidden = pending === 0;
  $("review-summary").textContent =
    `${pending} value${pending === 1 ? "" : "s"} still to confirm. Nothing is written until you do.`;

  // Readiness as a bar as well as a count. It only ever moves on a confirm
  // click or an edit — nothing advances it on its own, which is the point.
  //
  // Scaled, not resized. `width` is a layout property, so every frame of this
  // transition re-laid-out and repainted the review list underneath it.
  const needing = state.rows.filter((r) => r.needs_review && hasValue(r)).length;
  const done = needing - pending;
  const bar = $("review-progress");
  if (bar) bar.style.transform = `scaleX(${needing === 0 ? 1 : done / needing})`;

  updateFillButton();
  updateProgress();
}

/**
 * Build the consultation once, with every cited sentence already a span.
 *
 * `row.source` is the snippet the model is told to quote VERBATIM out of the
 * notes, so locating it is an exact substring search and nothing else. A fuzzy
 * match would draw a mark around a sentence the value did not come from, on
 * the one screen whose whole job is showing the doctor where a value came
 * from — a wrong citation rendered exactly like a right one.
 *
 * Built once rather than on every mark. Rebuilding the pane to move the mark
 * reset its scrollTop on every frame of a scroll, which is what made following
 * the rows stutter; now only a class moves.
 */
/**
 * Where a quote sits in the note, allowing only the WHITESPACE to differ.
 *
 * The pane rests on the model quoting verbatim, and a quote that is not in
 * the note is refused rather than approximated — a fuzzy match would draw a
 * highlight round a sentence the value did not come from, on the one screen
 * whose job is showing where a value came from. That rule is unchanged here.
 *
 * What changes is that a line break is not a difference in the text. Notes
 * wrap; a model quoting a sentence that spans a break hands it back with a
 * space, and every character in it is still the doctor's own. Refusing that
 * loses a correct citation, and a correct citation refused reads exactly like
 * "this value came from nowhere" — which is the thing the doctor is checking.
 *
 * Whitespace runs match whitespace runs. They are not allowed to match
 * NOTHING, so "acutetonsillitis" still fails against "acute tonsillitis"; the
 * words themselves are compared character for character, punctuation
 * included. Returns the span in the NOTE's coordinates, so what is marked is
 * always what the note says rather than what the model returned.
 */
function locateQuote(text, src) {
  const at = text.indexOf(src);
  if (at >= 0) return { at, end: at + src.length };

  const words = src.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const pattern = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const match = new RegExp(pattern).exec(text);
  return match ? { at: match.index, end: match.index + match[0].length } : null;
}

function buildNote() {
  const pre = $("note-text");
  if (!pre) return;
  const text = $("paste").value;

  const spans = [];
  const seen = new Set();
  for (const row of state.rows) {
    const src = typeof row.source === "string" ? row.source.trim() : "";
    if (!src || seen.has(src)) continue;
    const at = locateQuote(text, src);
    if (!at) continue;
    seen.add(src);
    spans.push({ ...at, src });
  }
  spans.sort((a, b) => a.at - b.at);

  const parts = [];
  let cursor = 0;
  for (const span of spans) {
    // Two citations claiming overlapping text: the earlier one keeps it. A
    // nested span would mark a fragment of somebody else's sentence.
    if (span.at < cursor) continue;
    if (span.at > cursor) parts.push(document.createTextNode(text.slice(cursor, span.at)));
    const el = document.createElement("span");
    el.className = "quote";
    // Two strings, and they are not always the same one. `src` is the model's
    // quote and is the key markNote matches a row against; `shown` is what the
    // note itself says at that position, which is what the doctor reads and
    // what setHit must rebuild from. Rendering the model's copy would let a
    // requoted line rewrite the consultation on screen.
    el.dataset.src = span.src;
    el.dataset.shown = text.slice(span.at, span.end);
    el.textContent = el.dataset.shown;
    parts.push(el);
    cursor = span.end;
  }
  if (cursor < text.length) parts.push(document.createTextNode(text.slice(cursor)));
  pre.replaceChildren(...parts);
}

/**
 * Emphasise the value inside the sentence that carries it.
 *
 * Only for a quoted value, because only a quoted value is in there. Rewrites
 * one span's children and never the pane, so the scroll position is untouched.
 */
function setHit(el, hit) {
  const text = el.dataset.shown;
  const at = hit ? text.toLowerCase().indexOf(hit.toLowerCase()) : -1;
  if (at < 0) {
    el.textContent = text;
    return;
  }
  const strong = document.createElement("b");
  strong.className = "hit";
  strong.textContent = text.slice(at, at + hit.length);
  el.replaceChildren(
    document.createTextNode(text.slice(0, at)),
    strong,
    document.createTextNode(text.slice(at + hit.length))
  );
}

/**
 * Mark the sentence the row being read came from.
 *
 * Two marks, because there are two relationships. An EXTRACTED value is in its
 * sentence, so the sentence is filled and the value emphasised inside it — the
 * match is shown rather than asserted. An INFERRED one is not: "J03.90"
 * appears nowhere in "Dx acute tonsillitis." Filling that sentence identically
 * makes the most dangerous row on the screen read as a wrong citation, so it
 * gets an outline, the header says the value was worked out from it, and the
 * row itself carries the model's own sentence explaining the step.
 *
 * Called with null to leave the note unmarked.
 */
function markNote(row) {
  const pre = $("note-text");
  const state_line = $("note-following");
  if (!pre) return;

  const source = row && typeof row.source === "string" ? row.source.trim() : "";
  const reasoned = Boolean(row) && row.status === "inferred";
  const value = row && typeof row.value === "string" ? row.value.trim() : "";
  let target = null;

  for (const el of pre.querySelectorAll(".quote")) {
    const on = Boolean(source) && el.dataset.src === source;
    el.classList.toggle("on", on);
    el.classList.toggle("quoted", on && !reasoned);
    el.classList.toggle("reasoned", on && reasoned);
    // No hit for an inference: the value is not in there to emphasise, and
    // guessing which words produced it is the fuzzy match this refuses.
    setHit(el, on && !reasoned ? value : null);
    if (on) target = el;
  }

  // Three silent cases and they are not the same thing. Nothing is being read;
  // the model answered from something it did not quote; or the value never
  // came from the note at all — a demographic copied across, or a blank.
  state_line.textContent = !row
    ? ""
    : !target
      ? source
        ? "quote not found in the note"
        : "not taken from the note"
      : reasoned
        ? `${row.label} — worked out from this`
        : row.label;

  if (!target) return;
  // Only when there is somewhere to go. A note that fits needs no moving.
  if (pre.scrollHeight <= pre.clientHeight) return;

  // And only when the mark is not already in view. Centring it unconditionally
  // scrolled the pane on arrival even though the sentence was visible, which
  // hid the note's first line — the patient header — behind the top edge for
  // no reason. Nearest, not centred: move the least that puts it on screen.
  const box = pre.getBoundingClientRect();
  const mark = target.getBoundingClientRect();
  const MARGIN = 8;
  if (mark.top >= box.top + MARGIN && mark.bottom <= box.bottom - MARGIN) return;
  const delta =
    mark.top < box.top + MARGIN
      ? mark.top - box.top - MARGIN
      : mark.bottom - box.bottom + MARGIN;
  pre.scrollTo({
    top: Math.max(0, pre.scrollTop + delta),
    behavior: REDUCED_MOTION.matches ? "auto" : "smooth",
  });
}

/**
 * The consultation is furniture on the screen where its values are checked,
 * and nowhere else.
 *
 * Two conditions, and the second is the one that was missing: there have to be
 * values to check it against, AND the doctor has to be on the screen holding
 * them. Going back to the note step left the pane up beside the paste box, so
 * the same consultation was on screen twice — once as the thing being edited
 * and once as a read-only copy of it.
 */
function showNotePane() {
  const pane = $("notepane");
  if (pane) pane.hidden = state.rows.length === 0 || state.step !== "page";
}

/**
 * Open the check step on the first value the redactor is missing.
 *
 * Only when something IS missing: a redaction failure with every demographic
 * present is a different fault, and yanking the doctor off the page step to
 * show them a complete form would be worse than saying nothing.
 */
function sendToMissingDemographic() {
  const missing = REQUIRED_FIELDS.filter((id) => !$(id).value.trim());
  if (!missing.length) return;
  showStep("check");
  const field = $(missing[0]);
  // Not focus() alone: the field sits mid-panel behind a step that has only
  // just been shown, and a focus the doctor cannot see is not a destination.
  if (field) {
    // Optional: there is no layout to scroll in the test environment, and a
    // panel that threw here would refuse to map for a reason unrelated to
    // redaction.
    field.scrollIntoView?.({ block: "center" });
    field.focus();
  }
}

/** Fold the note away without losing it. Session-only, like everything here. */
function toggleNote() {
  const pre = $("note-text");
  const button = $("note-toggle");
  const showing = pre.hidden;
  pre.hidden = !showing;
  $("notepane").dataset.folded = String(!showing);
  button.textContent = showing ? "Hide" : "Show";
  button.setAttribute("aria-expanded", String(showing));
}

/**
 * Follow the rows as the doctor scrolls them.
 *
 * The LAST row to have crossed the reading line, not the nearest one to it.
 * Nearest was wrong in a way that felt like a bug: the moment the doctor was
 * halfway down a row, the next row's top became the closer edge and took over,
 * so the mark ran a row ahead of the eye the whole way down the list.
 */
function followScroll() {
  const container = $("scroll");
  const rows = $("rows");
  if (!container || !rows || !rows.children.length) return;

  const line = container.getBoundingClientRect().top + 28;
  let best = rows.children[0];
  for (const el of rows.children) {
    if (el.getBoundingClientRect().top <= line) best = el;
  }
  const id = best.dataset.fieldId;
  if (id === state.reading) return;
  state.reading = id;
  markNote(state.rows.find((r) => r.field_id === id) || null);
}

function renderRows() {
  // Rows appearing and rows being discarded both come through here, and the
  // way back to them has to appear and disappear with them.
  updateBackToReview();
  const container = $("rows");
  // Which rows were already on screen before this render. A row that was here
  // has not entered, so it must not play an entrance: without this, every row
  // in the list re-ran pf-rise whenever any one of them changed, and on a
  // twenty-field claim confirming a single value made the whole screen move.
  const seen = new Set([...container.children].map((el) => el.dataset.fieldId));
  container.replaceChildren(
    ...state.rows.map((row) => {
      const el = renderRow(row);
      if (seen.has(row.field_id)) el.classList.add("no-enter");
      return el;
    })
  );
  showNotePane();
  buildNote();
  // Already marked, on the row at the top of the list — the same rule
  // scrolling uses, so the mark always answers the row the doctor is looking
  // at. Marking the first value NEEDING a check instead put the mark on a row
  // further down while the top of the screen showed a different question, and
  // a citation that does not match the visible row reads as a wrong citation.
  const first = state.rows[0];
  state.reading = first ? first.field_id : null;
  markNote(first || null);
  // Mapped values on screen move the finished steps under them.
  placeLedger();
  updateReviewMeta();
}

/**
 * Where the keyboard goes when a Confirm button removes itself.
 *
 * Nowhere, unless it is put somewhere: the focused element has just left the
 * document, so the browser drops focus to <body> and the next Tab starts again
 * from the top of the panel — which on a long claim means the doctor loses
 * their place on every single confirm.
 *
 * Somewhere IN PLACE, and never the Fill button. The next value still waiting
 * is what they were going to press anyway; when there is none, they stay on
 * the row they just confirmed rather than being carried to the bottom of the
 * claim.
 */
function focusAfterConfirm(wrap) {
  const remaining = [...$("rows").querySelectorAll("button.confirm")];
  const next =
    remaining.find(
      (b) => wrap.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    ) || remaining[0];
  // preventScroll throughout. Focus is a keyboard position, not a scroll
  // instruction, and where the doctor is looking is their decision.
  if (next) {
    next.focus({ preventScroll: true });
    return;
  }
  // Nothing left to confirm, and this is where it used to travel to the Fill
  // button — which scrolled the doctor to the bottom of the claim the instant
  // they confirmed the last value, ending the read-through they were in the
  // middle of. Confirming the last one is not the same as being finished.
  // Staying on the row keeps Tab order sensible and moves nothing.
  wrap.tabIndex = -1;
  wrap.focus({ preventScroll: true });
}

function updateFillButton() {
  const pending = state.rows.some(
    (r) => r.needs_review && hasValue(r) && !state.confirmed.has(r.field_id)
  );
  $("fill-btn").disabled = pending || readyRows().length === 0;
}

// ---------------------------------------------------------------------------
// Step 3 — the page
// ---------------------------------------------------------------------------

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  return tab.id;
}

/**
 * Inject the filler and ask it something.
 *
 * Injection is repeated on every call rather than tracked, because the tab may
 * have been reloaded since last time and a stale assumption would surface as a
 * silent no-op. The orchestrator guards against double-registration itself.
 */
async function ask(message) {
  const tabId = await activeTabId();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
  } catch {
    throw new Error(
      reportable(
        "BreezeFill has no access to this tab. Click the BreezeFill icon in the toolbar while this page is open, then try again.",
        "BF-TAB"
      )
    );
  }
  const response = await chrome.tabs.sendMessage(tabId, { target: "breezefill-content", ...message });
  if (!response || !response.ok) {
    throw new Error(reportable("The insurer's page did not answer.", "BF-PAGE"));
  }
  return response;
}

function renderReport(response) {
  const container = $("fill-report");
  container.replaceChildren();

  // The result is three different messages needing three different responses
  // from the doctor — what landed, what belongs to a later step, and what they
  // must write themselves — so each gets its own block rather than one flat
  // list where the important one scrolls past.
  // The filler's own count is authoritative; `applied` is the per-field
  // detail behind it and is not always sent. They disagreed silently before —
  // the status line quoted one and the banner counted the other.
  const written =
    typeof response.filled === "number"
      ? response.filled
      : (response.applied || []).filter((a) => a.status === "filled").length;
  if (!response.refused && written > 0) {
    const banner = document.createElement("div");
    banner.className = "report-block is-success";
    const heading = document.createElement("h3");
    heading.textContent = `Filled ${written} field${written === 1 ? "" : "s"} on this page.`;
    const body = document.createElement("p");
    // The most important sentence in the product: what is written here is
    // signed and submitted as the doctor's own clinical statement.
    body.textContent = "Check each one on the form, then submit it yourself.";
    banner.append(heading, body);
    container.append(banner);
  } else if (!response.refused) {
    // Nothing was written, and the success block is the wrong thing to say
    // about that. It read "Filled 0 fields on this page." in confident green,
    // over "Check each one on the form" — an instruction to check nothing.
    // Every value was already answered, or belonged elsewhere; the list below
    // says which, per field, and that is the whole of the news.
    const none = document.createElement("div");
    none.className = "report-block is-manual";
    const heading = document.createElement("h3");
    heading.textContent = "Nothing was written on this page.";
    const body = document.createElement("p");
    body.className = "note";
    body.textContent = "Nothing was overwritten either. What happened to each field is below.";
    none.append(heading, body);
    container.append(none);
  }

  const list = document.createElement("ul");
  const byId = new Map(state.rows.map((r) => [r.field_id, r]));

  for (const result of response.report.results) {
    const item = document.createElement("li");
    const row = byId.get(result.fieldId);
    const name = row ? row.label : result.fieldId;
    const applied = (response.applied || []).find((a) => a.fieldId === result.fieldId);
    const outcome = applied ? applied.status : result.status;
    // The reason, not just the verdict. "skipped" alone is what a dropdown
    // answer the control does not offer looks like — a field the doctor
    // reviewed and approved, reported as skipped with no way to tell whether
    // that meant "already correct", "not on this page" or "the value would
    // not go in". Each of those needs a different response from them.
    const why = applied && applied.reason ? ` (${applied.reason})` : "";
    item.textContent = `${name} — ${outcome}${why}`;
    list.append(item);
  }
  // Only when there is something in it. A refused fill reports no results at
  // all, and the heading was rendering over an empty list.
  if (list.children.length) {
    const detail = document.createElement("div");
    detail.className = "report-block";
    const detailHeading = document.createElement("h3");
    detailHeading.textContent = "What happened to each field";
    detail.append(detailHeading, list);
    container.append(detail);
  }

  // Fields belonging to a step that is not rendered. Said plainly, because
  // otherwise they are indistinguishable from fields that failed — and the
  // action is simply to advance the wizard and press Fill again.
  if (response.report.deferred) {
    const later = document.createElement("div");
    later.className = "report-block is-deferred";
    const h = document.createElement("h3");
    h.textContent = `${response.report.deferred} field${response.report.deferred === 1 ? "" : "s"} belong to a later step`;
    const body = document.createElement("p");
    body.className = "note";
    // A normal outcome on a multi-step portal. It must not read as failure.
    body.textContent = "Move to that step of the form and press Fill again.";
    later.append(h, body);
    container.append(later);
  }

  // The list of live controls nothing claimed used to be a block here, and it
  // reported at the end what every field already says about itself — after the
  // fill, which is the one moment the doctor can no longer act on it while
  // reading the rows. A question the note could not answer says so on its own
  // row, where they are already looking. On the live path this was always
  // empty anyway: every fillable control on the page becomes a question.
}

/**
 * Read the page in front of the doctor, and say what is on it.
 *
 * No model call, and that is the whole design of this step. Surveying is the
 * injected script reading labels in the page it is already in; mapping is the
 * request that leaves the browser. Keeping them apart is what lets the panel
 * follow a doctor through four wizard sections without four model calls
 * nobody asked for — it looks at each one and waits to be told to answer it.
 *
 * Called when the check step is passed, and again every time the page becomes
 * a different page.
 */
async function scanPage() {
  $("map-prompt").hidden = true;
  setStatus($("map-status"), "");

  let fields = [];
  try {
    fields = await liveFields();
  } catch (error) {
    setStatus($("map-status"), messageFor(error), "error");
    return;
  }

  state.pageFields = fields;

  if (!fields.length) {
    // Not an error. A wizard opens on a verification or a landing section as
    // often as not, and saying "none here yet" is the honest report — the old
    // panel called this a failure and stopped.
    $("prompt-title").textContent = "No questions on this page yet.";
    $("prompt-why").textContent =
      "Move to the section of the form that asks about the consultation.";
    $("map-btn").hidden = true;
    $("map-prompt").hidden = false;
    return;
  }

  // The count sits on the card it is a count of. It used to be on a strip
  // above this one reading "Watching localhost:8080. 7 questions on it." —
  // which named the host the extension had noticed, a fact about the extension
  // rather than about the claim, in a box that cost a doctor a line of screen
  // on every wizard step.
  $("prompt-title").textContent =
    `${fields.length} question${fields.length === 1 ? "" : "s"} on this page.`;
  $("prompt-why").textContent =
    "Nothing has been sent yet. Mapping asks the model to answer these from your scrubbed note.";
  $("map-btn").textContent =
    `Map ${fields.length === 1 ? "this question" : `these ${fields.length} questions`}`;
  $("map-btn").hidden = false;
  $("map-prompt").hidden = false;
}


/**
 * A wizard step rendered on the tab the doctor granted us.
 *
 * Two things happen, and neither of them is filling. Identification re-runs,
 * because the step that was on screen when the panel opened may have carried
 * none of the right schema's fields. And if there are values waiting, the
 * doctor is told the page moved — with the button they already know, not a
 * new one.
 *
 * Filling here would be wrong on its own terms: advancing a step is the doctor
 * interacting with the insurer's form, not asking BreezeFill for anything. The
 * guarantee is that values are written when a doctor clicks Fill, and an
 * observer that wrote on render would quietly move the review step to after
 * the writing.
 */
async function onPageChanged() {
  await detectForm();
  if (state.step !== "page") return;

  // The answers on screen belong to the section that has just been left. They
  // are not offered against the new one: a value mapped for "date of
  // admission" is not an answer to whatever question happens to sit in the
  // same position here, and leaving them up would invite a fill that wrote
  // last section's answers into this one.
  //
  // Discarding them is right. Discarding them SILENTLY is not, and that is
  // what happened: a doctor who had read four rows and confirmed one watched
  // the whole review vanish, with an empty status line and a fresh prompt as
  // the only sign anything had occurred. Work disappearing with no account of
  // itself is the one thing a review screen must never do.
  const discarded = state.rows.length;
  state.rows = [];
  state.edited.clear();
  state.confirmed.clear();
  renderRows();
  $("mapped").hidden = true;
  setStatus($("fill-status"), "");
  $("fill-report").replaceChildren();

  await scanPage();

  // Said on the prompt card rather than the status line, because the card is
  // amber and mid-panel and this is news. Prepended rather than replacing:
  // scanPage has already said what is on the new section, and that is what
  // the doctor does next.
  if (discarded) {
    const why = $("prompt-why");
    why.textContent =
      "The form moved on, so the answers for the last section were cleared — " +
      "they are not answers to these questions. " +
      why.textContent;
  }
}

// ---------------------------------------------------------------------------
// Growing the bank
// ---------------------------------------------------------------------------

/**
 * A draft schema for the form just filled, for a human to read and commit.
 *
 * Deliberately not installed anywhere. A schema is used on every later claim
 * against that form, so an unreviewed one turns one mis-mapped field into a
 * permanent wrong answer that nothing re-checks — and the fields here were
 * named by a model reading a page, not by anyone who has seen the form. The
 * review is cheap: it is a few dozen lines of JSON, and the labels are the
 * questions the doctor just answered.
 *
 * The descriptions are the weakest part and are worth editing by hand. A
 * schema earns its keep by telling the model what a question *means* — "the
 * date the patient FIRST consulted this doctor for this condition, not the
 * latest visit" — and all a page can supply is the wording of the question.
 */
// Enough of a public-suffix list to guess an insurer's name from a host, and
// not one character more — this is used for a display string a human edits,
// never for matching. Singapore's are two-part (aia.com.sg), which is exactly
// the trap: "the last two labels" of claimez.aia.com.sg is "com.sg".
const HOST_SUFFIXES = new Set([
  "com", "net", "org", "edu", "gov", "co", "sg", "uk", "au", "my", "id", "hk", "www",
]);

function draftSchema() {
  const host = state.host || "";
  const parts = host.split(".").filter(Boolean);
  // The rightmost label that is not a suffix: claimez.aia.com.sg -> aia,
  // roboform.com -> roboform. A guess, and labelled as one in display_name.
  const brand = parts.filter((p) => !HOST_SUFFIXES.has(p)).pop() || "insurer";

  return {
    form_id: `${brand}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_v1`,
    display_name: `Drafted from ${host} — rename me`,
    insurer: brand.toUpperCase(),
    fill_mode: "web",
    // The full host, never a guess at the registrable domain. `hostMatches`
    // matches subdomains too, so a wrong guess here does not merely miss —
    // "com.sg" would claim every commercial site in Singapore. Widening this
    // by hand to aia.com.sg is a one-word edit for whoever commits it; a
    // schema that silently claims a whole TLD is not recoverable by review.
    hosts: [host],
    fields: state.rows.map((row) => ({
      id: row.field_id,
      label: row.label,
      type: row.field_type,
      source: "llm",
      description: row.help || row.label,
    })),
  };
}

function showDraft() {
  $("draft-json").value = JSON.stringify(draftSchema(), null, 2);
  $("step-draft").hidden = false;
  setStatus($("draft-status"), "");
}

async function onCopyDraft() {
  const status = $("draft-status");
  try {
    await navigator.clipboard.writeText($("draft-json").value);
    setStatus(status, "Copied. Save it into backend/schemas/ and restart the backend.");
  } catch {
    // Clipboard access can be refused; selecting the text is always available.
    $("draft-json").select();
    setStatus(status, "Select-all and copy — the clipboard was not available.", "error");
  }
}

async function onFill() {
  const status = $("fill-status");
  setStatus(status, "Filling…", "busy");
  try {
    const response = await ask({ action: "fill", plan: fillPlan(), values: fillValues() });
    if (response.refused) {
      // The matcher decided the page is not the form this schema describes.
      // A partial fill is indistinguishable from a complete one to someone
      // reviewing quickly, so nothing was written and nothing is retried.
      setStatus(status, `Nothing was filled: ${response.reason}`, "error");
    } else {
      // Said once. The report banner directly below carries this, and the two
      // sat stacked saying the same thing in different words.
      setStatus(status, "");
      // The form worked and nothing in the bank described it. Offer the
      // schema now, while the page that produced it is still in front of the
      // doctor — this is the only moment anyone can sanity-check the labels
      // against the form they are looking at.
      if (mappingLive()) showDraft();
      state.filled = true;
      updateProgress();
    }
    renderReport(response);
  } catch (error) {
    setStatus(status, error.message, "error");
  }
}

// ---------------------------------------------------------------------------

$("api-base").value = DEFAULT_API_BASE;
$("api-base").addEventListener("change", () => loadForms().then(detectForm));
$("paste").addEventListener("input", scheduleParse);
for (const id of Object.keys(DEMOGRAPHIC_FIELDS)) {
  // A hand-typed value outranks the parser from here on: re-parsing on the
  // next keystroke in the paste box must not undo a correction.
  $(id).addEventListener("input", () => {
    state.touched.add(id);
    updateFound();
  });

}
// Advance only on an explicit click — never on typing, and never because the
// insurer's page changed shape underneath.
$("name-next").addEventListener("click", () => {
  if (!$("full-name").value.trim()) {
    $("full-name").focus();
    return;
  }
  showStep("note");
});
$("note-next").addEventListener("click", () => {
  if (!$("paste").value.trim()) {
    $("paste").focus();
    return;
  }
  showStep("check");
});

// Fills the paste box only. The name is not written in: the doctor typed it
// at step 1, and "BreezeFill never guesses this one" would be a strange thing
// to say next to a button that guesses it.
$("sample-note").addEventListener("click", () => {
  $("paste").value = SAMPLE_NOTE;
  // A programmatic value assignment fires no input event, so the debounce
  // that normally parses on a pause in typing would never run.
  $("paste").dispatchEvent(new Event("input", { bubbles: true }));
});

$("map-btn").addEventListener("click", onMap);
// Leaving the check step is what seals the demographics: they are complete,
// they are the dictionary, and from here the panel's job is the page.
$("check-next").addEventListener("click", () => {
  const missing = REQUIRED_FIELDS.filter((id) => !$(id).value.trim());
  if (missing.length) {
    setStatus(
      $("check-status"),
      `Still needed: ${missing.map(labelOf).join(", ")}.`,
      "error"
    );
    $(missing[0]).focus();
    return;
  }
  setStatus($("check-status"), "");
  showStep("page");
  scanPage();
});
$("note-toggle").addEventListener("click", toggleNote);
// Passive: this only reads geometry and never cancels the scroll.
$("scroll").addEventListener("scroll", followScroll, { passive: true });
$("fill-btn").addEventListener("click", onFill);
$("draft-copy").addEventListener("click", onCopyDraft);
// Choosing from the picker names the schema whose instructions should sharpen
// this page's questions. It does not change *what* is filled — the page's own
// questions, either way — only how well each one is put to the model.
// Choosing "No form" is as deliberate as choosing one, and sets the same flag:
// a doctor who took a schema back did so because it was the wrong one, and
// re-detection putting it straight back on the next wizard step is the change
// nobody would be told about.
// Straight back to the answers, with every confirm click still on them. The
// review is never rebuilt from here — it was never taken down, only hidden.
$("back-to-review").addEventListener("click", () => showStep("page"));

$("form-id").addEventListener("change", () => {
  state.formChosenByHand = true;
  state.schema = state.forms.find((f) => f.form_id === $("form-id").value) || null;
  describeSelection(state.schema);
});
$("form-override").addEventListener("click", () => {
  $("form-id").hidden = false;
  $("form-override").hidden = true;
  // Reaching for the override is saying the automatic answer was wrong. From
  // here on detection stops re-deciding, including on the next wizard step.
  state.formChosenByHand = true;
});

// The injected script reports that the page changed shape — a wizard step
// rendered. Registered unconditionally: a panel with no granted tab simply
// never hears from anyone.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== "breezefill-panel") return undefined;
    if (message.action === "page-changed") onPageChanged();
    // Nothing is sent back, so the channel must not be held open.
    return undefined;
  });
}

updateFound();
loadForms().then(detectForm);

/**
 * Hand the shared identifier shapes to both privacy modules.
 *
 * Packaged with the extension, not fetched from the backend: a redaction rule
 * that arrives over the network is a redaction rule somebody else can replace
 * with one that matches nothing.
 *
 * If this fails, mapping is refused outright. There is no degraded mode where
 * the note goes out unredacted with a warning — a warning is a thing a busy
 * doctor clicks past, and the note cannot be recalled afterwards.
 */
async function loadPrivacy() {
  const url =
    globalThis.chrome && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL("privacy/patterns.json")
      : "../privacy/patterns.json";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`patterns.json: HTTP ${response.status}`);
  const spec = await response.json();
  breezefillParse.usePatterns(spec);
  breezefillRedact.usePatterns(spec);
}

/**
 * Whether this build is old enough that the backend refuses to talk to it.
 *
 * The one thing redacting in the browser cannot fix on its own: Chrome
 * updates an extension on Chrome's schedule, and a Web Store review takes
 * days. If a redaction bug ships there is no way to push a fix in minutes —
 * but the server can refuse the old build, and a build that cannot map cannot
 * send a note it redacted badly.
 *
 * Fails OPEN on a network error and CLOSED on an explicit answer. A backend
 * that cannot be reached must not stop a doctor working — that is a support
 * call, not a safety measure — but a backend that says "too old" is the
 * authority on the question and is believed.
 */
function olderThan(installed, minimum) {
  const parts = (value) => String(value || "0").split(".").map((n) => Number(n) || 0);
  const a = parts(installed);
  const b = parts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

async function checkVersion() {
  const manifest =
    globalThis.chrome && chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest()
      : null;
  if (!manifest) return false;
  try {
    const response = await fetch(`${apiBase()}/health`);
    if (!response.ok) return false;
    const body = await response.json();
    return olderThan(manifest.version, body.min_extension_version);
  } catch {
    return false;
  }
}

const privacyReady = loadPrivacy().catch((error) => {
  // Named on the button the doctor would press next, not in a console nobody
  // opens. `onMap` re-awaits this and refuses, so a panel in this state can
  // still be typed into and can never send anything.
  setStatus(
    $("map-status"),
    "BreezeFill cannot redact this note, so it will not send it. Reload the extension.",
    "error"
  );
  console.error("privacy modules unavailable:", error.message);
});

// Exposed for the tests, which drive this file the way the panel does rather
// than reimplementing it. Nothing else reads it, and it holds no patient data
// — the claim lives in `state`, in this document, and is gone when the panel
// closes.
globalThis.breezefillPanel = {
  onMap,
  showStep,
  // Exported for the test that discards the rows and expects the way back to
  // them to go with them, which is the one path no user gesture reaches.
  renderRows,
  onFill,
  parsePaste,
  pastedText,
  updateFound,
  patientRecord,
  detectForm,
  onPageChanged,
  scanPage,
  bestCandidate,
  fillPlan,
  draftSchema,
  readableDate,
  localise,
  loadPrivacy,
  olderThan,
  checkVersion,
  state,
};
