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
// The panel does not map without these, and that is the point of them: the
// note is redacted in this document before anything is sent. They are loaded
// here the way panel.html loads them rather than stubbed, so a test that
// asserts what went on the wire is asserting about the real redactor.
const PARSE_JS = readFileSync(resolve(HERE, "../privacy/parse.js"), "utf8");
const REDACT_JS = readFileSync(resolve(HERE, "../privacy/redact.js"), "utf8");
const PATTERNS = JSON.parse(readFileSync(resolve(HERE, "../privacy/patterns.json"), "utf8"));

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
    runtime_manifest_version: undefined,
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
  /* eslint-disable no-eval */
  (0, eval)(PARSE_JS);
  (0, eval)(REDACT_JS);
  globalThis.breezefillParse.usePatterns(PATTERNS);
  globalThis.breezefillRedact.usePatterns(PATTERNS);
  // Parsing is stubbed by default for the same reason the backend was: these
  // tests are about what the panel does with a parse, and the parser has its
  // own corpus in extension/privacy/parse.test.js.
  stubParse(PARSED);
  (0, eval)(PANEL_JS);
  /* eslint-enable no-eval */
  return globalThis.breezefillPanel;
}

const $ = (id) => document.getElementById(id);

/** Every call the panel made to the local parser, with its arguments. */
let parseCalls;

/**
 * Stand in for the local parser.
 *
 * Takes either a record to return or a function to run. It replaces the real
 * `parseDemographics`, which used to be a stubbed HTTP route — the move from
 * one to the other is exactly the change these tests exist to survive.
 */
function stubParse(result) {
  globalThis.breezefillParse.parseDemographics = (...args) => {
    parseCalls.push(args);
    if (typeof result === "function") return result(...args);
    return result;
  };
}

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
  parseCalls = [];
  routes = {
    "/forms": () => respond(FORMS),
    "patterns.json": () => respond(PATTERNS),
    "/health": () => respond({ status: "ok", forms_loaded: 2, min_extension_version: "0.3.0" }),
    "/map-redacted": () => respond({ form_id: "__live__", fields: [] }),
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
    routes["/map-redacted"] = () => Promise.reject(new TypeError("Failed to fetch"));
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

    const call = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-redacted"));
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
      expect.stringContaining("/map-redacted"),
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

    const mapped = globalThis.fetch.mock.calls.some((c) => String(c[0]).endsWith("/map-redacted"));
    expect(mapped).toBe(false);
    expect($("map-status").textContent).toMatch(/no fillable questions/i);
    expect($("map-status").textContent).not.toContain("Could not reach");
  });

  test("a failed parse does not overwrite the Map status line", async () => {
    // Two messages competing for one element is how the actionable one got
    // destroyed. The parse reports itself in the drawer instead.
    const panel = loadPanel();
    await settle();
    stubParse(() => { throw new Error("parser unavailable"); });

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
    stubParse({ ...PARSED, dob: null });
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

    const parses = parseCalls;
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

    const call = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-redacted"));
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
    expect(called.some((u) => u.endsWith("/map-redacted"))).toBe(true);
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
      routes["/map-redacted"] = () => respond({ detail: "..." }, false, status);
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
    routes["/map-redacted"] = () => respond({ form_id: "__live__", fields: ROWS });

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
    const mapCall = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-redacted"));
    expect(JSON.parse(mapCall[1].body).fields.map((f) => f.label)).toEqual(
      CONTROLS.map((c) => c.label)
    );
    expect($("mapped").hidden).toBe(false);

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
    // Said once, in the report. The status line used to repeat it in
    // different words directly above.
    expect($("fill-report").textContent).toMatch(/filled 3 field/i);
    expect($("fill-status").textContent).toBe("");

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
    expect(paths.some((p) => p.endsWith("/map-redacted"))).toBe(true);
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
// One box
// ---------------------------------------------------------------------------

describe("the check screen says what it knows about each value", () => {
  // The legend this replaced was a key in three colours at the top of the
  // screen, read once and skipped forever after. The badge says the same
  // thing on the field it is about, which is where the doctor is looking.

  test("a value found by pattern says so", async () => {
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat · S7211043C";
    await panel.parsePaste();

    expect($("badge-nric").textContent).toBe("Found in the note");
    expect($("row-nric").className).toContain("confirmed");
  });

  test("a value the doctor typed is not claimed as a find", async () => {
    // It matters on this screen specifically: these values are the redaction
    // dictionary, and "the note said this" and "you said this" are different
    // claims about whether it can be trusted.
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));

    expect($("badge-insurer").textContent).toBe("You typed this");
  });

  test("a field being asked about is marked as needing a check", async () => {
    const panel = loadPanel();
    await settle();
    stubParse(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    expect($("badge-phone").textContent).toBe("Needs checking");
    expect($("row-phone").className).toContain("pending");
  });

  test("picking a candidate settles the badge with it", async () => {
    const panel = loadPanel();
    await settle();
    stubParse(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    $("choices-phone").querySelector("button").click();

    expect($("badge-phone").textContent).toBe("You typed this");
    expect($("row-phone").className).not.toContain("pending");
  });

  test("a field nothing answered says nothing was found", async () => {
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    expect($("badge-insurer").textContent).toContain("Nothing found");
    expect($("row-insurer").className).toContain("missing");
    expect($("row-insurer").className).not.toContain("confirmed");
  });

  // The card stopped saying "Found in the note" and started showing a tick.
  // These pin the two halves of that trade, because only one of them is
  // visible and the invisible half is the one that carries the meaning.

  test("a confirmed value is marked, and the mark is not the only record", async () => {
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat · S7211043C";
    await panel.parsePaste();

    // The tick is what the eye gets. It is in every row's markup, so its
    // presence proves nothing — the row's state is what turns it on.
    expect($("row-nric").querySelector(".tick")).not.toBeNull();
    expect($("row-nric").className).toContain("confirmed");

    // ...and the sentence is still there, unshortened. A screen reader has no
    // tick to look at, and "the note said this" and "you said this" are
    // different claims about a value that is about to become the dictionary
    // redaction scrubs the note with.
    expect($("badge-nric").textContent).toBe("Found in the note");
  });

  test("a field nothing answered offers a way in without standing one open", async () => {
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    const row = $("row-insurer");
    // Not open by itself: six standing boxes are what made a checking screen
    // read as a form to fill.
    expect(row.className).not.toContain("adding");

    row.querySelector(".add").click();

    // But never a dead end — `dob` is required and an unlabelled date is
    // never read as a birth date, so this row is the ordinary case.
    expect(row.className).toContain("adding");
    expect(document.activeElement).toBe($("insurer"));
  });

  test("a box opened by hand stays open when the value is cleared again", async () => {
    // updateFound runs on every keystroke, and it used to rewrite the row's
    // whole class list. Typing one character and deleting it would then shut
    // the box under the doctor mid-correction.
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    const row = $("row-insurer");
    row.querySelector(".add").click();

    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));
    $("insurer").value = "";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));

    expect(row.className).toContain("missing");
    expect(row.className).toContain("adding");
  });
});

