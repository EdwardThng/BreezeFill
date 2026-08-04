/**
 * @vitest-environment jsdom
 *
 * Tests for value application.
 *
 * The lead test models React's actual value tracker, because that mechanism is
 * the entire reason this module exists and the failure it prevents is
 * invisible to review: the doctor sees the right value on screen and the
 * portal submits the old one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import "../learn/dump.js";
import "./locate.js";
import "./apply.js";

const learn = globalThis.breezefillLearn;
const locate = globalThis.breezefillLocate;
const apply = globalThis.breezefillApply;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../../tests/fixtures/portal_like.html");

/**
 * Stand-in for React's `_valueTracker`.
 *
 * React defines a `value` accessor on the ELEMENT INSTANCE and records every
 * write through it. When an `input` event arrives, React compares the current
 * value against that record; if they are equal it concludes nothing changed
 * and drops the event. So a naive `el.value = x` updates the record, making
 * the subsequent event a no-op — which is precisely why the value disappears
 * on submit. Writing through the PROTOTYPE setter leaves the record stale, so
 * React sees a difference and accepts the change.
 */
function installReactTracker(el) {
  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  const tracker = { lastSeen: descriptor.get.call(el) };
  Object.defineProperty(el, "value", {
    configurable: true,
    get() {
      return descriptor.get.call(this);
    },
    set(v) {
      tracker.lastSeen = v;
      descriptor.set.call(this, v);
    },
  });
  return tracker;
}

/** The wrapping-label text, as the orchestrator will supply for radio groups. */
function labelOf(el) {
  const wrapper = el.closest("label");
  if (!wrapper) return "";
  const clone = wrapper.cloneNode(true);
  clone.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
  return clone.textContent.trim();
}

function loadFixture() {
  document.documentElement.innerHTML = readFileSync(FIXTURE, "utf8");
}

beforeEach(loadFixture);

// ---------------------------------------------------------------------------
// The trap
// ---------------------------------------------------------------------------

describe("framework-controlled inputs", () => {
  test("writing through the prototype leaves React's tracker stale", () => {
    const el = document.querySelector("#icd");
    const tracker = installReactTracker(el);

    apply.applyOne(el, "K35.80");

    // The DOM has the new value...
    expect(el.value).toBe("K35.80");
    // ...but React's record still holds the old one, so the input event it
    // receives registers as a real change instead of being dropped.
    expect(tracker.lastSeen).toBe("");
  });

  test("a naive assignment would defeat the tracker", () => {
    // Documents the bug this module exists to avoid. If this ever starts
    // behaving like the test above, the mechanism has changed and the
    // prototype-setter approach needs rechecking.
    const el = document.querySelector("#icd");
    const tracker = installReactTracker(el);

    el.value = "K35.80";

    expect(tracker.lastSeen).toBe("K35.80");
  });

  test("notifies with bubbling input and change events", () => {
    const el = document.querySelector("#icd");
    const seen = [];
    // Listening on the form proves the events bubble — frameworks delegate
    // from a root node rather than binding each input directly.
    document.querySelector("#claim-form").addEventListener("input", (e) => seen.push(e.type));
    document.querySelector("#claim-form").addEventListener("change", (e) => seen.push(e.type));

    apply.applyOne(el, "K35.80");

    expect(seen).toEqual(["input", "change"]);
  });

  test("works on a textarea, which has its own value accessor", () => {
    // Using HTMLInputElement's setter on a textarea silently does nothing.
    const el = document.querySelector("#diagnosis");
    apply.applyOne(el, "Acute appendicitis");
    expect(el.value).toBe("Acute appendicitis");
  });
});

// ---------------------------------------------------------------------------
// Per-control behaviour
// ---------------------------------------------------------------------------

describe("selects", () => {
  test("matches on option text", () => {
    const el = document.querySelector("#ward");
    expect(apply.applyOne(el, "B1").status).toBe("filled");
    expect(el.value).toBe("B1");
  });

  test("leaves the field alone when no option matches", () => {
    // The schema and the portal disagree about what this field accepts.
    // Guessing is how a wrong clinical answer gets submitted.
    const el = document.querySelector("#ward");
    const before = el.value;
    const result = apply.applyOne(el, "Executive suite");

    expect(result.status).toBe("skipped");
    expect(el.value).toBe(before);
  });
});

describe("checkboxes", () => {
  test("ticks an unticked box", () => {
    const el = document.querySelector("input[name='preExisting']");
    expect(apply.applyOne(el, true).status).toBe("filled");
    expect(el.checked).toBe(true);
  });

  test("does not touch a box that is already correct", () => {
    // Clicking an already-correct checkbox toggles it to wrong.
    const el = document.querySelector("input[name='preExisting']");
    el.checked = true;
    const spy = vi.spyOn(el, "click");

    expect(apply.applyOne(el, true).status).toBe("unchanged");
    expect(spy).not.toHaveBeenCalled();
    expect(el.checked).toBe(true);
  });
});

