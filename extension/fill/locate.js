/**
 * ClaimFill filler — locating controls (the hybrid's join).
 *
 * The schema says what a field MEANS. The live page says where it IS. This
 * module joins the two by label text.
 *
 * Why the join is by label and not by selector: selectors rot. Framework
 * builds regenerate ids and class names on every release, and a static
 * selector map goes stale silently — it matches nothing and the form comes
 * back blank, or worse, matches the wrong thing. Question wording is far more
 * stable, because insurers are regulated on what they ask, not on how they
 * mark it up. `selector` stays in the schema as a tiebreaker, never as the
 * primary key.
 *
 * ---------------------------------------------------------------------------
 * Precision over coverage, applied to matching
 * ---------------------------------------------------------------------------
 *
 * Every ambiguous case here resolves to "don't fill it". A blank costs the
 * doctor seconds of typing; a value under the wrong question gets signed and
 * submitted as their own clinical statement. Concretely:
 *
 *   - Two live controls scoring equally for one schema field -> fill neither,
 *     report it ambiguous.
 *   - Score below MIN_SCORE -> no match, leave blank.
 *   - Match rate across the whole plan below MIN_MATCH_RATE -> the portal has
 *     probably been redesigned. Fill NOTHING and say so, rather than filling
 *     the two-thirds that still match and letting the doctor assume the rest
 *     were genuinely empty.
 *
 * That last one is the important one. A partial fill is indistinguishable
 * from a complete fill to someone reviewing quickly.
 */

(function (root) {
  "use strict";

  // Below this, a label pair is not the same question.
  const MIN_SCORE = 0.6;
  // Below this share of the plan matched, assume the page changed shape.
  const MIN_MATCH_RATE = 0.7;
  // Two candidates within this of each other are a tie, not a winner.
  const TIE_MARGIN = 0.05;

  // ------------------------------------------------------------------
  // Normalisation
  // ------------------------------------------------------------------

  // Leading question numbering: "4a.", "(iii)", "3b )", "12 -". Insurers
  // renumber questions between form revisions far more often than they reword
  // them, so the number is noise for matching purposes.
  const LEADING_NUMBER = /^[\s(]*(?:\d+\s*[a-z]?|[ivxlc]+)[\s.)\-:]+/i;

  // Wording that varies without changing the question.
  const NOISE_WORDS = new Set([
    "please",
    "the",
    "a",
    "an",
    "of",
    "for",
    "to",
    "in",
    "and",
    "or",
    "your",
    "any",
    "if",
    "is",
    "are",
    "was",
    "were",
    "give",
    "state",
    "indicate",
    "provide",
    "specify",
    "enter",
    "advise",
  ]);

  function normalise(text) {
    return String(text || "")
      .toLowerCase()
      .replace(LEADING_NUMBER, "")
      // Keep alphanumerics only; "ICD-10 Code" and "ICD 10 code" are the same
      // question, and punctuation differs freely between revisions.
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(text) {
    return normalise(text)
      .split(" ")
      .filter((t) => t && !NOISE_WORDS.has(t));
  }

  // ------------------------------------------------------------------
  // Scoring
  // ------------------------------------------------------------------

  /**
   * 0..1 similarity between two label strings.
   *
   * Dice coefficient over content tokens, with an exact-normalised-match
   * shortcut. Dice rather than raw containment because containment lets a
   * short label match a long unrelated one — "Date" would score 1.0 against
   * "Date of onset and duration of complaints", which is exactly the
   * adjacent-question error that put values under the wrong heading on the
   * overlay forms.
   */
  function score(a, b) {
    const na = normalise(a);
    const nb = normalise(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;

    const ta = tokens(a);
    const tb = tokens(b);
    if (!ta.length || !tb.length) return 0;

    const setB = new Set(tb);
    let shared = 0;
    for (const token of new Set(ta)) {
      if (setB.has(token)) shared += 1;
    }
    return (2 * shared) / (new Set(ta).size + setB.size);
  }

  // ------------------------------------------------------------------
  // Locating
  // ------------------------------------------------------------------

  function isFillable(control) {
    return !control.disabled && !control.readOnly;
  }

  /**
   * Join one schema field to a live control.
   *
   * `field` is `{ fieldId, label, selector? }` from the schema. `controls` are
   * descriptors from `claimfillLearn.collectControls`.
   */
  function locateOne(field, controls) {
    const candidates = controls
      .filter(isFillable)
      .map((control) => ({ control, score: score(field.label, control.label) }))
      .sort((a, b) => b.score - a.score);

    // The schema's selector is a tiebreaker, not a key: it only gets to pick
    // between candidates the label already considers plausible.
    if (field.selector) {
      const preferred = candidates.find(
        (c) => c.control.selector === field.selector && c.score >= MIN_SCORE
      );
      if (preferred) return { status: "matched", control: preferred.control, score: preferred.score };
    }

    const best = candidates[0];
    if (!best || best.score < MIN_SCORE) {
      return { status: "unmatched", control: null, score: best ? best.score : 0 };
    }

    const runnerUp = candidates[1];
    if (runnerUp && best.score - runnerUp.score < TIE_MARGIN) {
      return {
        status: "ambiguous",
        control: null,
        score: best.score,
        rivals: [best.control.ref, runnerUp.control.ref],
      };
    }

    return { status: "matched", control: best.control, score: best.score };
  }

  /**
   * Join a whole plan.
   *
   * Returns what was found and — separately — whether it is safe to fill.
   * The caller must respect `safeToFill`; a false there means the page did not
   * look like the form the schema describes.
   */
  function locate(plan, controls) {
    const fields = Array.isArray(plan) ? plan : [];
    const results = [];
    const taken = new Set();

    // Strongest matches claim their control first, so a confident field is
    // never displaced by a weaker one competing for the same control.
    const ranked = fields
      .map((field) => ({ field, best: locateOne(field, controls) }))
      .sort((a, b) => b.best.score - a.best.score);

    for (const { field, best } of ranked) {
      if (best.status === "matched" && taken.has(best.control.ref)) {
        results.push({
          fieldId: field.fieldId,
          status: "ambiguous",
          control: null,
          score: best.score,
          rivals: [best.control.ref],
        });
        continue;
      }
      if (best.status === "matched") taken.add(best.control.ref);
      results.push({ fieldId: field.fieldId, ...best });
    }

    // Fields the plan had no value for should not drag the rate down, so the
    // denominator is fields we actually intended to fill.
    const intended = results.length;
    const matched = results.filter((r) => r.status === "matched").length;
    const matchRate = intended ? matched / intended : 0;

    return {
      results,
      matched,
      intended,
      matchRate,
      safeToFill: intended > 0 && matchRate >= MIN_MATCH_RATE,
      // Live controls the schema knows nothing about. Not an error — it is the
      // signal that the portal grew a question, and the input to extending the
      // schema.
      unknownControls: controls
        .filter((c) => !taken.has(c.ref) && isFillable(c))
        .map((c) => ({ ref: c.ref, label: c.label, type: c.type })),
    };
  }

  const api = { locate, locateOne, score, normalise, tokens, MIN_SCORE, MIN_MATCH_RATE };

  root.claimfillLocate = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
