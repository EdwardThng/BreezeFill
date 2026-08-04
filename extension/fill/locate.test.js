/**
 * @vitest-environment jsdom
 *
 * Tests for the hybrid matcher.
 *
 * The interesting cases are all refusals. Matching the obvious label is easy;
 * what protects the doctor is declining to match when the page is ambiguous or
 * has changed shape, because a value under the wrong question gets signed and
 * submitted as their own clinical statement.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import "../learn/dump.js";
import "./locate.js";

const learn = globalThis.breezefillLearn;
const locate = globalThis.breezefillLocate;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../../tests/fixtures/portal_like.html");

function liveControls() {
  return learn.collectControls(document).controls;
}

/** A schema plan the way the review screen would hand it over. */
const PLAN = [
  { fieldId: "diagnosis_and_symptoms", label: "Diagnosis of all conditions treated" },
  { fieldId: "diagnosis_code", label: "ICD-10 code" },
  { fieldId: "onset_and_duration", label: "Date of onset and duration of complaints" },
  { fieldId: "ward_class", label: "Ward class" },
];

beforeEach(() => {
  document.documentElement.innerHTML = readFileSync(FIXTURE, "utf8");
});

// ---------------------------------------------------------------------------

describe("normalisation", () => {
  test("ignores question numbering", () => {
    // Insurers renumber between revisions far more often than they reword.
    expect(locate.normalise("4a. Date of onset")).toBe("date of onset");
    expect(locate.normalise("(iii) Ward class")).toBe("ward class");
    expect(locate.normalise("3b ) ICD-10 Code")).toBe("icd 10 code");
  });

  test("ignores punctuation and case", () => {
    expect(locate.score("ICD-10 Code", "icd 10 code")).toBe(1);
  });

  test("drops filler words that vary without changing the question", () => {
    expect(locate.tokens("Please give the date of onset")).toEqual(["date", "onset"]);
  });
});

