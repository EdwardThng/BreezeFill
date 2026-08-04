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
