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
  { form_id: "roboform_test_v1", display_name: "RoboForm test page", insurer: "Test", hosts: ["roboform.com"] },
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

/** Queue of responses, consumed in order, keyed by the path being called. */
let routes;

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
      sendMessage: vi.fn().mockResolvedValue({ ok: true, host: "roboform.com", controlCount: 39, report: { results: [], unknownControls: [], matched: 0, intended: 0, safeToFill: false } }),
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
    "/map": () => respond({ form_id: "roboform_test_v1", fields: [] }),
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

    expect($("form-id").options).toHaveLength(1);
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
