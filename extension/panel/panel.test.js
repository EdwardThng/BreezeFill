/**
 * @vitest-environment jsdom
 *
 * Tests for the side panel.
 *
 * This file had none until now, and it is where the 2026-08-03 demo failed:
 * not in the pipeline, not in the matcher, but in a status line that
 * overwrote the one actionable message on screen with "Failed to fetch". The
 * first block below is that failure, pinned.
 *
 * panel.js runs on load against the real panel.html — no reimplemented DOM,
 * because a fixture that drifts from the markup would pass while the panel
 * broke. It is a classic script, not a module, so it is read and evaluated
 * rather than imported, and it hands back its entry points on globalThis the
 * way dump.js does.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = readFileSync(resolve(HERE, "panel.html"), "utf8");
const PANEL_JS = readFileSync(resolve(HERE, "panel.js"), "utf8");

const FORMS = [
  {
    form_id: "roboform_test_v1",
    display_name: "RoboForm test page",
    insurer: "Test",
    hosts: ["roboform.com"],
    // `source` is what /forms really returns, and it matters here: only llm
    // fields have an instruction to lend a control. Demographics are copied
    // deterministically and never reach the model.
    fields: [
      { id: "full_name", label: "Full Name", source: "demographics.full_name" },
      { id: "nric", label: "Social Security Number", source: "demographics.nric" },
      { id: "phone", label: "Home Phone", source: "demographics.phone" },
    ],
  },
  {
    form_id: "aia_ghs_claim",
    display_name: "Group H&S claim",
    insurer: "AIA",
    hosts: [],
    fields: [
      { id: "diagnosis", label: "Diagnosis of all conditions treated", source: "llm" },
      { id: "icd", label: "ICD-10 Code", source: "llm" },
      { id: "admitted", label: "Date of admission", source: "llm" },
    ],
  },
];

const PARSED = {
  full_name: "Chua Beng Huat",
  nric: "S7211043C",
  dob: "1972-11-04",
  phone: "91112233",
  address: "18 Toa Payoh Lorong 4, Singapore 310018",
  policy_number: "GHS-4471902",
  insurer: null,
  sources: { full_name: "patient-line" },
};

/** Backend responses, keyed by the path being called. */
let routes;
/** What the injected script answers, per action. */
let page;
/** The panel's chrome.runtime.onMessage handler, once it registers one. */
let pageListener;

const EMPTY_REPORT = {
  results: [],
  unknownControls: [],
  matched: 0,
  intended: 0,
  matchRate: 0,
  safeToFill: false,
};

// What the injected script reports back about the questions on the page. The
// join to a schema's instructions has already happened in the page by this
// point, so a described control arrives carrying a `description` and the
// schema's wording, and an undescribed one carries the page's own.
const LIVE_FIELDS = [
  { label: "Diagnosis of all conditions treated", type: "text", options: [], description: null },
  { label: "Date of admission", type: "date", options: [], description: null },
];

function respond(body, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

function loadPanel() {
  document.documentElement.innerHTML = PANEL_HTML;
  // The panel never reads a tab's address, but it does ask the injected
  // script to survey the page. Nothing here grants it access.
  globalThis.chrome = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1 }]),
      sendMessage: vi.fn((_tabId, message) =>
        Promise.resolve(page[message.action] || { ok: false })
      ),
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
    // The injected script reports a wizard step rendering through here. The
    // listener is captured so a test can deliver a message the way Chrome
    // would, rather than calling the handler directly.
    runtime: {
      onMessage: {
        addListener: vi.fn((fn) => {
          pageListener = fn;
        }),
      },
    },
  };
  // eslint-disable-next-line no-eval
  (0, eval)(PANEL_JS);
  return globalThis.breezefillPanel;
}

const $ = (id) => document.getElementById(id);

/** Let the microtask queue drain, so an awaited fetch settles. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Shut the details drawer, and reset the flag that lets it reopen itself.
 *
 * Any test asserting the drawer OPENS has to come through here first. The
 * drawer is `<details ... open>` in panel.html, so `expect(open).toBe(true)`
 * on a freshly loaded panel passes whatever the code does — it was already
 * open. Clearing the paste is what resets `openedForMissing` (see
 * `scheduleParse`), and without that reset the drawer deliberately stays shut,
 * because it opens itself once per paste and not once per keystroke.
 *
 * The sequence is also the real one: the doctor closed it, then pasted a note.
 */
