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
    //
    // The status is now "skipped/already answered" rather than "unchanged":
    // a ticked box is an answer, so the never-overwrite rule catches it before
    // the value is even compared. What this test guards — that the box is not
    // clicked and not toggled — is unchanged.
    const el = document.querySelector("input[name='preExisting']");
    el.checked = true;
    const spy = vi.spyOn(el, "click");

    expect(apply.applyOne(el, true).status).toBe("skipped");
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

// ---------------------------------------------------------------------------
// Native date controls
// ---------------------------------------------------------------------------
//
// The pipeline speaks DD/MM/YYYY end to end. A native date box holds
// yyyy-mm-dd and silently empties itself when handed anything else, so
// without conversion the most carefully checked field on the form is the one
// guaranteed not to arrive — reported filled on the way past.

describe("a native date box", () => {
  /** A date control with something already in it, as a portal would render. */
  function dateBox(existing) {
    const el = document.createElement("input");
    el.type = "date";
    document.body.append(el);
    if (existing) el.value = existing;
    return el;
  }

  test("takes DD/MM/YYYY, which is the only format anything upstream produces", () => {
    const el = dateBox();

    expect(apply.applyOne(el, "03/07/2026").status).toBe("filled");
    expect(el.value).toBe("2026-07-03");
  });

  test("pads a single-digit day and month", () => {
    const el = dateBox();

    apply.applyOne(el, "3/7/2026");
    expect(el.value).toBe("2026-07-03");
  });

  test("fires the events a framework listens for, once the value has landed", () => {
    const el = dateBox();
    const seen = [];
    el.addEventListener("input", () => seen.push("input"));
    el.addEventListener("change", () => seen.push("change"));

    apply.applyOne(el, "03/07/2026");
    expect(seen).toEqual(["input", "change"]);
  });

  test("refuses a two-digit year rather than picking a century for it", () => {
    // 26 is 2026 or 1926 depending on which box it sits in, and a claim form
    // carries dates of birth as readily as dates of admission. The server
    // declines this guess too; the doctor makes it in the picker.
    const el = dateBox();

    const result = apply.applyOne(el, "03/07/26");
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("DD/MM/YYYY");
    expect(el.value).toBe("");
  });

  test("reports skipped rather than filled when the date cannot exist", () => {
    // 31 February. Not checked here — the control's own sanitiser rejects it
    // and the write is seen not to have landed. One calendar is enough.
    const el = dateBox();

    expect(apply.applyOne(el, "31/02/2026").status).toBe("skipped");
    expect(el.value).toBe("");
  });

  test("never leaves the box emptier than it found it", () => {
    // The failure that motivated this. Assignment does not throw: the value
    // is sanitised to "", so a doctor who had already picked a date watches
    // it disappear and the report calls the field filled.
    const el = dateBox("2026-03-14");

    const result = apply.applyOne(el, "not a date");
    expect(result.status).toBe("skipped");
    expect(el.value).toBe("2026-03-14");
  });

  test("an ordinary text box still takes the DD/MM/YYYY string unchanged", () => {
    // Most insurer forms are print-derived and use plain text inputs. The
    // conversion must not follow the value there — the form asks for
    // DD/MM/YYYY and that is what the doctor confirmed.
    const el = document.querySelector("#icd");

    apply.applyOne(el, "03/07/2026");
    expect(el.value).toBe("03/07/2026");
  });
});

