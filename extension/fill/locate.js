/**
 * BreezeFill filler — locating controls (the hybrid's join).
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
  // ...and below this many matches, the rate itself means nothing.
  //
  // A ratio clears trivially on a small plan: one ready field that happens to
  // score against some label on an unrelated page is a match rate of 1.0, and
  // the filler would call a stranger's form recognised. A sparse clinical note
  // produces exactly such a plan, so this is the common case, not a corner.
  //
  // The trade is deliberate and one-directional: a doctor whose note yielded
  // one or two values gets no autofill and writes them by hand, which costs
  // seconds. The alternative is a value landing under an unrelated question on
  // a page nobody recognised. Real insurer claim forms carry 15-24 fields, so
  // this floor is far below anything a genuine match produces.
  const MIN_MATCHED = 3;
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
   * descriptors from `breezefillLearn.collectControls`.
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
      // Both guards, not either: the rate says the page has the shape the
      // schema describes, the count says there is enough evidence for the rate
      // to mean anything.
      safeToFill: matched >= MIN_MATCHED && matchRate >= MIN_MATCH_RATE,
      // Live controls the schema knows nothing about. Not an error — it is the
      // signal that the portal grew a question, and the input to extending the
      // schema.
      unknownControls: controls
        .filter((c) => !taken.has(c.ref) && isFillable(c))
        .map((c) => ({ ref: c.ref, label: c.label, type: c.type })),
      // Every fillable control, matched or not, with what the page can say
      // about it. This is what gets mapped now: the doctor has to submit the
      // form in front of them whatever the bank knows, so the question is
      // never "is this page ours" but "how well can each question be
      // answered". `options` comes straight off the control, so it cannot be
      // stale the way an authored list can.
      liveControls: controls.filter(isFillable).map((c) => ({
        ref: c.ref,
        label: c.label,
        type: c.type,
        options: c.options && !c.options.withheld ? c.options.values : [],
      })),
    };
  }

  // ------------------------------------------------------------------
  // Wizards: one step in the DOM at a time
  // ------------------------------------------------------------------
  //
  // A multi-step form renders one step and holds the rest nowhere. Scoring a
  // whole plan against that page asks the wrong question: a plan spanning
  // admission details and diagnosis finds about half its fields on either
  // step, lands under MIN_MATCH_RATE, and the filler writes nothing. The guard
  // then systematically answers "wrong page" about the right page.
  //
  // The fix is to ask the guard about a step rather than about the form. Note
  // what it is NOT: MIN_MATCH_RATE is untouched, and each step must clear it on
  // its own. Lowering the rate globally would reintroduce partial fills
  // everywhere to solve them in one place, and a partial fill is
  // indistinguishable from a complete one to someone reviewing quickly.

  /** plan -> Map of step name to the fields on it. */
  function groupBySteps(fields) {
    const groups = new Map();
    for (const field of fields) {
      const key = field.step || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(field);
    }
    return groups;
  }

  /**
   * Locate a plan that may span several wizard steps.
   *
   * Each step is scored on its own, and every step that clears the fill guard
   * by itself is taken to be on screen. Their fields are then located together
   * in one pass, which is what keeps two steps from both claiming the same
   * control — the per-step scoring decides *which fields to try*, and the
   * single final pass decides where each one goes.
   *
   * Filling all qualifying steps rather than only the best-scoring one matters
   * for a form that reveals two sections at once. Picking a single winner would
   * leave a section that plainly matched unfilled, and "best rate" is a bad
   * winner anyway: a one-field step that happens to match scores 1.0 and would
   * beat a twelve-field step with eleven matches.
   */
  function locateSteps(plan, controls) {
    const fields = Array.isArray(plan) ? plan : [];
    const groups = groupBySteps(fields);

    // No steps declared — every schema written before this existed, and every
    // form that shows all its questions at once. Same call, same report.
    if (groups.size <= 1) {
      return { ...locate(fields, controls), steps: [], deferred: 0 };
    }

    const steps = [];
    for (const [step, group] of groups) {
      const report = locate(group, controls);
      steps.push({
        step,
        matched: report.matched,
        intended: report.intended,
        matchRate: report.matchRate,
        present: report.safeToFill,
      });
    }

    const present = new Set(steps.filter((s) => s.present).map((s) => s.step));
    // Nothing clears the guard on its own: fall back to scoring the whole plan,
    // which refuses in exactly the way it does today. The per-step breakdown
    // still travels, so the panel can say which step it was expecting rather
    // than only that it did not recognise the page.
    if (!present.size) {
      return { ...locate(fields, controls), steps, deferred: 0 };
    }

    const onScreen = fields.filter((f) => present.has(f.step || ""));
    return {
      ...locate(onScreen, controls),
      steps,
      // Fields belonging to steps that are not rendered. Not a failure and not
      // an omission — they are filled when the doctor advances the wizard and
      // the fill is re-run, which is safe because applyPlan is idempotent.
      deferred: fields.length - onScreen.length,
    };
  }

  /**
   * The page's questions, each carrying the best instruction available for it.
   *
   * This is the join that makes the bank invisible. Every fillable control on
   * the page becomes a field to answer — because the doctor has to submit this
   * form whatever the bank knows about it — and any control a schema field
   * describes inherits that field's `description`, which is the instruction a
   * colleague would be given rather than the question as the page happens to
   * word it.
   *
   * Two properties worth keeping:
   *
   *   - A control with no schema match is still filled, from its own label.
   *     Weaker, and reported as such, but a blank the product could have
   *     answered is a worse outcome than a weaker instruction.
   *   - The match must clear MIN_SCORE and must not be a tie, exactly as
   *     filling does. Attaching the wrong description is worse than attaching
   *     none: it would tell the model confidently to answer a different
   *     question than the one on screen.
   */
  function enrich(controls, schemaFields) {
    const fields = Array.isArray(schemaFields) ? schemaFields : [];
    const claimed = new Set();

    return (controls || []).map((control) => {
      const ranked = fields
        .filter((f) => !claimed.has(f.fieldId))
        .map((f) => ({ field: f, score: score(f.label, control.label) }))
        .sort((a, b) => b.score - a.score);

      const [best, runnerUp] = ranked;
      const confident =
        best &&
        best.score >= MIN_SCORE &&
        !(runnerUp && best.score - runnerUp.score < TIE_MARGIN);

      if (!confident) {
        return { ...control, description: null, describedBy: null };
      }
      claimed.add(best.field.fieldId);
      return {
        ...control,
        // The schema's instruction, not the page's wording.
        description: best.field.description || best.field.label,
        // Only ever reported, never used to locate: the control is already
        // in hand, and its own label is what the filler matches on.
        describedBy: best.field.fieldId,
        // A schema's options describe the form; the control's describe what it
        // will actually accept today. Prefer the control, fall back to the
        // schema for a control that carries none of its own.
        options: control.options && control.options.length
          ? control.options
          : best.field.options || [],
      };
    });
  }

  const api = {
    locate,
    locateSteps,
    locateOne,
    enrich,
    groupBySteps,
    score,
    normalise,
    tokens,
    MIN_SCORE,
    MIN_MATCH_RATE,
    MIN_MATCHED,
  };

  root.breezefillLocate = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
