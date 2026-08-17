/**
 * @vitest-environment jsdom
 *
 * Browser-side redaction (extension/privacy/redact.js).
 *
 * The first block is the important one and it is not really a test of this
 * file: it runs `tests/fixtures/redaction_corpus.json`, the SAME corpus
 * `tests/test_redaction_corpus.py` runs against the Python. Twelve notes, each
 * declaring what must be gone and what must survive.
 *
 * That shared file is the answer to the one real objection to redacting in the
 * browser — two implementations of one rule, drifting. A pattern fixed in
 * Python and not here now fails here, loudly, in this suite, instead of
 * quietly sending a patient's name to a model.
 *
 * The blocks after it cover the failure modes that belong to *this* copy:
 * fail-closed behaviour, and the entry points that must refuse rather than
 * return something that looks redacted.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REDACT_JS = readFileSync(resolve(HERE, "redact.js"), "utf8");
const PATTERNS = JSON.parse(readFileSync(resolve(HERE, "patterns.json"), "utf8"));
const CORPUS = JSON.parse(
  readFileSync(resolve(HERE, "../../tests/fixtures/redaction_corpus.json"), "utf8")
);

function load({ withPatterns = true } = {}) {
  delete globalThis.breezefillRedact;
  // eslint-disable-next-line no-eval
  (0, eval)(REDACT_JS);
  const api = globalThis.breezefillRedact;
  if (withPatterns) api.usePatterns(PATTERNS);
  return api;
}

let redactor;
beforeEach(() => {
  redactor = load();
});

describe("the shared corpus, run against the browser's copy", () => {
  // Deterministic cases only. `sweep_only` marks a case whose identifier is a
  // third party nobody typed — no dictionary entry, no shape — which only the
  // server's LLM sweep can catch. Asserting it here would be asserting that
  // this module does something it is documented not to do.
  const deterministic = CORPUS.cases.filter((c) => !c.sweep_only);

  test("there are cases to run, and the file was actually read", () => {
    // A corpus that silently became empty would make every test below pass.
    expect(deterministic.length).toBeGreaterThan(8);
  });

  for (const useCase of deterministic) {
    test(`${useCase.id}: every identifier is gone`, () => {
      const { redacted_text: out } = redactor.redact(useCase.patient, useCase.note);
      for (const identifier of useCase.must_not_survive) {
        expect(out).not.toContain(identifier);
      }
    });

    test(`${useCase.id}: the clinical content survives`, () => {
      // Over-redaction is safe for privacy and useless for the product: a note
      // redacted down to tokens answers no questions on the form.
      const { redacted_text: out } = redactor.redact(useCase.patient, useCase.note);
      for (const kept of useCase.must_survive) {
        expect(out).toContain(kept);
      }
    });
  }
});

describe("the patterns are shared, not copied", () => {
  test("nothing is redacted until the shared file is loaded", () => {
    // The worst version of this module's worst bug: patterns absent, redaction
    // running anyway, output that looks processed and removed nothing.
    const cold = load({ withPatterns: false });
    expect(cold.ready()).toBe(false);
    expect(() => cold.redact({ full_name: "Tan Ah Kow", dob: "1962-11-04" }, "Tan Ah Kow"))
      .toThrow(/not loaded/i);
  });

  test("an empty pattern file is refused, not accepted as 'no patterns'", () => {
    const cold = load({ withPatterns: false });
    expect(() => cold.usePatterns({ patterns: [] })).toThrow(/no patterns/i);
    expect(() => cold.usePatterns(null)).toThrow(/no patterns/i);
  });

  test("every shape in the file compiles in this language too", () => {
    // The file is shared with Python, and a regex valid there but not here is
    // exactly the drift this arrangement exists to prevent.
    for (const entry of PATTERNS.patterns) {
      expect(() => new RegExp(entry.regex, entry.ignore_case ? "gi" : "g")).not.toThrow();
    }
  });
});

describe("it fails closed", () => {
  const NOTE = "Tan Ah Kow, NRIC S6211043C, seen today.";

  test("no name means no redaction, and no output", () => {
    // A name has no shape. Without one the patterns cannot find it, so text
    // that came back would read as redacted and would still carry the name.
    expect(() => redactor.redact({ dob: "1962-11-04" }, NOTE)).toThrow(/name/i);
    expect(() => redactor.redact({ full_name: "   ", dob: "1962-11-04" }, NOTE)).toThrow(/name/i);
  });

  test("no date of birth is refused for the same reason", () => {
    // Every date in a clinical note is date-shaped, so the pattern pass cannot
    // pick the birth date out. Only the doctor's own entry can.
    expect(() => redactor.redact({ full_name: "Tan Ah Kow" }, NOTE)).toThrow(/date of birth/i);
  });

  test("a non-string note throws rather than being coerced", () => {
    expect(() => redactor.redact({ full_name: "Tan Ah Kow", dob: "1962-11-04" }, null))
      .toThrow(/nothing to redact/i);
  });

  test("nothing it throws is ever the note", () => {
    // The failure mode this whole block exists for: an error whose message
    // quotes the input, logged or shown, putting the note somewhere it was
    // never meant to be.
    const attempts = [
      () => redactor.redact({ dob: "1962-11-04" }, NOTE),
      () => redactor.redact({ full_name: "Tan Ah Kow" }, NOTE),
      () => redactor.redact({ full_name: "Tan Ah Kow", dob: "1962-11-04" }, undefined),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow();
      try {
        attempt();
      } catch (error) {
        expect(error.message).not.toContain("Tan Ah Kow");
        expect(error.message).not.toContain("S6211043C");
      }
    }
  });
});

describe("the map stays here", () => {
  test("real values come back only through remerge", () => {
    const { redacted_text: out, redaction_map: map } = redactor.redact(
      { full_name: "Tan Ah Kow", nric: "S6211043C", dob: "1962-11-04" },
      "Tan Ah Kow, NRIC S6211043C, admitted 14/03/2026."
    );
    expect(out).toContain("[PATIENT]");
    expect(redactor.remerge(out, map)).toContain("Tan Ah Kow");
    expect(redactor.remerge(out, map)).toContain("S6211043C");
  });

  test("a token the model invented is shown, not blanked", () => {
    // `[NRIC_7]` on the review screen is a doctor noticing something is wrong.
    // An empty box is a doctor filling it in and never knowing.
    expect(redactor.remerge("Admitted on [DOB_9]", {})).toBe("Admitted on [DOB_9]");
  });

  test("the map is a null-prototype object, so a note cannot reach a prototype", () => {
    const { redaction_map: map } = redactor.redact(
      { full_name: "Tan Ah Kow", dob: "1962-11-04" },
      "Tan Ah Kow seen today."
    );
    expect(Object.getPrototypeOf(map)).toBe(null);
  });
});

describe("the name rules, which are the ones with judgement in them", () => {
  test("a short surname does not eat pronouns", () => {
    const { redacted_text: out } = redactor.redact(
      { full_name: "He Xiao Ming", dob: "1980-01-02" },
      "He Xiao Ming attended. he reports the pain has settled."
    );
    expect(out).toContain("he reports");
    expect(out).not.toContain("He Xiao Ming");
  });

  test("a surname inside a longer word survives", () => {
    // The patient is surnamed Ang; "angina" is the diagnosis the form wants.
    const { redacted_text: out } = redactor.redact(
      { full_name: "Ang Beng Hock", dob: "1955-06-06" },
      "Ang Beng Hock, stable angina on exertion."
    );
    expect(out).toContain("angina");
  });

  test("the name broken across a line break is still one name", () => {
    const { redacted_text: out } = redactor.redact(
      { full_name: "Tan Ah Kow", dob: "1962-11-04" },
      "Patient: Tan Ah\nKow presents today."
    );
    expect(out).not.toContain("Tan Ah");
    expect(out).not.toContain("Kow");
  });

  test("runs of name tokens collapse to one", () => {
    const { redacted_text: out } = redactor.redact(
      { full_name: "Tan Ah Kow", dob: "1962-11-04" },
      "Tan Ah Kow seen today."
    );
    expect(out.startsWith("[PATIENT] seen today")).toBe(true);
  });
});