describe("guards", () => {
  test("a control that sanitises away what it is given reports skipped", () => {
    // Generalises the date fix. A number box handed text empties itself the
    // same way, and "filled" would be a lie about a field nobody will check
    // again.
    const el = document.createElement("input");
    el.type = "number";
    document.body.append(el);
    el.value = "42";

    const result = apply.applyOne(el, "not a number");
    expect(result.status).toBe("skipped");
    expect(el.value).toBe("42");
  });

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
    // Absent and empty are different. Only the former is refused — an empty
    // string still writes, into a control that has no answer yet.
    const el = document.querySelector("#icd");
    expect(el.value).toBe("");
    expect(apply.applyOne(el, "").status).toBe("filled");
    expect(el.value).toBe("");
  });

  test("an empty string no longer clears an answer that is already there", () => {
    // This inverts what this file asserted before 2026-08-06, and the reversal
    // is deliberate. Writing "" over an existing answer is a clearance, and a
    // clearance is exactly what the never-overwrite rule exists to stop —
    // whether the emptying value arrives as absent or as "".
    const el = document.querySelector("#icd");
    apply.applyOne(el, "K35.80");
    expect(apply.applyOne(el, "").status).toBe("skipped");
    expect(el.value).toBe("K35.80");
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

/**
 * Checkbox questions whose answer is an option, not a boolean.
 *
 * All three of these failed before 2026-08-06 and each failed differently:
 * the value comparison was case-sensitive, an unrecognised value fell through
 * to `false` and UNTICKED, and a set of checkboxes was never one question.
 */
describe("checkbox answers", () => {
  function box(checked = false) {
    document.body.innerHTML = `<input type="checkbox" id="b" ${checked ? "checked" : ""}>`;
    return document.getElementById("b");
  }

  test("a capitalised Yes ticks the box", () => {
    const el = box(false);
    // "Yes" is exactly what an options list supplies. The old check was
    // `value === "yes"`, so this arrived as "do not tick".
    expect(apply.applyOne(el, "Yes").status).toBe("filled");
    expect(el.checked).toBe(true);
  });

  test.each(["YES", "true", "On", "1", "y"])("%s is understood as a tick", (v) => {
    const el = box(false);
    apply.applyOne(el, v);
    expect(el.checked).toBe(true);
  });

  test.each(["No", "FALSE", "off", "0"])("%s is understood as an untick", (v) => {
    // Asserted on an EMPTY box, because a ticked one is an answer and the
    // never-overwrite rule stops before the value is read. What this checks is
    // the parsing: these values mean "not ticked", so the box stays clear and
    // nothing is reported as filled.
    const el = box(false);
    expect(apply.applyOne(el, v).status).toBe("unchanged");
    expect(el.checked).toBe(false);
  });

  test("an unrecognised value never unticks what the doctor already ticked", () => {
    // Two rules now stop this, and either alone is enough: the box is already
    // answered, and "Ward B1" says nothing about a tick. Before 2026-08-06
    // neither existed and the value computed `wanted = false`, so a real
    // answer silently cleared the box.
    const el = box(true);
    const result = apply.applyOne(el, "Ward B1");
    expect(result.status).toBe("skipped");
    expect(el.checked).toBe(true);
  });

  test("an unrecognised value on an empty box writes nothing and says so", () => {
    const el = box(false);
    expect(apply.applyOne(el, "Emergency").status).toBe("skipped");
    expect(el.checked).toBe(false);
  });
});

describe("checkbox groups", () => {
  function group(checkedIndex) {
    // Carries an explicit "None of the above": without one, an empty group is
    // ambiguous and refused before any ticking is attempted — which is its own
    // test in the "empty checkbox group" block below.
    document.body.innerHTML = `
      <input type="checkbox" name="admit" id="a" value="Emergency">
      <input type="checkbox" name="admit" id="b" value="Elective">
      <input type="checkbox" name="admit" id="c" value="Day surgery">
      <input type="checkbox" name="admit" id="d" value="None of the above">`;
    const els = Array.from(document.querySelectorAll("input[name=admit]"));
    if (checkedIndex != null) els[checkedIndex].checked = true;
    return els;
  }

  test("several checkboxes sharing a name become one question", () => {
    document.body.innerHTML = `
      <fieldset><legend>How was the patient admitted?</legend>
        <input type="checkbox" name="admit" id="a"><label for="a">Emergency</label>
        <input type="checkbox" name="admit" id="b"><label for="b">Elective</label>
      </fieldset>`;
    const { controls } = learn.collectControls(document);
    expect(controls).toHaveLength(1);
    expect(controls[0].type).toBe("checkbox-group");
    expect(controls[0].label).toBe("How was the patient admitted?");
    expect(controls[0].options.values).toEqual(["Emergency", "Elective"]);
  });

  test("a lone named checkbox stays a plain toggle, not a one-option group", () => {
    document.body.innerHTML = `
      <fieldset><legend>Consent</legend>
        <input type="checkbox" name="consent" id="c"><label for="c">I agree</label>
      </fieldset>`;
    const { controls } = learn.collectControls(document);
    expect(controls).toHaveLength(1);
    expect(controls[0].type).toBe("checkbox");
  });

  test("the matching member is ticked and the others are left alone", () => {
    const els = group(null);
    expect(apply.applyOne(els, "Elective").status).toBe("filled");
    expect(els.map((e) => e.checked)).toEqual([false, true, false, false]);
  });

  test("a group with something already ticked is left alone", () => {
    const els = group(0);
    const result = apply.applyOne(els, "Elective");
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already answered");
    expect(els.map((e) => e.checked)).toEqual([true, false, false, false]);
  });
});

/**
 * The doctor's own answer outranks ours, on every question type.
 *
 * A control that already carries an answer has been settled — by the doctor,
 * or by the insurer pre-populating the form. Writing over it would replace a
 * human decision with a model's, after the review step has already passed.
 */
describe("an answer already in the control is never overwritten", () => {
  test("a text box the doctor typed into keeps its text", () => {
    document.body.innerHTML = `<input type="text" id="t" value="Mount Elizabeth">`;
    const el = document.getElementById("t");
    const result = apply.applyOne(el, "Raffles Hospital");
    expect(result).toEqual({ status: "skipped", reason: "already answered" });
    expect(el.value).toBe("Mount Elizabeth");
  });

  test("a textarea with existing findings keeps them", () => {
    document.body.innerHTML = `<textarea id="t">Acute appendicitis</textarea>`;
    const el = document.getElementById("t");
    expect(apply.applyOne(el, "Gastroenteritis").status).toBe("skipped");
    expect(el.value).toBe("Acute appendicitis");
  });

  test("a select with a real choice keeps it", () => {
    document.body.innerHTML = `<select id="s">
      <option value="">— Select —</option><option>B1 (4-bedded)</option><option>C (open ward)</option></select>`;
    const el = document.getElementById("s");
    el.value = "C (open ward)";
    expect(apply.applyOne(el, "B1 (4-bedded)").status).toBe("skipped");
    expect(el.value).toBe("C (open ward)");
  });

  test("but a select still showing its placeholder is fillable", () => {
    // "" is not an answer — otherwise every untouched dropdown would be
    // treated as settled and nothing would ever fill.
    document.body.innerHTML = `<select id="s">
      <option value="">— Select —</option><option>B1 (4-bedded)</option></select>`;
    const el = document.getElementById("s");
    expect(apply.applyOne(el, "B1 (4-bedded)").status).toBe("filled");
    expect(el.value).toBe("B1 (4-bedded)");
  });

  test("a radio group with a selection keeps it", () => {
    document.body.innerHTML = `
      <input type="radio" name="r" id="a" value="Yes"><input type="radio" name="r" id="b" value="No">`;
    const els = Array.from(document.querySelectorAll("input[name=r]"));
    els[1].checked = true;
    expect(apply.applyOne(els, "Yes").status).toBe("skipped");
    expect(els.map((e) => e.checked)).toEqual([false, true]);
  });

  test("a ticked checkbox is never cleared, but an empty one still fills", () => {
    document.body.innerHTML = `<input type="checkbox" id="c" checked>`;
    expect(apply.applyOne(document.getElementById("c"), "No").status).toBe("skipped");
    expect(document.getElementById("c").checked).toBe(true);

    document.body.innerHTML = `<input type="checkbox" id="d">`;
    expect(apply.applyOne(document.getElementById("d"), "Yes").status).toBe("filled");
    expect(document.getElementById("d").checked).toBe(true);
  });

  test("a second fill of the same step writes nothing", () => {
    // Idempotency now comes from this rule rather than from re-writing the
    // same value, which matters because the panel re-fills as a wizard moves.
    document.body.innerHTML = `<input type="text" id="t">`;
    const el = document.getElementById("t");
    expect(apply.applyOne(el, "Raffles Hospital").status).toBe("filled");
    expect(apply.applyOne(el, "Raffles Hospital").status).toBe("skipped");
    expect(el.value).toBe("Raffles Hospital");
  });
});

/**
 * Multi-select checkbox groups, and what an empty one means.
 *
 * The list decides. An explicit "none of the above" makes empty legible as
 * unanswered; without one, empty means either "not yet answered" or "none of
 * these apply" and nothing can separate the two.
 */
describe("an empty checkbox group", () => {
  function group(optionLabels) {
    document.body.innerHTML = `<fieldset><legend>Which complications occurred?</legend>${optionLabels
      .map(
        (t, i) =>
          `<input type="checkbox" name="comp" id="o${i}" value="${t}"><label for="o${i}">${t}</label>`
      )
      .join("")}</fieldset>`;
    return Array.from(document.querySelectorAll("input[name=comp]"));
  }
  const labelOf = (el) =>
    document.querySelector(`label[for="${el.id}"]`)?.textContent ?? "";

  test("is fillable when the list offers 'none of the above'", () => {
    const els = group(["Bleeding", "Infection", "None of the above"]);
    const result = apply.applyOne(els, "Infection", { labelOf });
    expect(result.status).toBe("filled");
    expect(els[1].checked).toBe(true);
  });

  test.each(["None", "Not applicable", "N/A", "none of the above"])(
    "%s counts as an explicit none option",
    (none) => {
      const els = group(["Bleeding", none]);
      expect(apply.applyOne(els, "Bleeding", { labelOf }).status).toBe("filled");
    }
  );

  test("is left alone when the list offers no way to say 'none'", () => {
    // Empty here means either unanswered or "none of these apply", and
    // guessing between them is how a wrong clinical tick gets signed.
    const els = group(["Bleeding", "Infection"]);
    const result = apply.applyOne(els, "Infection", { labelOf });
    expect(result.status).toBe("skipped");
    expect(els.every((e) => !e.checked)).toBe(true);
  });

  test("'No known allergies' is not mistaken for a none option", () => {
    // The pattern must match a refusal of the whole list, not any option that
    // happens to start with "no".
    const els = group(["Penicillin", "No known allergies"]);
    expect(apply.applyOne(els, "Penicillin", { labelOf }).status).toBe("skipped");
  });

  test("an empty RADIO group is still fillable — it is single-select", () => {
    document.body.innerHTML = `
      <input type="radio" name="r" id="a" value="Yes"><input type="radio" name="r" id="b" value="No">`;
    const els = Array.from(document.querySelectorAll("input[name=r]"));
    expect(apply.applyOne(els, "Yes").status).toBe("filled");
  });
});

/**
 * Repeating dropdown questions.
 *
 * A question the doctor may answer several times renders as several selects,
 * one per instance, created by clicking the form's own "add another" button.
 * BreezeFill never clicks that button — creating an instance is the doctor
 * using the form. It fills the instances that already exist, and it must never
 * put the same option in two of them.
 */
describe("a repeating dropdown question", () => {
  const OPTS = ["", "Diabetes", "Hypertension", "Asthma"];

  function instances(n) {
    document.body.innerHTML = Array.from({ length: n })
      .map(
        (_, i) =>
          `<select id="dx${i}" name="dx[${i}]">${OPTS.map(
            (o) => `<option value="${o}">${o || "— Select —"}</option>`
          ).join("")}</select>`
      )
      .join("");
    return Array.from(document.querySelectorAll("select"));
  }

  /** The shape applyPlan wants: a matched report plus a ref->element map. */
  function planFor(els, values) {
    const elements = new Map();
    const results = els.map((el, i) => {
      elements.set(`c${i}`, el);
      return { fieldId: `dx_${i}`, status: "matched", control: { ref: `c${i}` } };
    });
    return [{ safeToFill: true, results }, elements, values];
  }

  test("two instances never receive the same option", () => {
    const els = instances(2);
    // The model answered both instances with the same condition.
    const [report, elements, values] = planFor(els, {
      dx_0: "Diabetes",
      dx_1: "Diabetes",
    });
    const out = apply.applyPlan(report, elements, values);

    expect(out.applied[0].status).toBe("filled");
    expect(out.applied[1].status).toBe("skipped");
    expect(out.applied[1].reason).toMatch(/already chosen/);
    expect(els[0].value).toBe("Diabetes");
    expect(els[1].value).toBe("");
  });

  test("different options in different instances both fill", () => {
    const els = instances(2);
    const [report, elements, values] = planFor(els, {
      dx_0: "Diabetes",
      dx_1: "Asthma",
    });
    const out = apply.applyPlan(report, elements, values);

    expect(out.filled).toBe(2);
    expect(els.map((e) => e.value)).toEqual(["Diabetes", "Asthma"]);
  });

  test("an option the doctor already chose by hand is not reused", () => {
    // Their choice occupies that option as firmly as one of ours, and the
    // instance they answered is left alone by the never-overwrite rule.
    const els = instances(2);
    els[0].value = "Hypertension";
    const [report, elements, values] = planFor(els, {
      dx_0: "Diabetes",
      dx_1: "Hypertension",
    });
    const out = apply.applyPlan(report, elements, values);

    expect(out.applied[0].reason).toBe("already answered");
    expect(out.applied[1].reason).toMatch(/already chosen/);
    expect(els.map((e) => e.value)).toEqual(["Hypertension", ""]);
  });

  test("unrelated dropdowns with different option lists are not grouped", () => {
    document.body.innerHTML = `
      <select id="a"><option value=""></option><option>Diabetes</option><option>Asthma</option></select>
      <select id="b"><option value=""></option><option>Diabetes</option><option>Ward B1</option></select>`;
    const els = Array.from(document.querySelectorAll("select"));
    const [report, elements, values] = planFor(els, { dx_0: "Diabetes", dx_1: "Diabetes" });
    const out = apply.applyPlan(report, elements, values);

    // Same value, but two different questions — both are legitimate.
    expect(out.filled).toBe(2);
  });
});

describe("none-of-the-above synonyms", () => {
  function groupWith(noneLabel) {
    document.body.innerHTML = `<fieldset><legend>Complications</legend>
      <input type="checkbox" name="c" id="a" value="Bleeding"><label for="a">Bleeding</label>
      <input type="checkbox" name="c" id="b" value="${noneLabel}"><label for="b">${noneLabel}</label>
      </fieldset>`;
    return Array.from(document.querySelectorAll("input[name=c]"));
  }
  const labelOf = (el) => document.querySelector(`label[for="${el.id}"]`)?.textContent ?? "";

  test.each([
    "None of the above", "None", "NONE OF THESE", "Not applicable", "N/A", "n.a.",
    "Nil", "Neither", "Does not apply", "Not relevant", "None apply",
  ])("%s is recognised as a way of saying none", (none) => {
    expect(apply.applyOne(groupWith(none), "Bleeding", { labelOf }).status).toBe("filled");
  });

  test.each([
    "No known allergies", "No complications", "Normal", "None detected on imaging",
  ])("%s is an answer, not a refusal of the list", (label) => {
    // A miss here is safe: the group reads as ambiguous and is left for the
    // doctor. A false match would invite a tick on a question nobody answered.
    expect(apply.applyOne(groupWith(label), "Bleeding", { labelOf }).status).toBe("skipped");
  });
});
