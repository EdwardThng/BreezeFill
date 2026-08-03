/**
 * ClaimFill side panel.
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
 * It does not have any, until the doctor clicks the ClaimFill toolbar icon on
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
// Local by default because there is currently no deployed backend —
// formfill-backend.fly.dev stopped resolving on 2026-08-03. Pointing at it
// guaranteed a "could not reach the backend" error every time the panel
// opened, which is worse than pointing at nothing. **Change this the moment a
// deploy exists**, because a doctor will not be running uvicorn.
const DEFAULT_API_BASE = "http://localhost:8000";

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
const REQUIRED_FIELDS = ["full-name", "nric", "dob", "insurer"];

const state = {
  forms: [],
  /** Whether the last /forms call failed, as opposed to returning nothing. */
  formsFailed: false,
  /** Review rows from POST /map. */
  rows: [],
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
  return readyRows().map((row) => ({ fieldId: row.field_id, label: row.label }));
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

function showPicker(message) {
  const detected = $("form-detected");
  detected.textContent = message;
  detected.classList.add("unknown");
  $("form-id").hidden = false;
  $("form-override").hidden = true;
}

/**
 * Work out which schema this page needs, instead of asking.
 *
 * Runs when the panel opens, which is immediately after the doctor clicked the
 * ClaimFill icon on this tab — so the survey is inside the access they just
 * granted, and it only reads: `survey` writes nothing.
 *
 * Failing here is not an error state. Every schema in the repo currently
 * declares no hosts, so the expected outcome today is the picker.
 */
async function detectForm() {
  if (!state.forms.length) return;

  let host;
  try {
    host = (await ask({ action: "survey", plan: [] })).host;
  } catch {
    showPicker("Could not read this page — pick the form yourself, or click the ClaimFill icon on the tab you want to fill.");
    return;
  }

  const match = state.forms.find((form) => hostMatches(host, form.hosts));
  if (!match) {
    showPicker(`No form is registered for ${host}. Pick one:`);
    return;
  }

  $("form-id").value = match.form_id;
  $("form-detected").textContent = match.insurer
    ? `${match.insurer} — ${match.display_name}`
    : match.display_name;
  $("form-detected").classList.remove("unknown");
  $("form-id").hidden = true;
  $("form-override").hidden = false;
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
    setStatus($("map-status"), UNREACHABLE, "error");
    showPicker("No forms loaded.");
    return;
  }

  select.replaceChildren();
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
  const span = $(id).closest(".field").querySelector("span");
  return (span ? span.textContent : id).toLowerCase();
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
    // One box now: the whole paste is the note. Redaction runs over all of it
    // with the demographics above as its dictionary, so the header lines come
    // back as [PATIENT] and [NRIC] like anything else.
    clinical_text: $("paste").value,
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
  if (!$("paste").value.trim()) {
    state.openedForMissing = false;
    return;
  }
  state.parseTimer = setTimeout(parsePaste, PARSE_DEBOUNCE_MS);
}

async function parsePaste() {
  let parsed;
  try {
    const response = await fetch(`${apiBase()}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: $("paste").value }),
    });
    if (!response.ok) throw new Error(String(response.status));
    parsed = await response.json();
  } catch {
    // Deliberately quiet. Parsing is an assist, not the path: the fields
    // below are still typeable, and Map reports the backend being down in
    // one place rather than two messages competing for the same line.
    $("found-summary").textContent = "Patient details — could not read the paste, fill these in";
    $("found").open = true;
    return;
  }

  for (const [id, key] of Object.entries(DEMOGRAPHIC_FIELDS)) {
    if (state.touched.has(id)) continue;
    const value = parsed[key];
    $(id).value = value == null ? "" : value;
  }
  updateFound();
}

/**
 * Say what was found and what is still missing.
 *
 * The drawer opens itself when something required is absent, but only once
 * per paste — re-opening it on every keystroke would fight the doctor who
 * just closed it.
 */
function updateFound() {
  const ids = Object.keys(DEMOGRAPHIC_FIELDS);
  const found = ids.filter((id) => $(id).value.trim()).length;
  const missing = REQUIRED_FIELDS.filter((id) => !$(id).value.trim());

  $("found-summary").textContent = missing.length
    ? `Patient details — ${missing.map(labelOf).join(", ")} still needed`
    : `Patient details — ${found} of ${ids.length} found`;

  if (missing.length && !state.openedForMissing) {
    $("found").open = true;
    state.openedForMissing = true;
  }
}

// A network throw carries no status code — the request never reached a
// server, or reached one whose 500 came out of Starlette's error handler,
// which sits outside the CORS middleware and so answers with no
// Access-Control headers at all. Either way the browser hands us a bare
// TypeError: "Failed to fetch", which no doctor can act on.
const UNREACHABLE =
  "Could not reach the backend. Check it is running, then check the URL under Advanced.";

function messageFor(error) {
  return error instanceof TypeError ? UNREACHABLE : error.message || "Mapping failed.";
}

async function onMap() {
  const status = $("map-status");

  // The form list is loaded once, when the panel opens. A backend started
  // afterwards used to mean an empty picker and a 404 on a "" form id until
  // the panel was reopened — so try again here rather than making the doctor
  // work that out.
  if (!state.forms.length) {
    await loadForms();
    await detectForm();
  }
  if (!state.forms.length) {
    setStatus(
      status,
      state.formsFailed ? UNREACHABLE : "The backend is running but has no forms loaded.",
      "error"
    );
    return;
  }
  if (!$("form-id").value) {
    setStatus(status, "Pick the insurer form first.", "error");
    return;
  }

  let patient;
  try {
    patient = patientRecord();
  } catch (error) {
    setStatus(status, error.message, "error");
    return;
  }

  $("map-btn").disabled = true;
  setStatus(status, "Redacting and mapping…", "busy");

  try {
    const response = await fetch(`${apiBase()}/map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form_id: $("form-id").value, patient }),
    });
    if (!response.ok) {
      // Fixed strings keyed on status, never the response body: the backend
      // keeps clinical text out of its own errors and echoing an uninspected
      // body would reintroduce it.
      throw new Error(
        {
          502: "The model call failed.",
          503: "The backend has no API key. Set ANTHROPIC_API_KEY in the terminal running it, then restart it.",
          404: "The backend does not know this form. Restart it if you have just added one.",
        }[response.status] || `Request failed (${response.status}).`
      );
    }
    const body = await response.json();
    state.rows = body.fields;
    state.edited.clear();
    state.confirmed.clear();
    renderRows();
    $("step-review").hidden = false;
    $("step-fill").hidden = false;
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