describe("looking back at a finished step", () => {
  // A finished step used to be a card with a drawer: expand it to see what
  // went in, then find the Edit link inside to go back. Two clicks to change a
  // value, when going back to the step is the only reason the row exists — and
  // the drawer's whole content was the value, so putting the value on the row
  // deleted the drawer rather than restyling it.

  /** Drive the panel to the review screen, the way the doctor does. */
  async function toReview(panel) {
    $("paste").value = "Patient: Chua Beng Huat\n\nWard class B1.";
    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    await panel.onMap();
  }

  const doneRow = (title) =>
    [...document.querySelectorAll(".done-row")].find((row) =>
      row.querySelector(".done-name").textContent.includes(title)
    );

  test("stepping back from a mapped review offers the way back to it", async () => {
    // showStep hides every step ahead of the one being shown, which is right
    // while a claim is being built and wrong once one has been mapped: the
    // answers are still in memory, and going back to check a spelling took
    // them off screen with mapping again as the only route back — a model
    // call, and every confirm click thrown away.
    const panel = loadPanel();
    await settle();
    await toReview(panel);
    panel.state.rows = [
      { field_id: "diagnosis", label: "Diagnosis", field_type: "text", help: null,
        value: "Acute appendicitis", status: "extracted", needs_review: false },
    ];
    panel.showStep("page");
    expect($("back-to-review").hidden).toBe(true);   // already there

    doneRow("Patient").click();   // the row IS the button back
    expect($("step-name").hidden).toBe(false);
    expect($("step-page").hidden).toBe(true);
    expect($("back-to-review").hidden).toBe(false);

    $("back-to-review").click();
    expect($("step-page").hidden).toBe(false);
    // The review was hidden, never rebuilt: the row is the same one.
    expect(panel.state.rows).toHaveLength(1);
  });

  test("no review, no way back to one", async () => {
    // On the way through, the button would point at a screen that has not
    // happened. It appears only once there is something behind it.
    const panel = loadPanel();
    await settle();
    expect($("back-to-review").hidden).toBe(true);

    panel.showStep("note");
    expect($("back-to-review").hidden).toBe(true);
  });

  test("rows discarded by a section change take the button with them", async () => {
    // A wizard step change throws the answers away on purpose. A button
    // leading to an empty review is worse than no button, so it is gated on
    // the rows rather than on a flag saying a mapping once happened.
    const panel = loadPanel();
    await settle();
    await toReview(panel);
    panel.state.rows = [
      { field_id: "diagnosis", label: "Diagnosis", field_type: "text", help: null,
        value: "Acute appendicitis", status: "extracted", needs_review: false },
    ];
    panel.showStep("name");
    expect($("back-to-review").hidden).toBe(false);

    panel.state.rows = [];
    panel.renderRows();
    expect($("back-to-review").hidden).toBe(true);
  });

  test("the row carries the value, so there is nothing to expand", async () => {
    const panel = loadPanel();
    await settle();
    await toReview(panel);

    expect(doneRow("Patient").querySelector(".done-value").textContent).toBe(
      "Chua Beng Huat"
    );
    // The note's opening line, not a word count: a doctor checking they
    // pasted the right consultation recognises how it starts.
    expect(doneRow("Consultation note").querySelector(".done-value").textContent).toBe(
      "Patient: Chua Beng Huat"
    );
    expect(document.querySelector(".done-body")).toBeNull();
  });

  test("one click goes back to the step", async () => {
    const panel = loadPanel();
    await settle();
    await toReview(panel);

    doneRow("Patient").click();

    expect($("step-name").hidden).toBe(false);
    expect($("step-page").hidden).toBe(true);
  });

  test("the finished steps sit UNDER the values once there are any", async () => {
    // Arriving at the review used to mean arriving at a list of steps already
    // finished, with the values the doctor came for below the fold.
    routes["/map-redacted"] = () =>
      respond({
        form_id: "__live__",
        fields: [
          {
            field_id: "ward",
            label: "Ward class",
            field_type: "text",
            help: null,
            value: "B1",
            status: "extracted",
            source: "Ward class B1.",
            needs_review: false,
            recheck: null,
          },
        ],
      });
    const panel = loadPanel();
    await settle();
    await toReview(panel);

    const children = [...$("scroll").children];
    expect(children.indexOf($("done-rows"))).toBeGreaterThan(
      children.indexOf($("step-page"))
    );
    expect($("done-rows").classList.contains("below")).toBe(true);
  });

  test("and above the work before that", async () => {
    const panel = loadPanel();
    await settle();
    $("full-name").value = "Chua Beng Huat";
    $("name-next").click();

    const children = [...$("scroll").children];
    expect(children.indexOf($("done-rows"))).toBe(0);
    expect($("done-rows").classList.contains("below")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nothing identifying leaves this tab
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

describe("a build the backend has disowned", () => {
  // The gap redacting in the browser cannot close by itself: Chrome updates
  // an extension on its own schedule and a store review takes days, so a
  // redaction bug cannot be fixed in minutes the way a server one can. The
  // server can still refuse the old build, and a panel that cannot map cannot
  // send a note it redacted badly.

  test("version comparison is numeric, not alphabetical", () => {
    const panel = loadPanel();
    expect(panel.olderThan("0.9.0", "0.10.0")).toBe(true);
    expect(panel.olderThan("0.10.0", "0.9.0")).toBe(false);
    expect(panel.olderThan("0.3.0", "0.3.0")).toBe(false);
    expect(panel.olderThan("1.0", "0.3.0")).toBe(false);
  });

  test("an out-of-date panel refuses to send anything", async () => {
    const panel = loadPanel();
    await settle();
    chrome.runtime.getManifest = () => ({ version: "0.2.1" });

    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    $("paste").value = "Patient: Chua Beng Huat. Seen today.";
    globalThis.fetch.mockClear();
    await panel.onMap();

    expect(
      globalThis.fetch.mock.calls.filter((c) => String(c[0]).endsWith("/map-redacted"))
    ).toHaveLength(0);
    expect($("map-status").textContent).toMatch(/out of date/i);
  });

  test("a current panel is not stopped", async () => {
    const panel = loadPanel();
    await settle();
    chrome.runtime.getManifest = () => ({ version: "0.3.0" });

    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    $("paste").value = "Patient: Chua Beng Huat. Seen today.";
    await panel.onMap();

    expect(
      globalThis.fetch.mock.calls.filter((c) => String(c[0]).endsWith("/map-redacted"))
    ).toHaveLength(1);
  });

  test("an unreachable backend does not stop a doctor working", async () => {
    // Fails open on purpose. A blocked panel is the right answer to "that
    // build puts names on the wire" and the wrong one to a flaky network.
    const panel = loadPanel();
    await settle();
    chrome.runtime.getManifest = () => ({ version: "0.3.0" });
    routes["/health"] = () => Promise.reject(new TypeError("Failed to fetch"));

    expect(await panel.checkVersion()).toBe(false);
  });
});

describe("what actually goes on the wire", () => {
  // The claim the product makes, asserted against the requests themselves
  // rather than against the code that builds them. Every test here reads what
  // fetch was handed and looks for the patient in it.

  const PATIENT = {
    "full-name": "Chua Beng Huat",
    nric: "S7211043C",
    dob: "1972-11-04",
    phone: "91112233",
    "policy-number": "GHS-4471902",
    insurer: "AIA",
    address: "18 Toa Payoh Lorong 4, Singapore 310018",
  };

  const NOTE =
    "Patient: Chua Beng Huat · S7211043C · 04/11/1972 · 91112233\n" +
    "18 Toa Payoh Lorong 4, Singapore 310018 · Policy GHS-4471902\n\n" +
    "14/03/2026. Mr Chua presents with RIF pain. Admitted Mount Elizabeth Hospital.";

  /** Everything the panel sent, as one string to search. */
  const everythingSent = () =>
    globalThis.fetch.mock.calls
      .map((call) => (call[1] && call[1].body ? String(call[1].body) : ""))
      .join("\n");

  async function mapWith(panel, note = NOTE) {
    for (const [id, value] of Object.entries(PATIENT)) $(id).value = value;
    $("paste").value = note;
    await panel.onMap();
  }

  test("not one of the patient's identifiers is in any request", async () => {
    const panel = loadPanel();
    await settle();
    await mapWith(panel);

    const sent = everythingSent();
    for (const identifier of [
      "Chua Beng Huat", "Chua", "S7211043C", "04/11/1972", "91112233",
      "GHS-4471902", "18 Toa Payoh",
    ]) {
      expect(sent, identifier).not.toContain(identifier);
    }
  });

  test("the note is sent, tokenised — not withheld", async () => {
    // The other half of the claim. Redaction that sent nothing would pass the
    // test above and fill no forms.
    const panel = loadPanel();
    await settle();
    await mapWith(panel);

    const sent = everythingSent();
    expect(sent).toContain("[PATIENT]");
    expect(sent).toContain("[NRIC]");
    expect(sent).toContain("RIF pain");
    // Not a patient identifier, and the claim needs it.
    expect(sent).toContain("Mount Elizabeth Hospital");
  });

  test("the request carries no patient record at all", async () => {
    const panel = loadPanel();
    await settle();
    await mapWith(panel);

    const call = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-redacted"));
    const body = JSON.parse(call[1].body);
    expect(body.patient).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(["fields", "redacted_text"]);
  });

  test("the map that could undo the tokens is never sent", async () => {
    // It is the one thing that makes the tokens reversible. It stays here.
    const panel = loadPanel();
    await settle();
    await mapWith(panel);

    const sent = everythingSent();
    expect(sent).not.toContain("redaction_map");
    expect(sent).not.toContain("[PATIENT]\":");
  });
});

describe("it refuses rather than sending a note it could not redact", () => {
  test("with the shapes unloaded, nothing is posted", async () => {
    // The failure that must never degrade gracefully. A warning is a thing a
    // busy doctor clicks past, and the note cannot be recalled afterwards.
    const panel = loadPanel();
    await settle();
    globalThis.breezefillRedact.usePatterns = () => {};
    globalThis.breezefillRedact.ready = () => false;

    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    $("paste").value = "Chua Beng Huat, seen today.";
    globalThis.fetch.mockClear();
    await panel.onMap();

    expect(
      globalThis.fetch.mock.calls.filter((c) => String(c[0]).endsWith("/map-redacted"))
    ).toHaveLength(0);
    expect($("map-status").textContent).toMatch(/will not send it/i);
  });

  test("a note with no name to redact against is refused", async () => {
    // A name has no shape. Without one the patterns cannot find it, so a note
    // that went out would look redacted and would still carry it.
    const panel = loadPanel();
    await settle();
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("paste").value = "Chua Beng Huat, seen today.";
    globalThis.fetch.mockClear();
    await panel.onMap();

    expect(
      globalThis.fetch.mock.calls.filter((c) => String(c[0]).endsWith("/map-redacted"))
    ).toHaveLength(0);
  });
});

describe("the note is redacted at send time, never cached", () => {
  test("a name typed after the parse is still masked", async () => {
    // Paste, parse, then keep typing. Text redacted against the dictionary as
    // it stood ten seconds ago is text redacted against the wrong dictionary.
    const panel = loadPanel();
    await settle();

    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    $("paste").value = "Patient: Chua Beng Huat. Seen today.";
    await panel.parsePaste();

    // ...and now the doctor adds a sentence.
    $("paste").value += "\nMr Chua also reports a cough. NRIC S7211043C confirmed.";
    await panel.onMap();

    const call = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-redacted"));
    const body = JSON.parse(call[1].body);
    expect(body.redacted_text).toContain("cough");
    expect(body.redacted_text).not.toContain("Chua");
    expect(body.redacted_text).not.toContain("S7211043C");
  });
});

describe("the patient comes back in this tab", () => {
  const ROWS = [
    {
      field_id: "patient_name", pdf_field_name: "", field_type: "text",
      label: "Patient name", help: null, value: null, status: "demographic",
      source: null, needs_review: false, fill_from: "full_name", options: [], step: null,
    },
    {
      field_id: "dob", pdf_field_name: "", field_type: "date",
      label: "Date of birth", help: null, value: null, status: "demographic",
      source: null, needs_review: false, fill_from: "dob", options: [], step: null,
    },
    {
      field_id: "diagnosis", pdf_field_name: "", field_type: "text",
      label: "Diagnosis", help: null, value: "Acute appendicitis", status: "extracted",
      source: "[PATIENT] presents with RIF pain", needs_review: false,
      fill_from: null, options: [], step: null,
    },
    {
      field_id: "invented", pdf_field_name: "", field_type: "text",
      label: "Ward", help: null, value: "Admitted under [NRIC_9]", status: "extracted",
      source: null, needs_review: false, fill_from: null, options: [], step: null,
    },
  ];

  async function mapReturning(panel, rows) {
    routes["/map-redacted"] = () => respond({ form_id: "__live__", fields: rows });
    $("full-name").value = "Chua Beng Huat";
    $("nric").value = "S7211043C";
    $("dob").value = "1972-11-04";
    $("insurer").value = "AIA";
    $("paste").value = "Patient: Chua Beng Huat. RIF pain. Seen 14/03/2026.";
    await panel.onMap();
    return panel.state.rows;
  }

  test("a demographic row is filled from the box the doctor checked", async () => {
    const panel = loadPanel();
    await settle();
    const rows = await mapReturning(panel, ROWS);

    expect(rows.find((r) => r.field_id === "patient_name").value).toBe("Chua Beng Huat");
  });

  test("a date is written the way a form wants it, not as the input holds it", async () => {
    const panel = loadPanel();
    await settle();
    const rows = await mapReturning(panel, ROWS);

    expect(rows.find((r) => r.field_id === "dob").value).toBe("04/11/1972");
  });

  test("an ambiguous date is held for a second read", async () => {
    // 04/11 could be 4 November or 11 April, and the form will read it one
    // way. Same sentence the server shows, because it is the same check.
    const panel = loadPanel();
    await settle();
    const rows = await mapReturning(panel, ROWS);

    const dob = rows.find((r) => r.field_id === "dob");
    expect(dob.needs_review).toBe(true);
    expect(dob.recheck).toMatch(/right way round/i);
  });

  test("the model's tokens become the patient again, here", async () => {
    const panel = loadPanel();
    await settle();
    const rows = await mapReturning(panel, ROWS);

    expect(rows.find((r) => r.field_id === "diagnosis").source).toBe(
      "Chua Beng Huat presents with RIF pain"
    );
  });

  test("a token the model invented is blanked and held, never written", async () => {
    // [NRIC_9] is not in the map because nothing produced it. Letting it
    // through would put a raw token on an insurer's form.
    const panel = loadPanel();
    await settle();
    const rows = await mapReturning(panel, ROWS);

    const invented = rows.find((r) => r.field_id === "invented");
    expect(invented.value).toBe(null);
    expect(invented.status).toBe("missing");
    expect(invented.needs_review).toBe(true);
  });
});

describe("everything pasted is one corpus", () => {
  // There used to be a second box, for the things a claim form asks about that
  // a consultation note does not hold — a ward class, an admission reference.
  // It was always concatenated with the first before anything read it, so it
  // was one box with a step in between, and the doctor now types those lines
  // under their note.
  //
  // What the second box's tests were really guarding survives it: the parse
  // and the mapping call must read the same text. A line that reached the
  // model without having been read for identifiers first is a line redaction
  // had no dictionary for.

  test("lines added under the note are sent for mapping", async () => {
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat\n\nWard class B1. Admission ref MEH-88213.";
    await panel.parsePaste();
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));

    const record = panel.patientRecord();
    expect(record.clinical_text).toContain("Chua Beng Huat");
    expect(record.clinical_text).toContain("Ward class B1");
  });

  test("identifiers anywhere in the box are parsed", async () => {
    // Including in whatever was typed underneath. Otherwise they never enter
    // the redaction dictionary, and a name typed at the bottom of the box
    // would reach the model intact.
    const panel = loadPanel();
    await settle();
    $("paste").value = "Admitted 14/03/2026, ward B1.\nPatient: Chua Beng Huat · S7211043C";
    await panel.parsePaste();

    const sent = { text: parseCalls[parseCalls.length - 1][0] };
    expect(sent.text).toContain("S7211043C");
  });

  test("the name typed at step 1 goes with the paste", async () => {
    // It turns finding the name in a header block from a judgement into a
    // check. Without it the parser has to decide which capitalised piece of
    // "Chua Beng Huat · Tan Wei Ling · S7211043C" is the patient, and a wrong
    // answer is the one that matters: the name is what the note is scrubbed
    // against, so the real one stays in the text sent to the model.
    const panel = loadPanel();
    await settle();
    $("full-name").value = "Chua Beng Huat";
    $("paste").value = "Chua Beng Huat · Tan Wei Ling · S7211043C";
    await panel.parsePaste();

    const [text, knownName] = parseCalls[parseCalls.length - 1];
    expect(knownName).toBe("Chua Beng Huat");
    expect(text).toContain("Tan Wei Ling");
  });

  test("the text sent is exactly what was pasted", async () => {
    // No separator bolted on, now that there is nothing to join it to.
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));

    expect(panel.patientRecord().clinical_text).toBe("Patient: Chua Beng Huat");
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

  test("the answers to the section just left are taken down", async () => {
    // They belong to the questions that were on screen a moment ago. Left up,
    // they invite a fill that writes the last section's answers into this one.
    const panel = loadPanel();
    await settle();
    panel.state.step = "page";
    panel.state.rows = [
      { field_id: "icd", label: "ICD-10 Code", value: "K35.80", status: "extracted", needs_review: false },
    ];

    await panel.onPageChanged();

    expect(panel.state.rows).toHaveLength(0);
    expect($("mapped").hidden).toBe(true);
  });

  test("the new section is read, and then it waits", async () => {
    // Read, not mapped. Four wizard sections would otherwise be four model
    // calls nobody asked for.
    const panel = loadPanel();
    await settle();
    panel.state.step = "page";
    globalThis.fetch.mockClear();

    await panel.onPageChanged();

    expect($("map-prompt").hidden).toBe(false);
    expect($("prompt-title").textContent).toContain("2 questions");
    expect(
      globalThis.fetch.mock.calls.filter((c) => String(c[0]).endsWith("/map-redacted"))
    ).toHaveLength(0);
  });

  test("a section with nothing answerable says so and keeps watching", async () => {
    const panel = loadPanel();
    await settle();
    panel.state.step = "page";
    page.survey = { ...page.survey, liveFields: [], controlCount: 0 };

    await panel.onPageChanged();

    // Not an error, and not silence either. A wizard opens on a verification
    // or a landing section as often as not, so the panel says there is nothing
    // here YET and offers no button to press.
    expect($("map-prompt").hidden).toBe(false);
    expect($("prompt-title").textContent).toMatch(/no questions on this page/i);
    expect($("map-btn").hidden).toBe(true);
  });

  test("the strip naming the host it is watching is gone", async () => {
    // "Watching localhost:8080. 7 questions on it." named the host the
    // extension had noticed — a fact about the extension rather than about the
    // claim — in a box that cost a line of screen on every wizard step. The
    // count it carried moved onto the card it is a count of.
    const panel = loadPanel();
    await settle();
    panel.state.step = "page";

    await panel.onPageChanged();

    expect(document.getElementById("watch")).toBeNull();
    expect($("prompt-title").textContent).toMatch(/questions on this page/i);
    expect(document.body.textContent).not.toContain("Watching");
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
  routes["/map-redacted"] = () => respond({ form_id: "__live__", fields });
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
    expect(parseCalls.length).toBeGreaterThan(0);
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

    stubParse(TWO_OF_EACH);
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

    stubParse(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    expect($("choices-phone").textContent).toContain("2");
  });

  test("a single suggested date is offered, not filled", async () => {
    // The date of birth is the one field where a lone candidate is still a
    // question: a note carrying one date is carrying the consultation date,
    // not a birth date. Everywhere else a single match is the value and never
    // reaches this list, so relaxing the count only ever affects this field.
    const panel = loadPanel();
    await settle();

    stubParse({ ...PARSED, dob: null, choices: { dob: ["2026-08-02"] } });
    $("paste").value = "Seen 02/08/2026. Sore throat, settling.";
    await panel.parsePaste();

    const buttons = [...$("choices-dob").querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["2026-08-02"]);
    expect($("dob").value).toBe("");
    // Singular wording: "2 found — pick one" reads as a miscount when there is
    // only one thing to look at.
    expect($("choices-dob").textContent).toContain("is this the patient's?");
  });

  test("picking one fills the field and clears the question", async () => {
    const panel = loadPanel();
    await settle();

    stubParse(TWO_OF_EACH);
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

    stubParse(TWO_OF_EACH);
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

    stubParse(TWO_OF_EACH);
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

    stubParse(TWO_OF_EACH);
    $("paste").value = "HP 9123 4567 / 6123 4567";
    await panel.parsePaste();

    expect($("found").open).toBe(true);
  });

  test("a backend with no choices at all changes nothing", async () => {
    // The field is optional in the response, and an older backend does not
    // send it. The panel must not render an empty question.
    const panel = loadPanel();
    await settle();

    stubParse({ ...PARSED, choices: undefined });
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    expect($("choices-phone").querySelectorAll("button")).toHaveLength(0);
    expect($("found-summary").textContent).not.toContain("to choose");
  });
});

// ---------------------------------------------------------------------------
// Confirming a value, without rebuilding the screen it is on
// ---------------------------------------------------------------------------
//
// Confirming used to call renderRows, which replaced every row in the list.
// Nothing about `state` changed shape, so nothing that reads state could see
// it — and both consequences were invisible to the suite that existed. Every
// row re-ran its entrance animation, so confirming one value made the whole
// screen move; and the Confirm button holding focus was destroyed, so focus
// fell to <body> and the next Tab started again at the top of the panel. On a
// twenty-field claim that is once per value.

describe("confirming a value", () => {
  const TWO_DATES = [
    ADMISSION_DATE,
    { ...ADMISSION_DATE, field_id: "date_of_discharge", label: "Date of discharge" },
  ];

  test("leaves every other row exactly where it was", async () => {
    await mapWith(TWO_DATES);
    const before = [...$("rows").children];

    before[0].querySelector("button.confirm").click();

    // Node identity, not markup equality. A rebuilt row is a NEW node, and a
    // new node re-runs pf-rise however identical its HTML.
    expect([...$("rows").children]).toEqual(before);
  });

  test("still moves the count and the bar", async () => {
    // The rows are mutated rather than re-rendered now, so the readiness
    // meta has to be moved deliberately. It used to ride along on the rebuild.
    await mapWith(TWO_DATES);

    $("rows").children[0].querySelector("button.confirm").click();

    expect($("review-summary").textContent).toContain("1 value still to confirm");
    expect($("review-progress").style.transform).toBe("scaleX(0.5)");
  });

  test("an edit moves the bar too, which is what the panel has always claimed", async () => {
    // The markup beside the bar says only a confirm click or an edit advances
    // it. Editing used to update the Fill button and nothing else.
    await mapWith(TWO_DATES);

    const input = $("rows").children[0].querySelector("textarea");
    input.value = "07/03/2026";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    expect($("review-progress").style.transform).toBe("scaleX(0.5)");
  });

  test("hands the keyboard to the next value waiting", async () => {
    await mapWith(TWO_DATES);
    const rows = [...$("rows").children];

    rows[0].querySelector("button.confirm").click();

    expect(document.activeElement).toBe(rows[1].querySelector("button.confirm"));
  });

  test("stays on the row once there is no next, rather than travelling to Fill", async () => {
    // Focusing Fill scrolled the doctor to the bottom of the claim the instant
    // they confirmed the last value, ending the read-through they were in the
    // middle of. Confirming the last one is not the same as being finished —
    // they may still be checking the ones they already confirmed.
    await mapWith([ADMISSION_DATE]);
    const row = $("rows").children[0];

    row.querySelector("button.confirm").click();

    expect(document.activeElement).toBe(row);
    expect(document.activeElement).not.toBe($("fill-btn"));
    expect($("fill-btn").disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The note, kept beside the values that came out of it
// ---------------------------------------------------------------------------
//
// Checking a mapped value is a comparison between the model's answer and what
// the note said, and the panel used to show one at a time. `source` — the
// sentence the model is told to quote verbatim — has been on every row since
// mapping.py was written and was never rendered.

const NOTE = "Seen 02/08/2026. Dx acute tonsillitis. MC 2 days.";

const QUOTED = {
  field_id: "diagnosis",
  label: "Diagnosis of all conditions treated",
  field_type: "text",
  help: null,
  value: "Acute tonsillitis",
  status: "extracted",
  source: "Dx acute tonsillitis.",
  needs_review: false,
  recheck: null,
};

async function mapWithNote(fields, note = NOTE) {
  routes["/map-redacted"] = () => respond({ form_id: "__live__", fields });
  const panel = loadPanel();
  await settle();
  $("paste").value = note;
  $("full-name").value = "Chua Beng Huat";
  $("nric").value = "S7211043C";
  $("dob").value = "1972-11-04";
  $("insurer").value = "AIA";
  await panel.onMap();
  return panel;
}

const marked = () => $("note-text").querySelector(".quote.on");

describe("the note pane", () => {
  test("shows the consultation as it was pasted", async () => {
    await mapWithNote([QUOTED]);

    expect($("note-text").textContent).toBe(NOTE);
  });

  test("opens already marked, on the row at the top of the list", async () => {
    // Two things at once. It used to mark nothing until the doctor happened to
    // click a row, which made the pane look broken — and then it marked the
    // first value NEEDING a check, which put the mark on a row further down
    // while the top of the screen showed a different question. A citation that
    // does not match the visible row reads as a wrong citation. The arrival
    // mark now uses the same rule scrolling does.
    await mapWithNote([
      { ...QUOTED, field_id: "settled", label: "Diagnosis", needs_review: false },
      { ...QUOTED, field_id: "icd", label: "ICD-10 code", value: "J03.90",
        status: "inferred", needs_review: true },
    ]);

    expect(marked().textContent).toBe("Dx acute tonsillitis.");
    expect($("note-following").textContent).toBe("Diagnosis");
  });

  test("marks the sentence a value came from, and names the row", async () => {
    await mapWithNote([QUOTED]);

    $("rows").children[0].click();

    expect(marked().textContent).toBe("Dx acute tonsillitis.");
    expect($("note-text").textContent).toBe(NOTE);
    expect($("note-following").textContent).toBe(QUOTED.label);
  });

  test("an extracted value is filled, and shown inside its own sentence", async () => {
    await mapWithNote([QUOTED]);

    $("rows").children[0].click();
    const mark = marked();

    expect(mark.classList.contains("quoted")).toBe(true);
    expect(mark.classList.contains("reasoned")).toBe(false);
    // The value emphasised where it sits, so the match is shown not asserted.
    expect(mark.querySelector(".hit").textContent).toBe("acute tonsillitis");
  });

  test("an inferred value is outlined instead, and never claims to be in there", async () => {
    // "J03.90" appears nowhere in "Dx acute tonsillitis." Filling that
    // sentence the same way makes the most dangerous row on the screen read
    // as a wrong citation.
    await mapWithNote([
      { ...QUOTED, label: "ICD-10 code", value: "J03.90", status: "inferred",
        needs_review: true, reasoning: "J03.90 is the ICD-10 code for acute tonsillitis." },
    ]);

    $("rows").children[0].click();
    const mark = marked();

    expect(mark.classList.contains("reasoned")).toBe(true);
    expect(mark.classList.contains("quoted")).toBe(false);
    // No guess at which words produced it — that is the fuzzy match this refuses.
    expect(mark.querySelector(".hit")).toBeNull();
    expect($("note-following").textContent).toBe("ICD-10 code — worked out from this");
  });

  test("the inference is spelled out on the row, where it is signed off", async () => {
    await mapWithNote([
      { ...QUOTED, value: "J03.90", status: "inferred", needs_review: true,
        reasoning: "J03.90 is the ICD-10 code for acute tonsillitis." },
    ]);

    expect($("rows").querySelector(".derived").textContent).toBe(
      "J03.90 is the ICD-10 code for acute tonsillitis."
    );
  });

  test("a row with no reasoning grows no explanation", async () => {
    await mapWithNote([QUOTED]);

    expect($("rows").querySelector(".derived")).toBeNull();
  });

  test("follows the keyboard as well as the mouse", async () => {
    await mapWithNote([QUOTED]);

    $("rows")
      .children[0].querySelector("textarea")
      .dispatchEvent(new window.Event("focusin", { bubbles: true }));

    expect(marked().textContent).toBe("Dx acute tonsillitis.");
  });

  test("marks NOTHING when the quote is not in the note verbatim", async () => {
    // The rule this whole pane rests on. A fuzzy match would draw a highlight
    // around a sentence the value did not come from, on the one screen whose
    // job is showing the doctor where a value came from — a wrong citation
    // rendered exactly like a right one.
    await mapWithNote([{ ...QUOTED, source: "Diagnosis: acute tonsillitis" }]);

    $("rows").children[0].click();

    expect(marked()).toBeNull();
    expect($("note-text").textContent).toBe(NOTE);
    expect($("note-following").textContent).toBe("quote not found in the note");
  });

  test("tells the two silent cases apart", async () => {
    // A value the model did not quote and a value that never came from the
    // note at all are different facts, and a blank pane says neither.
    await mapWithNote([{ ...QUOTED, source: null, status: "demographic" }]);

    $("rows").children[0].click();

    expect(marked()).toBeNull();
    expect($("note-following").textContent).toBe("not taken from the note");
  });

  test("folds away without losing the note", async () => {
    await mapWithNote([QUOTED]);

    $("note-toggle").click();

    expect($("note-text").hidden).toBe(true);
    expect($("note-toggle").textContent).toBe("Show");
    expect($("note-toggle").getAttribute("aria-expanded")).toBe("false");
    expect($("note-text").textContent).toBe(NOTE);

    $("note-toggle").click();

    expect($("note-text").hidden).toBe(false);
    expect($("note-toggle").textContent).toBe("Hide");
  });
});

describe("the readiness line", () => {
  test("says how many are left while any are", async () => {
    await mapWithNote([
      { ...QUOTED, status: "inferred", needs_review: true,
        reasoning: "J03.90 is the ICD-10 code for acute tonsillitis." },
    ]);

    expect($("review-summary").hidden).toBe(false);
    expect($("review-summary").textContent).toContain("1 value still to confirm");
    expect($("review-progress-box").hidden).toBe(false);
  });

  test("goes quiet once there are none", async () => {
    // "4 of 5 fields ready to write. The rest are for you to complete by
    // hand." appeared exactly when the doctor had stopped needing a sentence,
    // directly above the one button they were reaching for.
    await mapWithNote([QUOTED]);

    expect($("review-summary").hidden).toBe(true);
    expect($("review-progress-box").hidden).toBe(true);
    expect($("fill-btn").disabled).toBe(false);
  });
});

describe("the fill report", () => {
  test("is the first thing on the screen, above the values just checked", async () => {
    // Pressing Fill used to land the doctor at the top of the list they had
    // just finished checking, with the outcome below the fold.
    const mapped = [...$("mapped").children].map((el) => el.id);

    expect(mapped.indexOf("fill-report")).toBeLessThan(mapped.indexOf("rows"));
    expect(mapped.indexOf("fill-report")).toBeLessThan(mapped.indexOf("fill-btn"));
  });
});

describe("an inferred value's sentence", () => {
  test("is still marked, and still marked as you scroll to it", async () => {
    // The dashed rule alone read as "nothing is highlighted". It is the
    // sentence the doctor has to read — the rule only says the value is not
    // written in there.
    await mapWithNote([
      { ...QUOTED, status: "inferred", needs_review: true,
        value: "J03.90", label: "ICD-10 code",
        reasoning: "J03.90 is the ICD-10 code for acute tonsillitis." },
    ]);

    const mark = marked();
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe("Dx acute tonsillitis.");
    expect(mark.classList.contains("reasoned")).toBe(true);
  });
});

describe("where the consultation pane belongs", () => {
  test("it is up on the screen where the values are checked", async () => {
    await mapWithNote([QUOTED]);

    expect($("notepane").hidden).toBe(false);
  });

  test("and down on the step that holds the note itself", async () => {
    // Going back to the paste box left the pane up beside it, so the same
    // consultation was on screen twice — once as the thing being edited, once
    // as a read-only copy of it.
    const panel = await mapWithNote([QUOTED]);
    panel.showStep("note");

    expect($("notepane").hidden).toBe(true);
  });
});

describe("a refusal that names a field", () => {
  test("opens the step holding it, and puts the cursor there", async () => {
    // The redactor's values live on the check step and the refusal is raised
    // on the page step, so "Still needed: date of birth" arrived on a screen
    // with no date of birth on it and nothing pointing anywhere. The doctor
    // had to already know the box was behind the Verify row in the ledger.
    const panel = loadPanel();
    await settle();
    $("full-name").value = "Chua Beng Huat";
    $("paste").value = "Patient: Chua Beng Huat";
    $("dob").value = "";
    panel.showStep("page");

    await panel.onMap();

    expect($("step-check").hidden).toBe(false);
    expect($("step-page").hidden).toBe(true);
    expect(document.activeElement).toBe($("dob"));
  });

  test("and stays put when nothing is actually missing", async () => {
    // A redaction failure with every demographic present is a different
    // fault; yanking the doctor off the page step to show them a complete
    // form would be worse than saying nothing.
    const panel = loadPanel();
    await settle();
    $("full-name").value = "Chua Beng Huat";
    $("dob").value = "1972-11-04";
    $("paste").value = "Patient: Chua Beng Huat";
    panel.showStep("page");

    await panel.onMap();

    expect($("step-page").hidden).toBe(false);
  });
});

describe("a fill that wrote nothing", () => {
  const NOTHING = {
    ok: true, refused: false, filled: 0, applied: [],
    report: { results: [{ fieldId: "date_of_admission", status: "skipped", reason: "already answered" }],
              unknownControls: [], deferred: 0, matched: 1, intended: 1, matchRate: 1, safeToFill: true },
  };

  test("does not congratulate the doctor in green", async () => {
    // It read "Filled 0 fields on this page." in the success colour, over
    // "Check each one on the form, then submit it yourself" — an instruction
    // to check nothing, in the one place the panel is meant to be careful.
    const panel = await mapWith([ADMISSION_DATE]);
    $("rows").querySelector("button.confirm").click();
    page.fill = NOTHING;
    await panel.onFill();

    expect($("fill-report").querySelector(".is-success")).toBeNull();
    expect($("fill-report").textContent).toContain("Nothing was written on this page");
    expect($("fill-report").textContent).not.toContain("Filled 0 field");
  });

  test("and still says nothing was overwritten", async () => {
    // The other half of the news, and the one a doctor actually wants: their
    // own answers are untouched.
    const panel = await mapWith([ADMISSION_DATE]);
    $("rows").querySelector("button.confirm").click();
    page.fill = NOTHING;
    await panel.onFill();

    expect($("fill-report").textContent).toContain("Nothing was overwritten");
  });

  test("a refused fill grows no empty list", async () => {
    // "What happened to each field" was rendering as a heading over nothing.
    const panel = await mapWith([ADMISSION_DATE]);
    $("rows").querySelector("button.confirm").click();
    page.fill = { ok: true, refused: true, reason: "only 1 of 3 fields matched this page",
                  filled: 0, applied: [],
                  report: { results: [], unknownControls: [], deferred: 0, matched: 1,
                            intended: 3, matchRate: 0.33, safeToFill: false } };
    await panel.onFill();

    expect($("fill-report").textContent).not.toContain("What happened to each field");
    expect($("fill-status").textContent).toContain("Nothing was filled");
  });
});

describe("when the form moves to a different section", () => {
  /** The message content/fill.js sends when the wizard re-renders. */
  const pageChanged = () =>
    pageListener({ target: "breezefill-panel", action: "page-changed" }, {}, () => {});

  test("the review is cleared, and the doctor is told it was", async () => {
    // Clearing is right: a value mapped for "date of admission" is not an
    // answer to whatever question sits in the same place on the next section,
    // and leaving it up invites a fill that writes the last section's answers
    // into this one. Clearing it SILENTLY is the defect — a doctor who had
    // read the rows and confirmed one watched the whole review vanish with an
    // empty status line as the only sign anything had happened.
    const panel = await mapWith([ADMISSION_DATE]);
    $("rows").querySelector("button.confirm").click();
    expect($("rows").querySelectorAll(".review-row")).toHaveLength(1);

    pageChanged();
    await settle();
    await settle();

    expect(panel.state.rows).toHaveLength(0);
    expect($("prompt-why").textContent).toContain("The form moved on");
    expect($("prompt-why").textContent).toContain("not answers to these questions");
  });

  test("and says nothing about it when there was no review to lose", async () => {
    const panel = loadPanel();
    await settle();
    panel.state.step = "page";

    pageChanged();
    await settle();
    await settle();

    expect($("prompt-why").textContent).not.toContain("The form moved on");
  });
});
