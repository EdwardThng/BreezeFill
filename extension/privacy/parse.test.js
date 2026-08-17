/**
 * @vitest-environment jsdom
 *
 * The browser half of the demographics parity corpus.
 *
 * `tests/fixtures/demographics_corpus.json` is read here and by
 * `tests/test_demographics_corpus.py`. Same fourteen notes, same expected
 * record. If the two parsers ever disagree about one of them, one of these two
 * suites goes red — which is the whole reason parsing was allowed to move into
 * the browser at all.
 *
 * The blocks after the corpus cover what belongs to this copy alone: refusing
 * to run before the shared shapes are loaded, and the handful of places where
 * JavaScript would quietly do something Python does not.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PARSE_JS = readFileSync(resolve(HERE, "parse.js"), "utf8");
const PATTERNS = JSON.parse(readFileSync(resolve(HERE, "patterns.json"), "utf8"));
const CORPUS = JSON.parse(
  readFileSync(resolve(HERE, "../../tests/fixtures/demographics_corpus.json"), "utf8")
);

const FIELDS = [
  "full_name", "nric", "dob", "phone", "address", "policy_number", "insurer",
];

function load({ withPatterns = true } = {}) {
  delete globalThis.breezefillParse;
  // eslint-disable-next-line no-eval
  (0, eval)(PARSE_JS);
  const api = globalThis.breezefillParse;
  if (withPatterns) api.usePatterns(PATTERNS);
  return api;
}

let parser;
beforeEach(() => {
  parser = load();
});

describe("the parity corpus", () => {
  test("the corpus was actually read", () => {
    expect(CORPUS.cases.length).toBeGreaterThanOrEqual(14);
  });

  for (const useCase of CORPUS.cases) {
    test(`${useCase.id}: the values match the other language`, () => {
      const parsed = parser.parseDemographics(useCase.note, useCase.known_name);
      for (const field of FIELDS) {
        expect(parsed[field], field).toBe(useCase.expect[field]);
      }
    });

    test(`${useCase.id}: so does where each one came from`, () => {
      // "labelled" and "sole-match" are different amounts of evidence. A
      // change that moved a field between them would pass a values-only
      // assertion while having changed what the parser is willing to believe.
      const parsed = parser.parseDemographics(useCase.note, useCase.known_name);
      expect(parsed.sources).toEqual(useCase.expect.sources);
    });

    test(`${useCase.id}: and so do the questions it refused to answer`, () => {
      const parsed = parser.parseDemographics(useCase.note, useCase.known_name);
      expect(parsed.choices).toEqual(useCase.expect.choices);
    });
  }
});

describe("it refuses to run half-configured", () => {
  test("nothing parses before the shared shapes are loaded", () => {
    // The dangerous shape of this bug: a parser with no idea what an NRIC
    // looks like returns an empty record, which is indistinguishable from a
    // note that mentioned nothing — and an empty record is an empty redaction
    // dictionary.
    const cold = load({ withPatterns: false });
    expect(cold.ready()).toBe(false);
    expect(() => cold.parseDemographics("NRIC S8012345D")).toThrow(/not loaded/i);
  });

  test("a pattern file missing a shape is refused, not worked around", () => {
    const cold = load({ withPatterns: false });
    const partial = { patterns: PATTERNS.patterns.filter((p) => p.field !== "nric") };
    expect(() => cold.usePatterns(partial)).toThrow(/nric/i);
  });
});

describe("the places JavaScript would differ from Python if nobody looked", () => {
  test("an impossible date is refused rather than rolled over", () => {
    // new Date(2026, 3, 31) is 1 May in JavaScript and a ValueError in Python.
    // Without the round-trip check, 31/04/1978 would become a birth date.
    expect(parser.parseDate("31/04/1978")).toBe(null);
    expect(parser.parseDate("30/04/1978")).toBe("1978-04-30");
  });

  test("a date in the future is not a birth date", () => {
    expect(parser.parseDate("01/01/2099")).toBe(null);
  });

  test("a date before 1900 is not one either", () => {
    expect(parser.parseDate("01/01/1899")).toBe(null);
  });

  test("the day is read first, the way Singapore writes it", () => {
    // 03/04/1971 is 3 April. Reading it the other way would put a wrong birth
    // date on a claim nine times out of twelve.
    expect(parser.parseDate("03/04/1971")).toBe("1971-04-03");
  });

  test("a two-digit year is not a date at all", () => {
    expect(parser.parseDate("14/03/78")).toBe(null);
  });

  test("an insurer is matched as a whole word, not inside one", () => {
    // "AIA" inside "MEDIAID" would otherwise write an insurer onto a claim.
    expect(parser.canonicalInsurer("MEDIAIA")).toBe(null);
    expect(parser.canonicalInsurer("AIA Singapore")).toBe("AIA");
  });

  test("a paste of nothing is an empty record, not a crash", () => {
    for (const empty of ["", "   \n\n", null, undefined]) {
      const parsed = parser.parseDemographics(empty);
      expect(parsed.full_name).toBe(null);
      expect(parsed.choices).toEqual({});
    }
  });
});