describe("scoring", () => {
  test("a short label does not fully match a longer unrelated one", () => {
    // Containment would score this 1.0. That is the adjacent-question error.
    expect(locate.score("Date", "Date of onset and duration of complaints")).toBeLessThan(
      locate.MIN_SCORE
    );
  });

  test("rewards genuine rewordings", () => {
    expect(
      locate.score("Diagnosis of all conditions treated", "Diagnosis of conditions treated")
    ).toBeGreaterThan(locate.MIN_SCORE);
  });

  test("unrelated questions score near zero", () => {
    expect(locate.score("Ward class", "ICD-10 code")).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------------------

describe("locating against the live page", () => {
  test("matches schema fields to the controls that ask them", () => {
    const { results } = locate.locate(PLAN, liveControls());
    const byId = Object.fromEntries(results.map((r) => [r.fieldId, r]));

    expect(byId.diagnosis_and_symptoms.status).toBe("matched");
    expect(byId.diagnosis_and_symptoms.control.name).toBe("diagnosis");
    expect(byId.diagnosis_code.control.name).toBe("icdCode");
    expect(byId.onset_and_duration.control.name).toBe("onsetDuration");
    expect(byId.ward_class.control.name).toBe("wardClass");
  });

  test("a fully matched plan is safe to fill", () => {
    const report = locate.locate(PLAN, liveControls());
    expect(report.matchRate).toBe(1);
    expect(report.safeToFill).toBe(true);
  });

  test("readonly and disabled controls are never matched", () => {
    // policyNo is readonly in the fixture. Filling it would either be ignored
    // or fight the portal's own state.
    const report = locate.locate(
      [{ fieldId: "policy_no", label: "Policy Number" }],
      liveControls()
    );
    expect(report.results[0].status).not.toBe("matched");
  });

  test("reports live controls the schema does not know about", () => {
    // Not an error — this is how a portal growing a question surfaces.
    const report = locate.locate(PLAN, liveControls());
    const labels = report.unknownControls.map((c) => c.label);
    expect(labels).toContain("Was surgery performed?");
  });
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

describe("refusals", () => {
  test("a tie fills neither control", () => {
    document.body.innerHTML = `
      <label for="a">Date of admission</label><input id="a" name="a" />
      <label for="b">Date of admission</label><input id="b" name="b" />
    `;
    const report = locate.locate(
      [{ fieldId: "admission", label: "Date of admission" }],
      liveControls()
    );
    expect(report.results[0].status).toBe("ambiguous");
    expect(report.results[0].control).toBeNull();
  });

  test("no plausible control leaves the field unmatched", () => {
    const report = locate.locate(
      [{ fieldId: "unrelated", label: "Vehicle registration number" }],
      liveControls()
    );
    expect(report.results[0].status).toBe("unmatched");
  });

  test("a redesigned portal fills nothing rather than filling part", () => {
    // The single most important behaviour here. Two of four fields still
    // match, which is exactly the case where a partial fill looks complete.
    document.body.innerHTML = `
      <label for="d">Diagnosis of all conditions treated</label><textarea id="d" name="d"></textarea>
      <label for="i">ICD-10 code</label><input id="i" name="i" />
      <label for="x">Claimant relationship to member</label><input id="x" name="x" />
      <label for="y">Preferred contact method</label><input id="y" name="y" />
    `;
    const report = locate.locate(PLAN, liveControls());

    expect(report.matched).toBe(2);
    expect(report.matchRate).toBe(0.5);
    expect(report.safeToFill).toBe(false);
  });

  test("two fields cannot claim the same control", () => {
    document.body.innerHTML = `
      <label for="only">Diagnosis of all conditions treated</label>
      <input id="only" name="only" />
    `;
    const report = locate.locate(
      [
        { fieldId: "first", label: "Diagnosis of all conditions treated" },
        { fieldId: "second", label: "Diagnosis of all conditions treated" },
      ],
      liveControls()
    );

    const statuses = report.results.map((r) => r.status).sort();
    expect(statuses).toEqual(["ambiguous", "matched"]);
    // And the one that did match is the one that scored highest, not whichever
    // happened to come first in the plan.
    expect(report.matched).toBe(1);
  });

  test("an empty plan is never safe to fill", () => {
    expect(locate.locate([], liveControls()).safeToFill).toBe(false);
  });

  test("a perfect match rate on a tiny plan is not enough", () => {
    // The hole a ratio alone leaves. One field matching one control is a
    // match rate of 1.0, which would call any page with a similar label
    // recognised. A sparse clinical note produces exactly this plan.
    const report = locate.locate(
      [{ fieldId: "diagnosis_and_symptoms", label: "Diagnosis of all conditions treated" }],
      liveControls()
    );

    expect(report.matched).toBe(1);
    expect(report.matchRate).toBe(1);
    expect(report.safeToFill).toBe(false);
  });

  test("the floor is on matches found, not fields asked for", () => {
    // Three fields where only two match is short on both counts; the point is
    // that padding a plan with unmatchable fields cannot buy safety.
    const report = locate.locate(PLAN.slice(0, 3), liveControls());
    expect(report.safeToFill).toBe(true);
    expect(report.matched).toBeGreaterThanOrEqual(locate.MIN_MATCHED);
  });
});

// ---------------------------------------------------------------------------
// Wizards
// ---------------------------------------------------------------------------
//
// The failure being fixed: a plan spanning two steps finds about half its
// fields on either, lands under MIN_MATCH_RATE, and nothing is written. The
// guard answers "wrong page" about the right page.

const STEP_ADMISSION = `
  <fieldset><legend>Admission details</legend>
    <label for="a1">Date of admission</label><input id="a1" />
    <label for="a2">Ward class</label><input id="a2" />
    <label for="a3">Hospital name</label><input id="a3" />
  </fieldset>`;

const STEP_DIAGNOSIS = `
  <fieldset><legend>Patient diagnosis</legend>
    <label for="d1">Diagnosis of all conditions treated</label><input id="d1" />
    <label for="d2">ICD-10 Code</label><input id="d2" />
    <label for="d3">Date of onset and duration of complaints</label><input id="d3" />
  </fieldset>`;

const WIZARD_PLAN = [
  { fieldId: "admitted", label: "Date of admission", step: "Admission details" },
  { fieldId: "ward", label: "Ward class", step: "Admission details" },
  { fieldId: "hospital", label: "Hospital name", step: "Admission details" },
  { fieldId: "diagnosis", label: "Diagnosis of all conditions treated", step: "Patient diagnosis" },
  { fieldId: "icd", label: "ICD-10 Code", step: "Patient diagnosis" },
  { fieldId: "onset", label: "Date of onset and duration of complaints", step: "Patient diagnosis" },
];

function render(...steps) {
  document.documentElement.innerHTML = `<body><form>${steps.join("")}</form></body>`;
}

describe("one step at a time", () => {
  test("the whole plan against one rendered step is exactly the old refusal", () => {
    // Pins the bug rather than the fix. Half the plan is present, so the rate
    // is 0.5 and the filler writes nothing — on the correct form.
    render(STEP_ADMISSION);
    const report = locate.locate(WIZARD_PLAN, liveControls());

    expect(report.matched).toBe(3);
    expect(report.intended).toBe(6);
    expect(report.matchRate).toBe(0.5);
    expect(report.safeToFill).toBe(false);
  });

  test("scored per step, the rendered step fills and the other waits", () => {
    render(STEP_ADMISSION);
    const report = locate.locateSteps(WIZARD_PLAN, liveControls());

    expect(report.safeToFill).toBe(true);
    expect(report.matched).toBe(3);
    // The denominator is the step on screen, not the form.
    expect(report.intended).toBe(3);
    expect(report.deferred).toBe(3);
    expect(report.results.map((r) => r.fieldId).sort()).toEqual(["admitted", "hospital", "ward"]);
  });

  test("the step that is not rendered is reported absent, not failed", () => {
    render(STEP_ADMISSION);
    const { steps } = locate.locateSteps(WIZARD_PLAN, liveControls());
    const byStep = Object.fromEntries(steps.map((s) => [s.step, s]));

    expect(byStep["Admission details"].present).toBe(true);
    expect(byStep["Patient diagnosis"].present).toBe(false);
    expect(byStep["Patient diagnosis"].matched).toBe(0);
  });

  test("two steps on screen at once both fill, and no control is claimed twice", () => {
    render(STEP_ADMISSION, STEP_DIAGNOSIS);
    const report = locate.locateSteps(WIZARD_PLAN, liveControls());

    expect(report.safeToFill).toBe(true);
    expect(report.matched).toBe(6);
    expect(report.deferred).toBe(0);
    const refs = report.results.filter((r) => r.status === "matched").map((r) => r.control.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  test("a page belonging to no step still refuses", () => {
    render(`<form><label for="x">Favourite colour</label><input id="x" /></form>`);
    const report = locate.locateSteps(WIZARD_PLAN, liveControls());

    expect(report.safeToFill).toBe(false);
    // The breakdown still travels, so the panel can say what it was expecting.
    expect(report.steps.every((s) => s.present === false)).toBe(true);
  });

  test("MIN_MATCH_RATE is not softened — a half-present step is not filled", () => {
    // The fix must not become "lower the threshold". This step has four
    // fields and two of them are here: 0.5, the same number that refuses on a
    // single-step form, and it refuses here too.
    render(`
      <fieldset><legend>Admission details</legend>
        <label for="a1">Date of admission</label><input id="a1" />
        <label for="a2">Ward class</label><input id="a2" />
      </fieldset>`);
    const plan = [
      ...WIZARD_PLAN.slice(0, 3),
      { fieldId: "referrer", label: "Referring doctor", step: "Admission details" },
    ];
    const report = locate.locateSteps(plan, liveControls());

    expect(report.safeToFill).toBe(false);
  });

  test("a plan with no steps takes the path it always did", () => {
    document.documentElement.innerHTML = readFileSync(FIXTURE, "utf8");
    const controls = liveControls();
    const stepless = locate.locate(PLAN, controls);
    const through = locate.locateSteps(PLAN, controls);

    expect(through.matched).toBe(stepless.matched);
    expect(through.matchRate).toBe(stepless.matchRate);
    expect(through.safeToFill).toBe(stepless.safeToFill);
    expect(through.steps).toEqual([]);
    expect(through.deferred).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Joining the page's questions to the bank's instructions
// ---------------------------------------------------------------------------
//
// The bank stopped being a gate on 2026-08-05. Every question on the page gets
// answered; a schema match only decides how well each one is put to the model.

const SCHEMA_FIELDS = [
  {
    fieldId: "first_consult",
    label: "Date of first consultation",
    description: "Date the patient FIRST consulted this doctor for this condition, not the latest visit",
    options: [],
  },
  {
    fieldId: "ward",
    label: "Ward class",
    description: "Ward class the patient was admitted to",
    options: ["A1 (single)", "B1 (4-bedded)"],
  },
];

describe("enriching live controls", () => {
  test("a described control gets the instruction, not the page's wording", () => {
    // Numbering and case differ, which is what a real page does to a label a
    // schema was authored from.
    const [field] = locate.enrich(
      [{ ref: "c1", label: "7. Date of First Consultation", type: "text", options: [] }],
      SCHEMA_FIELDS
    );

    expect(field.description).toMatch(/FIRST consulted this doctor/);
    expect(field.describedBy).toBe("first_consult");
  });

  test("a described control travels under the schema's label, not the page's", () => {
    // A privacy property, not a cosmetic one: on a page the bank fully
    // describes, nothing of the page's own text leaves the browser.
    const [field] = locate.enrich(
      [{ ref: "c1", label: "7. Date of First Consultation", type: "text", options: [] }],
      SCHEMA_FIELDS
    );

    expect(field.label).toBe("Date of first consultation");
  });

  test("the same question worded differently is NOT matched, and that is the limit", () => {
    // "7. When did the patient first consult you" and "Date of first
    // consultation" are the same question and share one content token, so they
    // score 0.22 — well under MIN_SCORE. Enrichment is only as good as the
    // label scorer, and the scorer compares words rather than meaning.
    //
    // Failing this way is the safe direction: the control is still filled from
    // its own label, just without the schema's sharper instruction. But it is
    // why a web schema should be authored from the page's own wording — which
    // is exactly what the draft-schema flow produces — rather than from the
    // labels of the equivalent PDF form.
    const [field] = locate.enrich(
      [{ ref: "c1", label: "7. When did the patient first consult you", type: "text", options: [] }],
      SCHEMA_FIELDS
    );

    expect(field.describedBy).toBeNull();
    expect(field.label).toBe("7. When did the patient first consult you");
  });

  test("an undescribed control is still a question, answered from its own label", () => {
    const [field] = locate.enrich(
      [{ ref: "c1", label: "Referring doctor's MCR number", type: "text", options: [] }],
      SCHEMA_FIELDS
    );

    expect(field.description).toBeNull();
    expect(field.describedBy).toBeNull();
    // The point of the whole change: it is not dropped.
    expect(field.label).toBe("Referring doctor's MCR number");
  });

  test("a weak match attaches nothing rather than the wrong instruction", () => {
    // Worse than no instruction: it would confidently tell the model to answer
    // a different question than the one on screen, and unlike a mislocated
    // value there is nothing on the page to make that visible in review.
    const [field] = locate.enrich(
      [{ ref: "c1", label: "Favourite colour", type: "text", options: [] }],
      SCHEMA_FIELDS
    );

    expect(field.describedBy).toBeNull();
  });

  test("one schema field cannot describe two controls", () => {
    const fields = locate.enrich(
      [
        { ref: "c1", label: "Ward class", type: "text", options: [] },
        { ref: "c2", label: "Ward class", type: "text", options: [] },
      ],
      SCHEMA_FIELDS
    );

    expect(fields.filter((f) => f.describedBy === "ward")).toHaveLength(1);
  });

  test("the control's own options win over the schema's", () => {
    // A schema's list describes the form as authored; the control's describes
    // what it will accept today.
    const [field] = locate.enrich(
      [{ ref: "c1", label: "Ward class", type: "select", options: ["B2 (6-bedded)", "C (open)"] }],
      SCHEMA_FIELDS
    );

    expect(field.options).toEqual(["B2 (6-bedded)", "C (open)"]);
  });

  test("a control with no options of its own inherits the schema's", () => {
    const [field] = locate.enrich(
      [{ ref: "c1", label: "Ward class", type: "select", options: [] }],
      SCHEMA_FIELDS
    );

    expect(field.options).toEqual(["A1 (single)", "B1 (4-bedded)"]);
  });

  test("no schema at all still yields every question", () => {
    const controls = [
      { ref: "c1", label: "Ward class", type: "text", options: [] },
      { ref: "c2", label: "Date of admission", type: "date", options: [] },
    ];

    const fields = locate.enrich(controls, []);
    expect(fields).toHaveLength(2);
    expect(fields.every((f) => f.describedBy === null)).toBe(true);
  });

  test("withheld option lists arrive empty, never as claim data", () => {
    // collectControls withholds a list whose scrubbing changed anything — a
    // policy picker reading "80123456 — Tan Wei Ming — GHS" is claim data, not
    // choices. liveControls carries that decision through as an empty list.
    render(`<form><label for="p">Policy under claim</label>
      <select id="p"><option>80123456 - patient - GHS</option></select></form>`);
    const report = locate.locate([], liveControls());
    const policy = report.liveControls.find((c) => c.label.includes("Policy"));

    expect(policy).toBeTruthy();
    expect(policy.options).toEqual([]);
  });
});