function shutDrawer() {
  $("paste").value = "";
  $("paste").dispatchEvent(new Event("input", { bubbles: true }));
  $("found").open = false;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  routes = {
    "/forms": () => respond(FORMS),
    "/parse": () => respond(PARSED),
    "/map-live": () => respond({ form_id: "__live__", fields: [] }),
    "/map": () => respond({ form_id: "roboform_test_v1", fields: [] }),
  };
  // A page nothing in the bank recognises, which is the interesting default:
  // it is what an insurer portal looks like on the first visit. It still has
  // questions on it, and answering those is now the whole job — so the survey
  // hands back liveFields whether or not a schema was recognised.
  page = {
    survey: {
      ok: true,
      host: "portal.example.com",
      controlCount: 4,
      report: EMPTY_REPORT,
      candidates: [],
      liveFields: LIVE_FIELDS,
    },
    fill: { ok: true, refused: false, filled: 0, applied: [], report: EMPTY_REPORT },
  };
  globalThis.fetch = vi.fn((url) => {
    const path = Object.keys(routes).find((p) => String(url).endsWith(p));
    return path ? routes[path](url) : respond({}, false, 404);
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.breezefillPanel;
});

// ---------------------------------------------------------------------------
// The demo failure
// ---------------------------------------------------------------------------

describe("when the backend is not running", () => {
  test("Map says so, rather than reporting a bare TypeError", async () => {
    // The whole backend, not just the form list: an unreachable /forms alone
    // no longer stops anything, since the page's own questions are still
    // answerable without the bank.
    routes["/forms"] = () => Promise.reject(new TypeError("Failed to fetch"));
    routes["/map-live"] = () => Promise.reject(new TypeError("Failed to fetch"));
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    await panel.onMap();

    // The browser's own wording is what the doctor saw last time, and there
    // is nothing they can do with it.
    expect($("map-status").textContent).not.toContain("Failed to fetch");
    expect($("map-status").textContent).toContain("Could not reach the backend");
  });

  test("a bank that will not load costs sharpness, not the fill", async () => {
    // The change in posture, asserted. Without /forms there are no schema
    // instructions to enrich with — and the questions on the page are still
    // there, so they are still mapped.
    routes["/forms"] = () => Promise.reject(new TypeError("Failed to fetch"));
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    await panel.onMap();

    const call = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-live"));
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body).fields).toHaveLength(LIVE_FIELDS.length);
  });

  test("a backend started after the panel opened does not need it reopened", async () => {
    // The form list loads once, on open. When that failed the bank stayed
    // empty for the whole session, so every later claim lost its instructions
    // until the panel was closed and opened again — which nobody would guess.
    routes["/forms"] = () => Promise.reject(new TypeError("Failed to fetch"));
    const panel = loadPanel();
    await settle();
    expect($("form-id").options).toHaveLength(0);

    routes["/forms"] = () => respond(FORMS);
    $("paste").value = "Patient: Chua Beng Huat";
    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    await panel.onMap();

    // The bank, plus the standing "No form" entry.
    expect($("form-id").options).toHaveLength(FORMS.length + 1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/map-live"),
      expect.anything()
    );
  });

  test("a page with no questions on it says so, instead of posting nothing", async () => {
    // Replaces the old "never posts an empty form id" guard. There is no form
    // id to post any more, but the same class of mistake is available: sending
    // a mapping call for a page the panel could not read. The likeliest cause
    // is the doctor clicking the icon on the wrong tab, so the message says
    // that rather than blaming the backend.
    page.survey = { ...page.survey, liveFields: [] };
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    await panel.onMap();

    const mapped = globalThis.fetch.mock.calls.some((c) => String(c[0]).endsWith("/map-live"));
    expect(mapped).toBe(false);
    expect($("map-status").textContent).toMatch(/no fillable questions/i);
    expect($("map-status").textContent).not.toContain("Could not reach");
  });

  test("a failed parse does not overwrite the Map status line", async () => {
    // Two messages competing for one element is how the actionable one got
    // destroyed. The parse reports itself in the drawer instead.
    routes["/parse"] = () => Promise.reject(new TypeError("Failed to fetch"));
    const panel = loadPanel();
    await settle();

    $("map-status").textContent = "something the doctor needs to read";
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    expect($("map-status").textContent).toBe("something the doctor needs to read");
    expect($("found-summary").textContent).toContain("could not read the paste");
  });
});

// ---------------------------------------------------------------------------
// One box in, fields out
// ---------------------------------------------------------------------------

