/**
 * @vitest-environment jsdom
 *
 * Tests for the learn-mode dumper.
 *
 * The first block is the one that matters: it asserts that no synthetic
 * identifier planted in tests/fixtures/portal_like.html survives into a dump,
 * by any route. This is the same guarantee tests/test_redaction_corpus.py
 * gives for clinical text, applied to the authoring path — a schema author
 * pastes a dump into a model, so a dump is an LLM input and gets held to LLM
 * input rules.
 *
 * The rest cover label resolution, which is the key the filler will match on
 * and therefore the thing most likely to break silently.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

// Imported for side effects, then read off the global — dump.js is a plain
// IIFE that attaches itself to globalThis, because it has to run three ways:
// pasted into a DevTools console, injected as a content script, and here.
// Adding ESM exports for the test's benefit alone would mean the tested file
// is not the file that ships.
import "./dump.js";

const learn = globalThis.claimfillLearn;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../../tests/fixtures/portal_like.html");

// Every identifier planted in the fixture. If the fixture grows another one,
// add it here — the test is only as good as this list.
const PLANTED_IDENTIFIERS = [
  "Tan Wei Ming",
  "S1234567D",
  "9123 4567",
  "91234567",
  "weiming.tan@example.com",
  "80123456",
  "80123457",
  "14/03/1971",
  // The claim token from the hidden pid field: a bearer credential for the
  // patient's claim, and the single worst thing that could leak here.
  "276b138a-204b-4fb4-b8c3-2e90431ead0e",
];

function loadFixture() {
  document.documentElement.innerHTML = readFileSync(FIXTURE, "utf8");
}

function byName(dump, name) {
  return dump.controls.find((c) => c.name === name);
}

beforeEach(loadFixture);

// ---------------------------------------------------------------------------
// The content boundary
// ---------------------------------------------------------------------------

describe("content boundary", () => {
  test("no planted identifier appears anywhere in a dump", () => {
    const serialised = JSON.stringify(learn.dump());
    for (const identifier of PLANTED_IDENTIFIERS) {
      expect(serialised).not.toContain(identifier);
    }
  });

  test("no planted identifier survives a merge either", () => {
    const merged = learn.mergeDumps([learn.dump(), learn.dump()]);
    const serialised = JSON.stringify(merged);
    for (const identifier of PLANTED_IDENTIFIERS) {
      expect(serialised).not.toContain(identifier);
    }
  });

  test("populated controls report presence but never the value", () => {
    const dump = learn.dump();
    const name = byName(dump, "patientName");
    expect(name.hasValue).toBe(true);
    expect(Object.values(name).join(" ")).not.toContain("Tan Wei Ming");

    // An empty control is distinguishable from a populated one — that
    // distinction is the whole of what the dump says about content.
    expect(byName(dump, "diagnosis").hasValue).toBe(false);
  });

  test("page prose is never read, so a heading naming the patient cannot leak", () => {
    // Leak route 2: the fixture's <h1> is "Claim for Tan Wei Ming (S1234567D)".
    // Scrubbing alone would not save us here — it would strip the NRIC and
    // leave the name, because a name has no shape. The guarantee comes from
    // reading <legend> and never prose.
    const dump = learn.dump();
    expect(JSON.stringify(dump)).not.toContain("Claim for");
    expect(dump.stepHint).toBe("Section A — Patient details");
  });

  test("sections come from legends, not from the page heading", () => {
    expect(byName(learn.dump(), "patientName").section).toBe(
      "Section A — Patient details"
    );
  });

  test("an option list carrying claim data is withheld whole", () => {
    // Leak route 3: a policy picker that enumerates the patient. The number is
    // shaped and the name is not, so partial scrubbing would emit the name.
    const options = byName(learn.dump(), "policySelect").options;
    expect(options.withheld).toBe(true);
    expect(options.values).toEqual([]);
    expect(options.count).toBe(3);
  });

  test("a genuine enumeration is still reported", () => {
    // The withholding rule has to stay narrow or it takes the schema author's
    // most useful signal with it.
    const ward = byName(learn.dump(), "wardClass").options;
    expect(ward.withheld).toBe(false);
    expect(ward.values).toEqual(["-- Select --", "A", "B1", "B2", "C"]);
  });

  test("the page is flagged as PHI-bearing", () => {
    // Tells the author the raw DOM must not be shared alongside the dump.
    expect(learn.dump().scrubbedStrings).toBeGreaterThan(0);
  });

  test("password fields are counted but never inventoried", () => {
    const dump = learn.dump();
    expect(dump.skippedPasswordFields).toBe(1);
    expect(byName(dump, "portalPassword")).toBeUndefined();
  });

  test("hidden fields carrying the claim token are not inventoried", () => {
    expect(byName(learn.dump(), "pid")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

describe("scrub", () => {
  // What matters is that the identifier is gone, not which token replaced it.
  // Asserting the token over-specifies: an 8-digit SG policy number like
  // 80123456 is shape-identical to an SG mobile number, so it comes back
  // [PHONE] rather than [NUMBER]. Nothing downstream cares — the dump is an
  // authoring artefact, and wasScrubbed() (which drives option withholding)
  // only asks whether the string changed.
  test.each([
    ["NRIC S1234567D here", "S1234567D"],
    ["FIN g7654321x here", "g7654321x"],
    ["call 9123 4567", "9123 4567"],
    ["call +65 9123 4567", "9123 4567"],
    ["mail a.b+c@example.co.uk", "a.b+c@example.co.uk"],
    ["policy 80123456", "80123456"],
    ["ref 1234-5678-9012", "1234-5678-9012"],
  ])("removes the identifier in %s", (input, identifier) => {
    expect(learn.scrub(input)).not.toContain(identifier);
  });

  test("replaces with a token rather than deleting", () => {
    // A bare deletion would leave "policy " and lose the fact that something
    // was there, which matters when reading a dump by eye.
    expect(learn.scrub("NRIC S1234567D here")).toBe("NRIC [NRIC] here");
    expect(learn.scrub("mail a@b.com")).toBe("mail [EMAIL]");
  });

  test("leaves clinical and structural wording alone", () => {
    // False positives here cost schema quality: a mangled label is a label
    // the filler cannot match on later.
    for (const safe of [
      "Diagnosis of all conditions treated",
      "ICD-10 Code",
      "Ward class B2",
      "Date of onset and duration of complaints",
      "Tan Tock Seng Hospital",
    ]) {
      expect(learn.scrub(safe)).toBe(safe);
    }
  });

  test("collapses whitespace so labels compare cleanly", () => {
    expect(learn.scrub("  Patient's\n  Full Name ")).toBe("Patient's Full Name");
  });
});

// ---------------------------------------------------------------------------
// Label resolution — the filler's match key
// ---------------------------------------------------------------------------

describe("label resolution", () => {
  test.each([
    ["patientName", "Patient's Full Name (as in NRIC)", "label[for]"],
    ["patientNric", "NRIC / FIN Number", "aria-label"],
    ["contactNo", "Contact Number", "wrapping-label"],
    ["dob", "Date of Birth", "table-cell"],
    ["admissionDate", "Date of Admission", "ancestor-sibling"],
  ])("%s resolves via %s", (name, expectedLabel, expectedSource) => {
    const control = byName(learn.dump(), name);
    expect(control.label).toBe(expectedLabel);
    expect(control.labelSource).toBe(expectedSource);
  });

  test("a wrapping label does not absorb its select's option text", () => {
    // Regression: cloning without stripping the control pulls every <option>
    // into the label and buries the question.
    const ward = byName(learn.dump(), "wardClass");
    expect(ward.label).toBe("Ward class");
    expect(ward.label).not.toContain("B1");
  });

  test("every control reports how its label was found", () => {
    // Anything resolved by proximity rather than by association is a weaker
    // match key, and the schema author needs to see which is which rather
    // than trusting every label equally.
    const known = [
      "aria-label",
      "aria-labelledby",
      "label[for]",
      "wrapping-label",
      "table-cell",
      "preceding-sibling",
      "ancestor-sibling",
      "placeholder",
      "section-heading",
      "none",
    ];
    for (const control of learn.dump().controls) {
      expect(known).toContain(control.labelSource);
    }
  });

  test("a control is never labelled with a neighbouring control's options", () => {
    // Regression, found on RoboForm: three <select>s in a row for a date, so
    // each one's previous sibling is another <select> and rawTextOf() returned
    // its entire option list as the "label". Junk as a match key, and worse, a
    // route around buildOptions()'s withholding rule — an option list that
    // enumerates patients would have been emitted as a label instead.
    const row = document.createElement("div");
    row.innerHTML =
      '<div class="col">Date Of Birth</div>' +
      '<div class="col">' +
      '<select name="dobMonth"><option>Jan</option><option>Feb</option></select>' +
      '<select name="dobYear"><option>1971</option><option>1972</option></select>' +
      "</div>";
    document.querySelector("#claim-form").append(row);

    const dump = learn.dump();
    for (const name of ["dobMonth", "dobYear"]) {
      const control = byName(dump, name);
      expect(control.label).toBe("Date Of Birth");
      expect(control.label).not.toContain("Jan");
    }
  });

  test("prose next to a control is not a label, however close it sits", () => {
    // The <p> beside proseTrap reads "Claim for Tan Wei Ming (S1234567D)".
    // Scrubbing cannot save this one — it takes the NRIC and leaves the name,
    // because a name has no shape. The guarantee is the same as sectionFor()'s:
    // prose is not read at all. An unlabelled control costs a schema author a
    // minute; a leaked name is a breach.
    const control = byName(learn.dump(), "proseTrap");
    expect(control.label).toBe("");
    expect(control.labelSource).toBe("none");
  });

  test("the walk up stops before it leaves the control's own fieldset", () => {
    // Rule 6 climbs through containers, and the thing above the outermost one
    // is page chrome. Two hops is the budget; a label further away than that
    // belongs to a different question anyway.
    const deep = document.createElement("div");
    deep.innerHTML =
      "<div>Attending Physician</div>" +
      '<div><div><div><input type="text" name="tooDeep" /></div></div></div>';
    document.querySelector("#claim-form").append(deep);

    expect(byName(learn.dump(), "tooDeep").label).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("structure", () => {
  test("radios sharing a name collapse into one question", () => {
    const group = byName(learn.dump(), "surgeryDone");
    expect(group.type).toBe("radio-group");
    expect(group.options.values).toEqual(["Yes", "No"]);
    // Not two separate controls.
    expect(learn.dump().controls.filter((c) => c.name === "surgeryDone")).toHaveLength(1);
  });

  test("checkboxes stay individual", () => {
    expect(byName(learn.dump(), "preExisting").type).toBe("checkbox");
  });

  test("maxLength is captured", () => {
    // The web equivalent of pypdf's /MaxLen comb-field trap: the portal
    // truncates silently and the doctor signs the truncated value.
    expect(byName(learn.dump(), "patientNric").maxLength).toBe(9);
    expect(byName(learn.dump(), "patientName").maxLength).toBe(60);
  });

  test("readonly and required are captured", () => {
    const dump = learn.dump();
    expect(byName(dump, "policyNo").readOnly).toBe(true);
    expect(byName(dump, "diagnosis").required).toBe(true);
  });

  test("hidden wizard steps are inventoried but marked not visible", () => {
    const mcr = byName(learn.dump(), "doctorMcr");
    expect(mcr).toBeDefined();
    expect(mcr.visible).toBe(false);
  });

  test("buttons and resets are not questions", () => {
    const types = learn.dump().controls.map((c) => c.type);
    expect(types).not.toContain("submit");
    expect(types).not.toContain("reset");
  });

  test("the full URL is never recorded, only the host", () => {
    // ?pid= is a bearer credential for the claim.
    const dump = learn.dump();
    expect(dump).not.toHaveProperty("url");
    expect(JSON.stringify(dump)).not.toContain("pid=");
  });
});

// ---------------------------------------------------------------------------
// Merging across wizard steps
// ---------------------------------------------------------------------------

describe("mergeDumps", () => {
  test("deduplicates controls seen on more than one step", () => {
    const once = learn.dump();
    const merged = learn.mergeDumps([once, once]);
    expect(merged.controlCount).toBe(once.controlCount);
  });

  test("prefers the capture where a control was visible", () => {
    const hidden = learn.dump();

    // Reveal the later step and re-capture, as running learn mode on step 3
    // would.
    document.getElementById("step-3").style.display = "block";
    const shown = learn.dump();

    const merged = learn.mergeDumps([hidden, shown]);
    expect(merged.controls.find((c) => c.name === "doctorMcr").visible).toBe(true);
  });

  test("returns null for nothing to merge", () => {
    expect(learn.mergeDumps([])).toBeNull();
    expect(learn.mergeDumps(null)).toBeNull();
  });
});
