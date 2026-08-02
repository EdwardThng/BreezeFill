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
const DEFAULT_API_BASE = "https://formfill-backend.fly.dev";

// Order matters: the orchestrator expects the other three to have registered
// themselves on globalThis by the time it runs.
const INJECT_FILES = [
  "learn/dump.js",
  "fill/locate.js",
  "fill/apply.js",
  "content/fill.js",
];

const state = {
  forms: [],
  /** Review rows from POST /map. */
  rows: [],
  /** field_id -> doctor's value, when they have changed one. */
  edited: new Map(),
  /** field_ids the doctor has explicitly confirmed. */
  confirmed: new Set(),
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

async function loadForms() {
  const select = $("form-id");
  try {
    const response = await fetch(`${apiBase()}/forms`);
    if (!response.ok) throw new Error(String(response.status));
    state.forms = await response.json();
  } catch {
    setStatus($("map-status"), "Could not reach the backend. Check the URL under Advanced.", "error");
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

function patientRecord() {
  const record = {
    full_name: $("full-name").value.trim(),
    nric: $("nric").value.trim(),
    dob: $("dob").value,
    phone: $("phone").value.trim() || null,
    address: $("address").value.trim() || null,
    policy_number: $("policy-number").value.trim() || null,
    insurer: $("insurer").value.trim(),
    clinical_text: $("clinical-text").value,
  };

  const missing = ["full_name", "nric", "dob", "insurer", "clinical_text"].filter(
    (key) => !record[key]
  );
  // Names the empty fields, never their contents.
  if (missing.length) throw new Error(`Fill in: ${missing.join(", ").replace(/_/g, " ")}`);
  return record;
}

async function onMap() {
  const status = $("map-status");
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
      // The backend keeps clinical text out of its own errors; do not
      // reintroduce it by echoing a body we have not inspected.
      throw new Error(response.status === 502 ? "The model call failed." : `Request failed (${response.status}).`);
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
    setStatus(status, error.message || "Mapping failed.", "error");
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
$("api-base").addEventListener("change", loadForms);
$("map-btn").addEventListener("click", onMap);
$("check-btn").addEventListener("click", onCheck);
$("fill-btn").addEventListener("click", onFill);
loadForms();