function renderRow(row) {
  const confirmed = state.confirmed.has(row.field_id);
  const pending = row.needs_review && !confirmed && hasValue(row);

  const wrap = document.createElement("div");
  wrap.className = "review-row" + (pending ? " pending" : "") + (confirmed ? " confirmed" : "");

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

  let input;
  if (row.field_type === "checkbox") {
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
    updateFillButton();
    wrap.classList.remove("pending");
    wrap.classList.add("confirmed");
  });
  wrap.append(input);

  if (row.needs_review && !confirmed && hasValue(row)) {
    const button = document.createElement("button");
    button.className = "confirm";
    button.type = "button";
    button.textContent = "Confirm";
    button.addEventListener("click", () => {
      state.confirmed.add(row.field_id);
      renderRows();
      updateFillButton();
    });
    wrap.append(button);
  }

  return wrap;
}

function renderRows() {
  const container = $("rows");
  container.replaceChildren(...state.rows.map(renderRow));

  const pending = state.rows.filter(
    (r) => r.needs_review && hasValue(r) && !state.confirmed.has(r.field_id)
  ).length;
  const summary = pending
    ? `${pending} value${pending === 1 ? "" : "s"} still to confirm. Nothing is written until you do.`
    : `${readyRows().length} of ${state.rows.length} fields ready to write. The rest are for you to complete by hand.`;
  $("review-summary").textContent = summary;
  updateFillButton();
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
      "ClaimFill has no access to this tab. Click the ClaimFill icon in the toolbar while this page is open, then try again."
    );
  }
  const response = await chrome.tabs.sendMessage(tabId, { target: "claimfill-content", ...message });
  if (!response || !response.ok) throw new Error("The page did not respond.");
  return response;
}

function renderReport(response) {
  const container = $("fill-report");
  container.replaceChildren();

  const list = document.createElement("ul");
  const byId = new Map(state.rows.map((r) => [r.field_id, r]));

  for (const result of response.report.results) {
    const item = document.createElement("li");
    const row = byId.get(result.fieldId);
    const name = row ? row.label : result.fieldId;
    const applied = (response.applied || []).find((a) => a.fieldId === result.fieldId);
    const outcome = applied ? applied.status : result.status;
    item.textContent = `${name} — ${outcome}`;
    list.append(item);
  }
  container.append(list);

  // Live controls no schema field claimed. Surfaced rather than hidden: this
  // is how a portal that grew a question becomes visible, and it is the input
  // to extending the schema. The doctor fills these by hand today.
  if (response.report.unknownControls.length) {
    const heading = document.createElement("p");
    heading.className = "note";
    heading.textContent = "Fields on this page ClaimFill does not know about — fill these yourself:";
    container.append(heading);

    const unknown = document.createElement("ul");
    unknown.className = "unknown";
    for (const control of response.report.unknownControls) {
      const item = document.createElement("li");
      item.textContent = control.label || `(unlabelled ${control.type})`;
      unknown.append(item);
    }
    container.append(unknown);
  }
}

async function onCheck() {
  const status = $("fill-status");
  setStatus(status, "Reading the page…", "busy");
  try {
    const plan = fillPlan();
    const response = await ask({ action: "survey", plan });

    // Nothing mapped yet: this is a connectivity check, not a match check.
    // Reporting "matched 0 of 0, will not fill" would read as a failure when
    // it is actually the answer "yes, I can see this page".
    if (!plan.length) {
      setStatus(
        status,
        `Connected to ${response.host}. Found ${response.controlCount} fillable field${response.controlCount === 1 ? "" : "s"}. Map a note to see which ones match.`
      );
      $("fill-report").replaceChildren();
      return;
    }

    const { matched, intended, safeToFill } = response.report;
    setStatus(
      status,
      safeToFill
        ? `Matched ${matched} of ${intended} fields on ${response.host}.`
        : `Only matched ${matched} of ${intended} fields on ${response.host}. ClaimFill will not fill a page it does not recognise.`,
      safeToFill ? null : "error"
    );
    renderReport({ ...response, applied: [] });
  } catch (error) {
    setStatus(status, error.message, "error");
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
      setStatus(status, `Filled ${response.filled} field${response.filled === 1 ? "" : "s"}. Check each one, then submit the form yourself.`);
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
$("map-btn").addEventListener("click", onMap);
$("check-btn").addEventListener("click", onCheck);
$("fill-btn").addEventListener("click", onFill);
$("form-override").addEventListener("click", () => {
  $("form-id").hidden = false;
  $("form-override").hidden = true;
});

updateFound();
loadForms().then(detectForm);

// Exposed for the tests, which drive this file the way the panel does rather
// than reimplementing it. Nothing else reads it, and it holds no patient data
// — the claim lives in `state`, in this document, and is gone when the panel
// closes.
globalThis.claimfillPanel = { onMap, parsePaste, updateFound, patientRecord, state };
