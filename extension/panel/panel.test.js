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
    fields: [
      { id: "full_name", label: "Full Name" },
      { id: "nric", label: "Social Security Number" },
      { id: "phone", label: "Home Phone" },
    ],
  },
  {
    form_id: "aia_ghs_claim",
    display_name: "Group H&S claim",
    insurer: "AIA",
    hosts: [],
    fields: [
      { id: "diagnosis", label: "Diagnosis of all conditions treated" },
      { id: "icd", label: "ICD-10 Code" },
      { id: "admitted", label: "Date of admission" },
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

const EMPTY_REPORT = {
  results: [],
  unknownControls: [],
  matched: 0,
  intended: 0,
  matchRate: 0,
  safeToFill: false,
};

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
  };
  // eslint-disable-next-line no-eval
  (0, eval)(PANEL_JS);
  return globalThis.claimfillPanel;
}

const $ = (id) => document.getElementById(id);

/** Let the microtask queue drain, so an awaited fetch settles. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  routes = {
    "/forms": () => respond(FORMS),
    "/parse": () => respond(PARSED),
    "/map-live": () => respond({ form_id: "__live__", fields: [] }),
    "/map": () => respond({ form_id: "roboform_test_v1", fields: [] }),
  };
  // A page nothing in the bank recognises, which is the interesting default:
  // it is what an insurer portal looks like on the first visit.
  page = {
    survey: { ok: true, host: "portal.example.com", controlCount: 4, report: EMPTY_REPORT, candidates: [] },
    fill: { ok: true, refused: false, filled: 0, applied: [], report: EMPTY_REPORT },
  };
  globalThis.fetch = vi.fn((url) => {
    const path = Object.keys(routes).find((p) => String(url).endsWith(p));
    return path ? routes[path](url) : respond({}, false, 404);
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.claimfillPanel;
});

// ---------------------------------------------------------------------------
// The demo failure
// ---------------------------------------------------------------------------

describe("when the backend is not running", () => {
  test("Map says so, rather than reporting a bare TypeError", async () => {
    routes["/forms"] = () => Promise.reject(new TypeError("Failed to fetch"));
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    await panel.onMap();

    // The browser's own wording is what the doctor saw last time, and there
    // is nothing they can do with it.
    expect($("map-status").textContent).not.toContain("Failed to fetch");
    expect($("map-status").textContent).toContain("Could not reach the backend");
  });

  test("a backend started after the panel opened does not need it reopened", async () => {
    // The form list loads once, on open. When that failed, the picker stayed
    // empty and every Map posted a "" form id for a 404 until the panel was
    // closed and opened again — which nobody would ever guess.
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

    expect($("form-id").options).toHaveLength(FORMS.length);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/map"),
      expect.anything()
    );
  });

  test("Map never posts an empty form id", async () => {
    routes["/forms"] = () => respond([]);
    const panel = loadPanel();
    await settle();

    $("paste").value = "Patient: Chua Beng Huat";
    await panel.onMap();

    const mapped = globalThis.fetch.mock.calls.some((c) => String(c[0]).endsWith("/map"));
    expect(mapped).toBe(false);
    // ...and a backend that answered is not reported as unreachable. Sending
    // someone to check a URL that just responded wastes the debugging.
    expect($("map-status").textContent).not.toContain("Could not reach");
    expect($("map-status").textContent).toContain("no forms loaded");
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

    // No insurer in PARSED, so the doctor has to supply one.
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();

    expect($("found").open).toBe(true);
    expect($("found-summary").textContent).toContain("insurer");
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
    // them would put a value under a question from the wrong form.
    scored([
      { formId: "aia_ghs_claim", matched: 3, intended: 3, matchRate: 1 },
      { formId: "roboform_test_v1", matched: 3, intended: 3, matchRate: 1 },
    ]);
    loadPanel();
    await settle();

    expect($("form-id").hidden).toBe(false);
    expect($("form-detected").textContent).toMatch(/nothing in the bank/i);
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
    loadPanel();
    await settle();

    expect($("form-detected").textContent).toMatch(/nothing in the bank/i);
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
    expect(message.candidates).toEqual([
      {
        formId: "roboform_test_v1",
        fields: [
          { fieldId: "full_name", label: "Full Name" },
          { fieldId: "nric", label: "Social Security Number" },
          { fieldId: "phone", label: "Home Phone" },
        ],
      },
      {
        formId: "aia_ghs_claim",
        fields: [
          { fieldId: "diagnosis", label: "Diagnosis of all conditions treated" },
          { fieldId: "icd", label: "ICD-10 Code" },
          { fieldId: "admitted", label: "Date of admission" },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The form nobody has a schema for
// ---------------------------------------------------------------------------

describe("the schema-free fallback", () => {
  const CONTROLS = [
    { ref: "c1", label: "Diagnosis of all conditions treated", type: "text" },
    { ref: "c2", label: "Date of admission", type: "date" },
    { ref: "c3", label: "", type: "text" },
  ];

  async function unrecognisedPanel() {
    page.survey = {
      ...page.survey,
      candidates: [],
      report: { ...EMPTY_REPORT, unknownControls: CONTROLS },
    };
    const panel = loadPanel();
    await settle();
    $("paste").value = "Patient: Chua Beng Huat";
    await panel.parsePaste();
    $("insurer").value = "AIA";
    $("insurer").dispatchEvent(new Event("input", { bubbles: true }));
    return panel;
  }

  test("it is offered only when nothing in the bank fits", async () => {
    page.survey = { ...page.survey, candidates: [{ formId: "aia_ghs_claim", matched: 3, intended: 3, matchRate: 1 }] };
    loadPanel();
    await settle();
    expect($("use-live-wrap").hidden).toBe(true);
  });

  test("mapping posts the page's own labels, not a form id", async () => {
    const panel = await unrecognisedPanel();
    await panel.onMap();

    const call = globalThis.fetch.mock.calls.find((c) => String(c[0]).endsWith("/map-live"));
    expect(call).toBeTruthy();
    const sent = JSON.parse(call[1].body);
    // The unlabelled control is dropped here rather than posted as "": a
    // field with no question cannot be answered, and asking wastes a call.
    expect(sent.fields).toEqual([
      { label: "Diagnosis of all conditions treated", type: "text" },
      { label: "Date of admission", type: "date" },
    ]);
    expect(sent.form_id).toBeUndefined();
  });

  test("picking a schema turns the fallback off", async () => {
    await unrecognisedPanel();
    expect($("use-live").checked).toBe(true);

    $("form-id").value = "aia_ghs_claim";
    $("form-id").dispatchEvent(new Event("change", { bubbles: true }));

    expect($("use-live").checked).toBe(false);
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