describe("radio groups", () => {
  test("selects the member whose label matches", () => {
    const els = Array.from(document.querySelectorAll("input[name='surgeryDone']"));
    expect(apply.applyOne(els, "Yes", { labelOf }).status).toBe("filled");
    expect(els[0].checked).toBe(true);
  });

  test("selects nothing when no label matches", () => {
    // Never "pick the first one".
    const els = Array.from(document.querySelectorAll("input[name='surgeryDone']"));
    expect(apply.applyOne(els, "Maybe", { labelOf }).status).toBe("skipped");
    expect(els.some((e) => e.checked)).toBe(false);
  });
});

describe("guards", () => {
  test("a missing value never clears what is already there", () => {
    // The destructive case: on a wizard the doctor may have typed this by
    // hand. Coercing undefined to "" would erase it and report success.
    const el = document.querySelector("#icd");
    apply.applyOne(el, "K35.80");

    expect(apply.applyOne(el, undefined).status).toBe("skipped");
    expect(el.value).toBe("K35.80");
    expect(apply.applyOne(el, null).status).toBe("skipped");
    expect(el.value).toBe("K35.80");
  });

  test("an empty string is still a value the doctor can mean", () => {
    // Absent and empty are different. Only the former is refused.
    const el = document.querySelector("#icd");
    apply.applyOne(el, "K35.80");
    expect(apply.applyOne(el, "").status).toBe("filled");
    expect(el.value).toBe("");
  });

  test("a plan whose values drifted fills nothing rather than blanking", () => {
    const plan = [{ fieldId: "icd", label: "ICD-10 code" }];
    const { controls, elements } = learn.collectControls(document);
    const report = locate.locate(plan, controls);

    document.querySelector("#icd").value = "typed by hand";
    const result = apply.applyPlan(report, elements, {}, { labelOf });

    expect(result.filled).toBe(0);
    expect(document.querySelector("#icd").value).toBe("typed by hand");
  });

  test("skips a readonly control", () => {
    const el = document.querySelector("input[name='policyNo']");
    const before = el.value;
    expect(apply.applyOne(el, "99999999").status).toBe("skipped");
    expect(el.value).toBe(before);
  });

  test("skips a control that disappeared between locating and filling", () => {
    expect(apply.applyOne(null, "x").status).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// Whole-plan application
// ---------------------------------------------------------------------------

describe("applyPlan", () => {
  const PLAN = [
    { fieldId: "diagnosis", label: "Diagnosis of all conditions treated" },
    { fieldId: "icd", label: "ICD-10 code" },
    { fieldId: "ward", label: "Ward class" },
  ];
  const VALUES = {
    diagnosis: "Acute appendicitis",
    icd: "K35.80",
    ward: "B1",
  };

  function run() {
    const { controls, elements } = learn.collectControls(document);
    const report = locate.locate(PLAN, controls);
    return { result: apply.applyPlan(report, elements, VALUES, { labelOf }), report };
  }

  test("fills a matched plan", () => {
    const { result } = run();
    expect(result.refused).toBe(false);
    expect(result.filled).toBe(3);
    expect(document.querySelector("#diagnosis").value).toBe("Acute appendicitis");
    expect(document.querySelector("#icd").value).toBe("K35.80");
    expect(document.querySelector("#ward").value).toBe("B1");
  });

  test("refuses entirely when the matcher says the page changed", () => {
    document.body.innerHTML = `
      <label for="d">Diagnosis of all conditions treated</label><textarea id="d" name="d"></textarea>
      <label for="x">Claimant relationship to member</label><input id="x" name="x" />
      <label for="y">Preferred contact method</label><input id="y" name="y" />
    `;
    const { controls, elements } = learn.collectControls(document);
    const report = locate.locate(PLAN, controls);
    const result = apply.applyPlan(report, elements, VALUES, { labelOf });

    expect(result.refused).toBe(true);
    expect(result.filled).toBe(0);
    // Nothing was written, including into the field that did match.
    expect(document.querySelector("#d").value).toBe("");
  });

  test("is idempotent, so it can re-run as a wizard advances", () => {
    run();
    const { result } = run();
    expect(result.applied.every((a) => a.status !== "skipped" || a.reason)).toBe(true);
    expect(document.querySelector("#icd").value).toBe("K35.80");
  });

  test("never submits the form", () => {
    // A product guarantee, not an implementation detail. The doctor clicks
    // submit and signs.
    const onSubmit = vi.fn((e) => e.preventDefault());
    document.querySelector("#claim-form").addEventListener("submit", onSubmit);
    const clicked = vi.fn();
    document.querySelector("button[type='submit']").addEventListener("click", clicked);

    run();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });
});