describe("reading the paste", () => {
  test("parsed values land in their fields", async () => {
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat · S7211043C · 04/11/1972";
    await panel.parsePaste();

    expect($("full-name").value).toBe("Chua Beng Huat");
    expect($("nric").value).toBe("S7211043C");
    // ISO, because that is what <input type="date"> accepts. A DD/MM/YYYY
    // string would silently leave the control blank.
    expect($("dob").value).toBe("1972-11-04");
    expect($("policy-number").value).toBe("GHS-4471902");
  });

  test("a correction survives the next parse", async () => {
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    $("full-name").value = "Chua Beng Huat Jr";
    $("full-name").dispatchEvent(new Event("input", { bubbles: true }));
    await panel.parsePaste();

    expect($("full-name").value).toBe("Chua Beng Huat Jr");
  });

  test("the drawer opens itself when something required is missing", async () => {
    const panel = loadPanel();
    await settle();
    shutDrawer();

    // Date of birth is required and this response has none: there is no
    // pattern rule for a bare date, so a missing one stays in the text sent
    // to the model. A name is the same case for the same reason.
    routes["/parse"] = () => respond({ ...PARSED, dob: null });
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    expect($("found").open).toBe(true);
    expect($("found-summary").textContent).toContain("date of birth");
  });

  test("a missing insurer does not block — it plays no part in redaction", async () => {
    // `insurer` was required and should not have been. redaction.py pass 1
    // never reads it; it exists only because some forms have a box for it, and
    // stopping a doctor over an insurer their form never asks about demands
    // something the product does not need.
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    expect($("insurer").value).toBe("");
    expect($("found-summary").textContent).not.toContain("Insurer");
    expect(() => panel.patientRecord()).not.toThrow();
  });

  test("the drawer does not reopen itself once the doctor closes it", async () => {
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();
    $("found").open = false;
    await panel.parsePaste();

    expect($("found").open).toBe(false);
  });

  test("typing pauses before the paste is parsed", async () => {
    loadPanel();
    await settle();
    globalThis.fetch.mockClear();

    $("paste").value = "Pat";
    $("paste").dispatchEvent(new Event("input", { bubbles: true }));
    $("paste").value = "Patient: Chua Beng Huat";
    $("paste").dispatchEvent(new Event("input", { bubbles: true }));

    await vi.advanceTimersByTimeAsync(500);

    const parses = globalThis.fetch.mock.calls.filter((c) => String(c[0]).endsWith("/parse"));
    expect(parses).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Which form is this?
// ---------------------------------------------------------------------------

describe("identifying the form", () => {
  const scored = (scores) => {
    page.survey = { ...page.survey, candidates: scores };
  };

  test("the best-fitting schema is chosen and the picker stays out of the way", async () => {
    scored([
      { formId: "aia_ghs_claim", matched: 3, intended: 3, matchRate: 1 },
      { formId: "roboform_test_v1", matched: 0, intended: 3, matchRate: 0 },
    ]);
    loadPanel();
    await settle();

    expect($("form-id").value).toBe("aia_ghs_claim");
    expect($("form-detected").textContent).toContain("Group H&S claim");
    expect($("form-id").hidden).toBe(true);
  });

  test("two schemas fitting equally well is not a winner", async () => {
    // Same insurer, several forms, overlapping questions. Guessing between
    // them would attach the wrong instruction to a question — worse than
    // attaching none, because the model would then confidently answer a
    // different question than the one on screen.
    scored([
      { formId: "aia_ghs_claim", matched: 3, intended: 3, matchRate: 1 },
      { formId: "roboform_test_v1", matched: 3, intended: 3, matchRate: 1 },
    ]);
    const panel = loadPanel();
    await settle();

    expect(panel.state.schema).toBeNull();
    // ...and it is not reported as a failure, because nothing failed: the
    // page's questions are still what gets answered.
    expect($("form-detected").textContent).toMatch(/reading the questions/i);
  });

  test("a thin match still counts, because a wizard shows one step at a time", async () => {
    // Identification is looser than filling on purpose: the right schema may
    // only find a third of its fields on the step in front of us. Whatever is
    // picked still has to clear the fill guards before anything is written.
    scored([{ formId: "aia_ghs_claim", matched: 3, intended: 7, matchRate: 0.43 }]);
    loadPanel();
    await settle();

    expect($("form-id").value).toBe("aia_ghs_claim");
  });

  test("a match too thin to mean anything does not count", async () => {
    scored([{ formId: "aia_ghs_claim", matched: 2, intended: 24, matchRate: 0.08 }]);
    const panel = loadPanel();
    await settle();

    expect(panel.state.schema).toBeNull();
    expect($("form-detected").textContent).toMatch(/reading the questions/i);
  });

  test("the host registered for a form wins when nothing scores", async () => {
    page.survey = { ...page.survey, host: "roboform.com", candidates: [] };
    loadPanel();
    await settle();

    expect($("form-id").value).toBe("roboform_test_v1");
  });

  test("schemas are scored by their own field labels", async () => {
    loadPanel();
    await settle();

    const [, message] = globalThis.chrome.tabs.sendMessage.mock.calls[0];
    // `step` rides along so a wizard schema can be scored against the step on
    // screen instead of against fields that are not in the DOM. Empty for a
    // form that shows everything at once, which is all of them today.
    expect(message.candidates).toEqual([
      {
        formId: "roboform_test_v1",
        fields: [
          { fieldId: "full_name", label: "Full Name", step: "" },
          { fieldId: "nric", label: "Social Security Number", step: "" },
          { fieldId: "phone", label: "Home Phone", step: "" },
        ],
      },
      {
        formId: "aia_ghs_claim",
        fields: [
          { fieldId: "diagnosis", label: "Diagnosis of all conditions treated", step: "" },
          { fieldId: "icd", label: "ICD-10 Code", step: "" },
          { fieldId: "admitted", label: "Date of admission", step: "" },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The form nobody has a schema for
// ---------------------------------------------------------------------------

// The bank stopped being a gate on 2026-08-05. The doctor has to submit the
// form on their screen whatever the bank knows about it, so what a schema
// match changes is how well each question is put to the model — never whether
// the questions are attempted.

describe("mapping the page in front of the doctor", () => {
  async function readyPanel() {
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));
    return panel;
  }

  test("the page's questions are posted, with no form id", async () => {
    const panel = await readyPanel();
    await panel.onMap();

    const call = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-live"));
    expect(call).toBeTruthy();
    const sent = JSON.parse(call[1].body);
    expect(sent.fields).toEqual([
      { label: "Diagnosis of all conditions treated", type: "text", options: [], description: null },
      { label: "Date of admission", type: "date", options: [], description: null },
    ]);
    expect(sent.form_id).toBeUndefined();
  });

  test("a recognised page maps the same way, and still posts no form id", async () => {
    // The behaviour change that matters. A schema match used to switch routes
    // entirely; now it only decides what instructions ride along.
    page.survey = {
      ...page.survey,
      candidates: [{ formId: "aia_ghs_claim", matched: 3, intended: 3, matchRate: 1 }],
    };
    const panel = await readyPanel();
    expect(panel.state.schema.form_id).toBe("aia_ghs_claim");

    await panel.onMap();

    const called = globalThis.fetch.mock.calls.map((c) => String(c[0]));
    expect(called.some((u) => u.endsWith("/map-live"))).toBe(true);
    expect(called.some((u) => u.endsWith("/map"))).toBe(false);
  });

  test("the matched schema's instructions are sent to the page to join", async () => {
    // The join happens in the page, so the schema's descriptions reach the
    // controls without page structure being sent anywhere to arrange it.
    page.survey = {
      ...page.survey,
      candidates: [{ formId: "aia_ghs_claim", matched: 3, intended: 3, matchRate: 1 }],
    };
    const panel = await readyPanel();
    await panel.onMap();

    const [, message] = globalThis.chrome.tabs.sendMessage.mock.calls
      .filter(([, m]) => m.action === "survey")
      .pop();
    expect(message.enrichWith).toEqual([
      { fieldId: "diagnosis", label: "Diagnosis of all conditions treated", description: null, options: [] },
      { fieldId: "icd", label: "ICD-10 Code", description: null, options: [] },
      { fieldId: "admitted", label: "Date of admission", description: null, options: [] },
    ]);
  });

  test("an unrecognised page sends nothing to join against", async () => {
    const panel = await readyPanel();
    await panel.onMap();

    const [, message] = globalThis.chrome.tabs.sendMessage.mock.calls
      .filter(([, m]) => m.action === "survey")
      .pop();
    expect(message.enrichWith).toEqual([]);
  });

  test("a refusal the backend explained is not shown as a bare status code", async () => {
    // What a tester actually saw: "Request failed (422)", from a backend that
    // knew precisely what was wrong. Both refusals are now keyed on the status
    // — never the body, because FastAPI's own 422 quotes the input, and the
    // input here carries the clinical note.
    for (const [status, expected] of [
      [413, /more questions than BreezeFill can map/i],
      [422, /could not read any questions/i],
    ]) {
      routes["/map-live"] = () => respond({ detail: "..." }, false, status);
      const panel = await readyPanel();
      await panel.onMap();

      expect($("map-status").textContent).toMatch(expected);
      expect($("map-status").textContent).not.toMatch(/request failed/i);
    }
  });

  test("picking a schema by hand names the instructions to use", async () => {
    const panel = await readyPanel();
    expect(panel.state.schema).toBeNull();

    $("form-id").value = "aia_ghs_claim";
    $("form-id").dispatchEvent(new Event("change", { bubbles: true }));

    expect(panel.state.schema.form_id).toBe("aia_ghs_claim");
    // ...and detection stops overruling it from here on.
    expect(panel.state.formChosenByHand).toBe(true);
  });

  test("a schema picked by hand can be taken back again", async () => {
    // There was no way out of the picker: a <select> has no empty state, so
    // once a doctor named a form the panel kept using its instructions for a
    // page they had decided it did not describe. Answering from the page's own
    // wording is a worse-informed fill, not a broken one, and it has to be
    // reachable.
    const panel = await readyPanel();

    $("form-id").value = "aia_ghs_claim";
    $("form-id").dispatchEvent(new Event("change", { bubbles: true }));
    expect(panel.state.schema.form_id).toBe("aia_ghs_claim");

    $("form-id").value = "";
    $("form-id").dispatchEvent(new Event("change", { bubbles: true }));

    expect(panel.state.schema).toBeNull();
    expect($("form-detected").textContent).toMatch(/reading the questions/i);
    // Still a human decision, so re-detection on the next wizard step must not
    // put the schema back.
    expect(panel.state.formChosenByHand).toBe(true);
  });

  test("the sentence above the picker follows what was picked", async () => {
    // It used to describe whatever detection last decided, so a doctor who
    // overrode it read "Reading the questions on this page" above a select
    // naming an insurer's form — two answers to one question.
    const panel = await readyPanel();

    $("form-id").value = "aia_ghs_claim";
    $("form-id").dispatchEvent(new Event("change", { bubbles: true }));

    expect($("form-detected").textContent).toContain("Group H&S claim");
  });

  test("no schema means the picker shows no schema", async () => {
    // The control and the state have to agree. With the first form standing
    // selected by default, the panel said a form was in use and mapped without
    // one, and the disagreement is invisible until the answers come back thin.
    const panel = await readyPanel();

    expect(panel.state.schema).toBeNull();
    expect($("form-id").value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Growing the bank
// ---------------------------------------------------------------------------

describe("the draft schema", () => {
  const ROWS = [
    { field_id: "diagnosis_of_all_conditions_treated", label: "Diagnosis of all conditions treated", field_type: "text", help: "Diagnosis of all conditions treated", value: "Appendicitis", needs_review: false, status: "extracted" },
    { field_id: "date_of_admission", label: "Date of admission", field_type: "date", help: null, value: "14/03/2026", needs_review: false, status: "extracted" },
  ];

  async function filledLive() {
    page.survey = { ...page.survey, host: "claimez.aia.com.sg", candidates: [] };
    const panel = loadPanel();
    await settle();
    panel.state.rows = ROWS;
    panel.state.host = "claimez.aia.com.sg";
    return panel;
  }

  test("it describes the form, and says where it came from", async () => {
    const panel = await filledLive();
    const draft = panel.draftSchema();

    expect(draft.fill_mode).toBe("web");
    // The full host, not a guess at the registrable domain. "The last two
    // labels" of a Singapore host is "com.sg", and hostMatches() matches
    // subdomains — that schema would claim every .com.sg site there is.
    expect(draft.hosts).toEqual(["claimez.aia.com.sg"]);
    // The insurer name is guessed past the suffixes, which is safe: it is a
    // display string whoever commits the schema will edit.
    expect(draft.insurer).toBe("AIA");
    // The name is a guess off the host and has to be corrected by whoever
    // commits it, so the draft says so rather than looking authoritative.
    expect(draft.display_name).toMatch(/rename me/i);
    expect(draft.fields).toEqual([
      {
        id: "diagnosis_of_all_conditions_treated",
        label: "Diagnosis of all conditions treated",
        type: "text",
        source: "llm",
        description: "Diagnosis of all conditions treated",
      },
      {
        id: "date_of_admission",
        label: "Date of admission",
        type: "date",
        source: "llm",
        description: "Date of admission",
      },
    ]);
  });

  test("every field is described, not just the ones this note answered", async () => {
    const panel = await filledLive();
    panel.state.rows = [...ROWS, { field_id: "icd_10_code", label: "ICD-10 Code", field_type: "text", help: null, value: null, status: "missing", needs_review: true }];
    // A schema describes the form. Dropping the blanks would mean the next
    // claim, with a fuller note, could not fill the fields this one missed.
    expect(panel.draftSchema().fields).toHaveLength(3);
  });

  test("it appears after a schema-free fill, and not before", async () => {
    const panel = await filledLive();
    expect($("step-draft").hidden).toBe(true);

    page.fill = { ok: true, refused: false, filled: 2, applied: [], report: EMPTY_REPORT };
    await panel.onFill();

    expect($("step-draft").hidden).toBe(false);
    expect(JSON.parse($("draft-json").value).fields).toHaveLength(2);
  });

  test("a refused fill produces no draft", async () => {
    // Nothing was written, so nothing was confirmed against the real page.
    // A schema drafted from a page we could not fill is a guess about a form
    // nobody has seen work.
    const panel = await filledLive();
    page.fill = { ok: true, refused: true, reason: "the page does not match", filled: 0, applied: [], report: EMPTY_REPORT };
    await panel.onFill();

    expect($("step-draft").hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The whole loop
// ---------------------------------------------------------------------------

describe("a form the bank does not have, end to end", () => {
  // The flow as specified: fill in the details, check the bank, and when the
  // form is not there, fill the page anyway and come back with a schema for
  // next time. The pieces are unit-tested above; this walks the whole path in
  // one go, because the failures that matter are at the joins.
  const CONTROLS = [
    { ref: "c1", label: "Patient's Full Name", type: "text" },
    { ref: "c2", label: "Diagnosis of all conditions treated", type: "text" },
    { ref: "c3", label: "Date of admission", type: "date" },
    { ref: "c4", label: "ICD-10 Code", type: "text" },
  ];

  const ROWS = [
    { field_id: "patient_s_full_name", label: "Patient's Full Name", field_type: "text", help: "Patient's Full Name", value: "Chua Beng Huat", status: "demographic", needs_review: false },
    { field_id: "diagnosis_of_all_conditions_treated", label: "Diagnosis of all conditions treated", field_type: "text", help: "Diagnosis of all conditions treated", value: "Acute appendicitis", status: "extracted", needs_review: false },
    { field_id: "date_of_admission", label: "Date of admission", field_type: "date", help: "Date of admission", value: "14/03/2026", status: "inferred", needs_review: true },
    { field_id: "icd_10_code", label: "ICD-10 Code", field_type: "text", help: "ICD-10 Code", value: null, status: "missing", needs_review: true },
  ];

  test("bank miss -> map the page -> fill -> get a schema back", async () => {
    page.survey = {
      ok: true,
      host: "portal.someinsurer.com",
      controlCount: 4,
      candidates: [
        // Both schemas in the bank score far too low to be this form.
        { formId: "roboform_test_v1", matched: 0, intended: 3, matchRate: 0 },
        { formId: "aia_ghs_claim", matched: 1, intended: 3, matchRate: 0.33 },
      ],
      report: { ...EMPTY_REPORT, unknownControls: CONTROLS },
      liveFields: CONTROLS.map((c) => ({
        label: c.label,
        type: c.type,
        options: [],
        description: null,
      })),
    };
    routes["/map-live"] = () => respond({ form_id: "__live__", fields: ROWS });

    const panel = loadPanel();
    await settle();

    // 1. The bank was consulted and had nothing that fits — which is not a
    //    stopping point, only the absence of sharper instructions.
    expect(panel.state.schema).toBeNull();
    expect($("form-detected").textContent).toMatch(/reading the questions/i);

    // 2. The details go in as one paste.
    $("paste").value = "Patient: Chua Beng Huat · S7211043C · 04/11/1972\n14/03/2026. RIF pain, appendicitis.";
    await panel.parsePaste();
    expect($("full-name").value).toBe("Chua Beng Huat");
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));

    // 3. Mapping goes against the page, because there is no schema to use.
    await panel.onMap();
    const mapCall = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-live"));
    expect(JSON.parse(mapCall[1].body).fields.map((f) => f.label)).toEqual(
      CONTROLS.map((c) => c.label)
    );
    expect($("step-review").hidden).toBe(false);

    // 4. The inferred row still has to be confirmed by hand — the fallback
    //    does not get to skip the review step just because it had no schema.
    //    Driven through the rendered UI, not by poking state, because the
    //    guarantee is what the doctor has to click.
    expect($("fill-btn").disabled).toBe(true);
    const confirmButtons = $("rows").querySelectorAll("button.confirm");
    // One button: the inferred admission date. The missing ICD code has no
    // value, so there is nothing to confirm and nothing to write.
    expect(confirmButtons).toHaveLength(1);
    confirmButtons[0].click();
    expect($("fill-btn").disabled).toBe(false);

    // 5. Fill the page.
    page.fill = { ok: true, refused: false, filled: 3, applied: [], report: EMPTY_REPORT };
    await panel.onFill();
    expect($("fill-status").textContent).toMatch(/filled 3 field/i);

    // 6. And the form comes back as a schema for the bank.
    expect($("step-draft").hidden).toBe(false);
    const draft = JSON.parse($("draft-json").value);
    expect(draft.fill_mode).toBe("web");
    expect(draft.hosts).toEqual(["portal.someinsurer.com"]);
    expect(draft.fields.map((f) => f.label)).toEqual(CONTROLS.map((c) => c.label));
    // Including the one this note could not answer: the schema describes the
    // form, not this claim.
    expect(draft.fields.map((f) => f.id)).toContain("icd_10_code");
  });

  test("a form the bank already describes is not drafted again", async () => {
    page.survey = {
      ok: true,
      host: "roboform.com",
      controlCount: 39,
      candidates: [{ formId: "roboform_test_v1", matched: 3, intended: 3, matchRate: 1 }],
      report: EMPTY_REPORT,
      liveFields: LIVE_FIELDS,
    };
    const panel = loadPanel();
    await settle();

    expect($("form-id").value).toBe("roboform_test_v1");
    expect(panel.state.schema.form_id).toBe("roboform_test_v1");

    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));
    await panel.onMap();

    page.fill = { ok: true, refused: false, filled: 2, applied: [], report: EMPTY_REPORT };
    await panel.onFill();

    // A recognised page is mapped the same way as any other — what the match
    // bought was the instructions, not a different route.
    const paths = globalThis.fetch.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.endsWith("/map-live"))).toBe(true);
    // No draft: the bank already describes this form, and a second schema for
    // it is how two descriptions of one form start disagreeing.
    expect($("step-draft").hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What gets sent
// ---------------------------------------------------------------------------

describe("the record posted to /map", () => {
  test("the whole paste is the clinical text", async () => {
    const panel = loadPanel();
    await settle();

    const paste = "Patient: Chua Beng Huat · S7211043C\n\n14/03/2026. RIF pain.";
    $("paste").value = paste;
    await panel.parsePaste();
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));

    const record = panel.patientRecord();
    // Header lines included on purpose: redaction runs over all of it, with
    // these same demographics as the dictionary, so they come back as
    // [PATIENT] and [NRIC] rather than being trusted to have been removed.
    expect(record.clinical_text).toBe(paste);
    expect(record.full_name).toBe("Chua Beng Huat");
  });

  test("an incomplete record names the missing fields and refuses", async () => {
    const panel = loadPanel();
    await settle();

    $("paste").value = "14/03/2026. RIF pain, no other details.";
    expect(() => panel.patientRecord()).toThrow(/still needed/i);
    // Full name above all: it is the one identifier redaction cannot find by
    // shape, so proceeding without it leaves the name in the text.
    expect(() => panel.patientRecord()).toThrow(/full name/i);
  });

  test("an empty paste is refused before anything else is checked", async () => {
    const panel = loadPanel();
    await settle();
    expect(() => panel.patientRecord()).toThrow(/paste the consultation/i);
  });
});

// ---------------------------------------------------------------------------
// The second box
// ---------------------------------------------------------------------------

describe("other notes", () => {
  // A claim form asks for things a consultation note does not hold. The whole
  // risk of a second box is that it becomes a second path — one that reaches
  // the model without passing through redaction, or without contributing the
  // identifiers redaction needs. These say it does not.

  test("it is part of the text sent for mapping", async () => {
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    $("other-notes").value = "Ward class B1. Admission ref MEH-88213.";
    await panel.parsePaste();
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));

    const record = panel.patientRecord();
    expect(record.clinical_text).toContain("Chua Beng Huat");
    expect(record.clinical_text).toContain("Ward class B1");
  });

  test("identifiers in the second box are parsed too", async () => {
    // Otherwise they would never enter the redaction dictionary, and a name
    // typed only here would reach the model intact.
    const panel = loadPanel();
    await settle();
    $("other-notes").value = "Patient: Chua Beng Huat · S7211043C";
    await panel.parsePaste();

    const sent = JSON.parse(
      globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/parse"))[1].body,
    );
    expect(sent.text).toContain("S7211043C");
  });

  test("typing in it re-reads the identifiers", async () => {
    loadPanel();
    await settle();
    globalThis.fetch.mockClear();

    $("other-notes").value = "Ward class B1";
    $("other-notes").dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);

    expect(
      globalThis.fetch.mock.calls.filter((c) => String(c[0]).endsWith("/parse")),
    ).toHaveLength(1);
  });

  test("leaving it empty changes nothing", async () => {
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));

    // No trailing separator, no blank lines bolted on: the common case is
    // still one box and the text is exactly what was pasted.
    expect(panel.patientRecord().clinical_text).toBe("Patient: Chua Beng Huat");
  });

  test("it alone is enough — the consultation box is not separately required", async () => {
    const panel = loadPanel();
    await settle();
    $("other-notes").value = "Admitted 14/03/2026, ward B1.";
    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    for (const id of ["full-name", "nric", "insurer"]) {
      $(id).dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(() => panel.patientRecord()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wizards
// ---------------------------------------------------------------------------

/** A survey response in which one named schema fits the step on screen. */
function fits(formId, host = "portal.example.com") {
  return {
    ok: true,
    host,
    controlCount: 6,
    report: EMPTY_REPORT,
    candidates: [
      { formId, matched: 3, intended: 3, matchRate: 1, bestStepRate: 1, bestStepMatched: 3 },
    ],
  };
}

describe("when a wizard step renders", () => {
  test("the form is identified again, because step 1 could not have shown it", () => {
    // The panel identifies on open, which on a wizard is the verification
    // step — a page carrying none of the schema's fields. Whatever it decided
    // there was decided without the evidence.
    const panel = loadPanel();
    return settle()
      .then(() => {
        expect($("form-id").value).not.toBe("aia_ghs_claim");
        page.survey = fits("aia_ghs_claim");
        return panel.onPageChanged();
      })
      .then(() => {
        expect($("form-id").value).toBe("aia_ghs_claim");
      });
  });

  test("a form the doctor picked by hand is left alone", async () => {
    const panel = loadPanel();
    await settle();

    // Reaching for the picker is saying the automatic answer was wrong.
    $("form-id").value = "roboform_test_v1";
    $("form-id").dispatchEvent(new Event("change"));

    page.survey = fits("aia_ghs_claim");
    await panel.onPageChanged();

    expect($("form-id").value).toBe("roboform_test_v1");
  });

  test("nothing is filled — the doctor still clicks", async () => {
    const panel = loadPanel();
    await settle();
    globalThis.chrome.tabs.sendMessage.mockClear();

    await panel.onPageChanged();

    const actions = globalThis.chrome.tabs.sendMessage.mock.calls.map(([, m]) => m.action);
    expect(actions).not.toContain("fill");
  });

  test("with values waiting, the doctor is told the page moved", async () => {
    const panel = loadPanel();
    await settle();
    panel.state.rows = [
      { field_id: "icd", label: "ICD-10 Code", value: "K35.80", status: "extracted", needs_review: false },
    ];

    await panel.onPageChanged();

    expect($("fill-status").textContent).toMatch(/press Fill again/i);
  });

  test("the message arrives through chrome.runtime, not a direct call", async () => {
    loadPanel();
    await settle();
    expect(pageListener).toBeTypeOf("function");

    // A message for somebody else must not be acted on.
    expect(pageListener({ target: "something-else", action: "page-changed" })).toBeUndefined();
  });

  test("a schema is ranked by its best step, not by its whole field list", () => {
    const panel = loadPanel();
    // Four steps, one of them on screen: 3 of 12 fields is a 0.25 rate and
    // would be dismissed, while the step itself matched perfectly.
    const best = panel.bestCandidate([
      { formId: "wizard", matched: 3, intended: 12, matchRate: 0.25, bestStepRate: 1, bestStepMatched: 3 },
    ]);
    expect(best && best.formId).toBe("wizard");
  });

  test("a stepless schema is still ranked on its whole field list", () => {
    const panel = loadPanel();
    const best = panel.bestCandidate([
      { formId: "flat", matched: 3, intended: 12, matchRate: 0.25, bestStepRate: null, bestStepMatched: null },
    ]);
    expect(best).toBeNull();
  });

  test("the plan carries each field's step", async () => {
    const panel = loadPanel();
    await settle();
    panel.state.rows = [
      { field_id: "icd", label: "ICD-10 Code", value: "K35.80", status: "extracted", needs_review: false, step: "Patient diagnosis" },
    ];

    expect(panel.fillPlan()).toEqual([
      { fieldId: "icd", label: "ICD-10 Code", step: "Patient diagnosis" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Answers the control has to accept
// ---------------------------------------------------------------------------

const WARD_ROW = {
  field_id: "ward",
  label: "Ward class",
  value: "B1 (4-bedded)",
  status: "extracted",
  needs_review: false,
  field_type: "text",
  options: ["A1 (single)", "B1 (4-bedded)", "C (open)"],
};

async function mapWith(fields) {
  // One route now, whether or not the bank recognised the page.
  routes["/map-live"] = () => respond({ form_id: "__live__", fields });
  const panel = loadPanel();
  await settle();
  $("paste").value = "Admitted to B1.";
  $("full-name").value = "Chua Beng Huat";
  $("nric").value = "S7211043C";
  $("dob").value = "1972-11-04";
  $("insurer").value = "AIA";
  await panel.onMap();
  return panel;
}

describe("a field that declares its options", () => {
  test("is reviewed as the form's own choices, not a text box", async () => {
    await mapWith([WARD_ROW]);

    const select = $("rows").querySelector("select");
    expect(select).not.toBeNull();
    expect([...select.options].map((o) => o.value)).toEqual([
      "", "A1 (single)", "B1 (4-bedded)", "C (open)",
    ]);
    expect(select.value).toBe("B1 (4-bedded)");
  });

  test("leaving it blank stays reachable — none of these is a real answer", async () => {
    await mapWith([{ ...WARD_ROW, value: null, status: "missing" }]);

    const select = $("rows").querySelector("select");
    expect(select.value).toBe("");
  });

  test("a value the form does not offer selects nothing rather than being invented", async () => {
    // Should not happen — the backend downgrades an off-list answer to
    // missing — but if one arrives, the review screen must not manufacture an
    // option for it and make it look like a choice the form offers.
    await mapWith([{ ...WARD_ROW, value: "Ward B1" }]);

    const select = $("rows").querySelector("select");
    expect(select.value).toBe("");
    expect([...select.options].map((o) => o.value)).not.toContain("Ward B1");
  });

  test("a field with no options is still a text box", async () => {
    await mapWith([{ ...WARD_ROW, options: [] }]);

    expect($("rows").querySelector("select")).toBeNull();
    expect($("rows").querySelector("textarea")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dates get read back before they are written
// ---------------------------------------------------------------------------
//
// The backend holds every filled date whatever status it carries, because
// "the notes said 03/07" does not say whether that was 3 July or 7 March. The
// panel's job is to make that check answerable — a Confirm button under a
// value the doctor cannot disambiguate is a button, not a check.

const ADMISSION_DATE = {
  field_id: "date_of_admission",
  label: "Date of admission",
  field_type: "date",
  help: "Date the patient was admitted",
  value: "03/07/2026",
  status: "extracted",
  needs_review: true,
  recheck: "Check the day and month are the right way round — a date written 03/07 is 3 July here and 7 March elsewhere.",
};

describe("a date row", () => {
  test("says why it is held, even though the badge says it came from the note", async () => {
    await mapWith([ADMISSION_DATE]);

    const row = $("rows").querySelector(".review-row");
    expect(row.querySelector(".badge").textContent).toBe("Extracted from the note");
    expect(row.querySelector(".recheck").textContent).toContain("day and month");
  });

  test("cannot be written until the doctor confirms it", async () => {
    await mapWith([ADMISSION_DATE]);

    expect($("fill-btn").disabled).toBe(true);
    $("rows").querySelector("button.confirm").click();
    expect($("fill-btn").disabled).toBe(false);
  });

  test("spells the value out, and names the date it might have been instead", async () => {
    await mapWith([ADMISSION_DATE]);

    const hint = $("rows").querySelector(".date-hint").textContent;
    expect(hint).toContain("3 July 2026");
    expect(hint).toContain("7 March 2026");
  });

  test("is still spelled out when it is not ambiguous, but offers no rival", async () => {
    // 25/07 has exactly one reading, so the backend sends no recheck reason
    // and the row is not held — but the date is still worth reading back,
    // because a doctor scanning the list should not have to parse digits.
    await mapWith([
      { ...ADMISSION_DATE, value: "25/07/2026", needs_review: false, recheck: null },
    ]);

    expect($("rows").querySelector(".date-hint").textContent).toBe("25 July 2026");
    expect($("rows").querySelector(".recheck")).toBeNull();
    expect($("rows").querySelector("button.confirm")).toBeNull();
  });

  test("keeps the spelled-out date in step as the doctor corrects it", async () => {
    // The point of the row. A doctor who swaps the digits must be able to see
    // that the swap took — the digits alone are what they could not read.
    await mapWith([ADMISSION_DATE]);

    const input = $("rows").querySelector("textarea");
    input.value = "07/03/2026";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    expect($("rows").querySelector(".date-hint").textContent).toContain("7 March 2026");
  });

  test("a text row gets no date hint", async () => {
    await mapWith([{ ...ADMISSION_DATE, field_type: "text", recheck: null }]);

    expect($("rows").querySelector(".date-hint")).toBeNull();
    expect($("rows").querySelector(".recheck")).toBeNull();
  });
});

describe("readableDate", () => {
  test("never invents a century for a two-digit year", async () => {
    // Echoing "26" is honest; expanding it to 2026 is the guess the server
    // refuses to make, and a claim form carries dates of birth as readily as
    // dates of admission.
    const panel = await mapWith([ADMISSION_DATE]);

    expect(panel.readableDate("03/07/26")).toContain("3 July 26");
    expect(panel.readableDate("03/07/26")).not.toContain("2026");
  });

  test("says nothing about a value that is not a date", async () => {
    const panel = await mapWith([ADMISSION_DATE]);

    for (const value of ["", null, "sometime in July", "2026-07-03", "32/07/2026", "03/13/2026"]) {
      expect(panel.readableDate(value)).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Saying why, not just what
// ---------------------------------------------------------------------------

describe("the fill report", () => {
  test("gives the reason a field was skipped", async () => {
    const panel = await mapWith([WARD_ROW]);
    page.fill = {
      ok: true,
      refused: false,
      filled: 0,
      applied: [{ fieldId: "ward", status: "skipped", reason: "no matching option" }],
      report: { ...EMPTY_REPORT, results: [{ fieldId: "ward", status: "matched", score: 1, control: null }] },
    };

    await panel.onFill();

    // "Ward class — skipped" alone covers three situations needing three
    // different responses from the doctor.
    expect($("fill-report").textContent).toContain("no matching option");
  });

  test("names fields waiting on a later step instead of letting them read as failures", async () => {
    const panel = await mapWith([WARD_ROW]);
    page.fill = {
      ok: true,
      refused: false,
      filled: 1,
      applied: [{ fieldId: "ward", status: "filled" }],
      report: { ...EMPTY_REPORT, deferred: 4, results: [] },
    };

    await panel.onFill();

    expect($("fill-report").textContent).toMatch(/4 fields belong to a later step/i);
  });
});

describe("the sample note", () => {
  test("fills the paste box and triggers a parse", async () => {
    const panel = loadPanel();
    await settle();

    $("sample-note").click();
    expect($("paste").value).toContain("acute tonsillitis");
    // A programmatic assignment fires no input event of its own, so the
    // button has to dispatch one or the debounce never runs.
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(globalThis.fetch.mock.calls.some((c) => String(c[0]).endsWith("/parse"))).toBe(true);
  });

  test("it does not write the patient's name", async () => {
    // "BreezeFill never guesses this one" would be a strange thing to say
    // beside a button that guesses it. The doctor typed the name at step 1.
    const panel = loadPanel();
    await settle();

    $("full-name").value = "";
    $("sample-note").click();
    expect($("full-name").value).toBe("");
  });

  test("every identifier in it is synthetic", () => {
    // It ships inside the extension, so it is held to the repo's rule that
    // fixtures are synthetic only.
    const panel = loadPanel();
    $("sample-note").click();
    expect($("paste").value).toContain("S8012345D");
    expect($("paste").value).not.toContain("S7211043C"); // the test fixture's own
  });
});

// ---------------------------------------------------------------------------
// Two candidates is a question, not a blank
// ---------------------------------------------------------------------------
//
// The parser refuses to choose between two phone numbers, and it was right to.
// What it did badly was say so: an empty box is what the panel also shows when
// the note mentions no number at all, so a deliberate refusal read as the
// product failing to look. These pin the difference being visible.

const TWO_OF_EACH = {
  ...PARSED,
  phone: null,
  policy_number: null,
  choices: {
    phone: ["9123 4567", "6123 4567"],
    policy_number: ["GHS-88213004", "GH-88213004"],
  },
};

describe("choosing between candidates", () => {
  test("a refused field offers what the note actually said", async () => {
    const panel = loadPanel();
    await settle();

    routes["/parse"] = () => respond(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    const buttons = [...$("choices-phone").querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["9123 4567", "6123 4567"]);
    // The box stays empty until the doctor picks. Offering is not choosing.
    expect($("phone").value).toBe("");
  });

  test("it says why it is asking", async () => {
    // The whole point. "2 found" tells the doctor the parser saw the number
    // and declined to guess, which an empty box does not.
    const panel = loadPanel();
    await settle();

    routes["/parse"] = () => respond(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    expect($("choices-phone").textContent).toContain("2");
  });

  test("picking one fills the field and clears the question", async () => {
    const panel = loadPanel();
    await settle();

    routes["/parse"] = () => respond(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    $("choices-phone").querySelector("button").click();

    expect($("phone").value).toBe("9123 4567");
    expect($("choices-phone").querySelectorAll("button")).toHaveLength(0);
  });

  test("a choice the doctor made survives the next parse", async () => {
    // Same rule as a typed correction: they decided, and a re-parse must not
    // undo it or ask again.
    const panel = loadPanel();
    await settle();

    routes["/parse"] = () => respond(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();
    $("choices-phone").querySelector("button").click();

    await panel.parsePaste();

    expect($("phone").value).toBe("9123 4567");
    expect($("choices-phone").querySelectorAll("button")).toHaveLength(0);
  });

  test("a field that resolved is never asked about", async () => {
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    expect($("choices-phone").querySelectorAll("button")).toHaveLength(0);
    expect($("phone").value).toBe("91112233");
  });

  test("the summary counts the questions, so a closed drawer still says so", async () => {
    const panel = loadPanel();
    await settle();

    routes["/parse"] = () => respond(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    expect($("found-summary").textContent).toContain("2 to choose");
  });

  test("the drawer opens itself when there is something to choose", async () => {
    // Nothing required is missing here, so the old rule would have left it
    // shut and the question unseen.
    //
    const panel = loadPanel();
    await settle();
    shutDrawer();

    routes["/parse"] = () => respond(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    expect($("found").open).toBe(true);
  });

  test("a backend with no choices at all changes nothing", async () => {
    // The field is optional in the response, and an older backend does not
    // send it. The panel must not render an empty question.
    const panel = loadPanel();
    await settle();

    routes["/parse"] = () => respond({ ...PARSED, choices: undefined });
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    expect($("choices-phone").querySelectorAll("button")).toHaveLength(0);
    expect($("found-summary").textContent).not.toContain("to choose");
  });
});
