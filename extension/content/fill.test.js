/**
 * @vitest-environment jsdom
 *
 * Tests for the injected orchestrator.
 *
 * Two things matter here beyond "does it wire up". First, survey must not
 * write — it runs before the doctor has confirmed anything. Second, what
 * crosses back to the panel must be structure only and must be scrubbed,
 * because this is the one boundary where insurer page text moves into
 * BreezeFill's own UI.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../../tests/fixtures/portal_like.html");

// Must exist before fill.js runs: it registers a message listener at load.
const listeners = [];
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } },
};

await import("../learn/dump.js");
await import("../fill/locate.js");
await import("../fill/apply.js");
await import("./fill.js");

const content = globalThis.breezefillContent;

const PLAN = [
  { fieldId: "diagnosis", label: "Diagnosis of all conditions treated" },
  { fieldId: "icd", label: "ICD-10 code" },
  { fieldId: "ward", label: "Ward class" },
];
const VALUES = { diagnosis: "Acute appendicitis", icd: "K35.80", ward: "B1" };

/**
 * Every identifier planted in the fixture, along each of the three routes a
 * page can leak one: a control's value, page prose, and a select's options.
 */
const PLANTED = [
  "Tan Wei Ming",
  "S1234567D",
  "9123 4567",
  "91234567",
  "weiming.tan@example.com",
  "80123456",
  "80123457",
  "14/03/1971",
  "276b138a-204b-4fb4-b8c3-2e90431ead0e",
];

beforeEach(() => {
  document.documentElement.innerHTML = readFileSync(FIXTURE, "utf8");
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe("what crosses back to the panel", () => {
  test("carries no planted identifier", () => {
    const serialised = JSON.stringify(content.survey(PLAN));
    for (const identifier of PLANTED) {
      expect(serialised).not.toContain(identifier);
    }
  });

  test("survives structured cloning, so it holds no element references", () => {
    // chrome.tabs.sendMessage clones the response. A DOM node in there would
    // throw at runtime and only on a real page.
    expect(() => structuredClone(content.survey(PLAN))).not.toThrow();
    expect(() => structuredClone(content.fill(PLAN, VALUES))).not.toThrow();
  });

  test("reports unmatched live controls so a grown portal is visible", () => {
    const labels = content.survey(PLAN).report.unknownControls.map((c) => c.label);
    expect(labels).toContain("Was surgery performed?");
  });
});

// ---------------------------------------------------------------------------

describe("survey", () => {
  test("locates without writing anything", () => {
    const before = document.querySelector("#icd").value;
    const response = content.survey(PLAN);

    expect(response.ok).toBe(true);
    expect(response.report.safeToFill).toBe(true);
    expect(response.report.matched).toBe(3);
    // The whole point: nothing has been confirmed yet.
    expect(document.querySelector("#icd").value).toBe(before);
  });

  test("an empty plan is not safe to fill", () => {
    expect(content.survey([]).report.safeToFill).toBe(false);
  });
});

describe("fill", () => {
  test("writes the confirmed values", () => {
    const response = content.fill(PLAN, VALUES);

    expect(response.refused).toBe(false);
    expect(response.filled).toBe(3);
    expect(document.querySelector("#icd").value).toBe("K35.80");
    expect(document.querySelector("#ward").value).toBe("B1");
  });

  test("re-locates, so it still works after the page re-renders", () => {
    // A wizard advancing replaces every node. References captured during the
    // survey would be detached and writes would silently go nowhere.
    content.survey(PLAN);
    const form = document.querySelector("#claim-form");
    form.innerHTML = form.innerHTML;

    expect(content.fill(PLAN, VALUES).filled).toBe(3);
    expect(document.querySelector("#icd").value).toBe("K35.80");
  });

  test("refuses wholesale when the page stopped matching", () => {
    document.body.innerHTML = `
      <label for="d">Diagnosis of all conditions treated</label><textarea id="d" name="d"></textarea>
      <label for="x">Claimant relationship to member</label><input id="x" name="x" />
      <label for="y">Preferred contact method</label><input id="y" name="y" />
    `;
    const response = content.fill(PLAN, VALUES);

    expect(response.refused).toBe(true);
    expect(response.filled).toBe(0);
    expect(document.querySelector("#d").value).toBe("");
  });

  test("never submits", () => {
    let submitted = false;
    document.querySelector("#claim-form").addEventListener("submit", (e) => {
      submitted = true;
      e.preventDefault();
    });
    content.fill(PLAN, VALUES);
    expect(submitted).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("message handling", () => {
  const listener = () => listeners[0];

  function send(message) {
    let response;
    listener()(message, {}, (r) => {
      response = r;
    });
    return response;
  }

  test("registers exactly one listener even though the panel re-injects", () => {
    // The panel injects on every call rather than tracking what it has
    // already done. A second listener would handle each message twice, the
    // second run overwriting the first.
    expect(listeners).toHaveLength(1);
  });

  test("routes survey and fill", () => {
    expect(send({ target: "breezefill-content", action: "survey", plan: PLAN }).report.matched).toBe(3);
    expect(send({ target: "breezefill-content", action: "fill", plan: PLAN, values: VALUES }).filled).toBe(3);
  });

  test("ignores messages that are not addressed to it", () => {
    expect(send({ action: "survey", plan: PLAN })).toBeUndefined();
  });

  test("rejects an unknown action rather than guessing", () => {
    expect(send({ target: "breezefill-content", action: "submit" })).toEqual({
      ok: false,
      error: "unknown action",
    });
  });
});
