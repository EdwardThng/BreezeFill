/**
 * BreezeFill filler — writing values into a framework-controlled form.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP: `el.value = x` does not work on a React or Angular portal.
 * ---------------------------------------------------------------------------
 *
 * React installs its own setter on each input instance and keeps a shadow copy
 * of the value. Assigning through that setter updates the DOM but does not
 * notify React, so on the next render React writes its stale value back, or
 * submits the stale value while the correct one is still on screen. Angular's
 * ngModel behaves the same way through a different mechanism.
 *
 * This fails *visibly correct*: the doctor sees the right text in the box, and
 * the portal submits something else. It is the worst failure mode available to
 * us, because review cannot catch it — what the doctor reviews is exactly what
 * is not submitted.
 *
 * The fix is to write through the PROTOTYPE's setter, which bypasses React's
 * instance-level override and updates the real value, then dispatch the events
 * the framework is listening for so it re-reads. `input` for React's onChange
 * and Angular's ngModel; `change` for select and checkbox semantics and for
 * anything doing validation on blur.
 *
 * ---------------------------------------------------------------------------
 * Never submit
 * ---------------------------------------------------------------------------
 *
 * Nothing here clicks a submit button, calls form.submit(), or dispatches a
 * submit event. The doctor clicks submit and signs. That is a product
 * guarantee, not an implementation detail, and `apply.test.js` asserts it.
 */

(function (root) {
  "use strict";

  // ------------------------------------------------------------------
  // The native setter
  // ------------------------------------------------------------------

  /**
   * Write `value` through the prototype's setter rather than the instance's.
   *
   * Taking the descriptor from the element's own prototype (rather than always
   * HTMLInputElement) is what makes this correct for <textarea> and <select>
   * too — each has its own `value` accessor, and using the input one on a
   * textarea silently does nothing.
   */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(el, value);
      return;
    }
    el.value = value;
  }

  function setNativeChecked(el, checked) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "checked");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(el, checked);
      return;
    }
    el.checked = checked;
  }

  /**
   * Write, and put back what was there if the control refuses it.
   *
   * Every control runs the HTML value sanitising algorithm on assignment, and
   * a value it does not recognise does not bounce — it lands as the **empty
   * string**. `<input type="date">` does this to anything that is not
   * `yyyy-mm-dd`, `type="number"` to anything non-numeric.
   *
   * That is worse than a failed write in two ways, and both are invisible from
   * here without checking. The box may have held something the doctor typed by
   * hand, so the write is a *clearance*; and the caller would go on to report
   * the field filled, because assignment threw nothing. So: read the value
   * back, restore what was there when it did not take, and let the caller say
   * it was skipped.
   */
  function writeOrRestore(el, text) {
    const before = el.value;
    setNativeValue(el, text);
    if (el.value === text) return true;
    if (el.value !== before) setNativeValue(el, before);
    return false;
  }

  function notify(el) {
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || root;
    const EventCtor = view.Event || root.Event;
    el.dispatchEvent(new EventCtor("input", { bubbles: true }));
    el.dispatchEvent(new EventCtor("change", { bubbles: true }));
  }

  // ------------------------------------------------------------------
  // Per-type application
  // ------------------------------------------------------------------

  function applyText(el, value) {
    const text = value == null ? "" : String(value);
    if (!writeOrRestore(el, text)) {
      return { status: "skipped", reason: "the control would not take this value" };
    }
    notify(el);
    return { status: "filled" };
  }

  // A date as every schema in this repo writes it, and as the model is told to
  // answer. Four-digit years only — see applyDate.
  const DAY_FIRST_DATE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/;

  /**
   * `<input type="date">` holds `yyyy-mm-dd` and nothing else.
   *
   * The whole pipeline speaks DD/MM/YYYY: the schemas ask for it, the prompt
   * mandates it, `_apply_date_format` enforces it, and the doctor confirms it
   * in that shape. Handing that string to a native date control sets it to the
   * empty string — so the field the doctor just checked most carefully was the
   * one guaranteed not to arrive, and it reported itself filled on the way
   * past. Converting here rather than upstream keeps DD/MM/YYYY as the one
   * format everything else agrees on; this is the only place a control needs
   * something different.
   *
   * A two-digit year is refused rather than expanded. Choosing 2026 over 1926
   * for "26" is the same guess `_apply_date_format` declines to make on the
   * server, and a claim form carries dates of birth as readily as dates of
   * admission. The doctor gets told, and types it into the picker themselves.
   *
   * An impossible date (31/02) is not checked here — the control's own
   * sanitiser rejects it, `writeOrRestore` sees the value did not land, and it
   * is reported skipped. One calendar implementation is enough.
   */
  function applyDate(el, value) {
    const match = DAY_FIRST_DATE.exec(String(value == null ? "" : value));
    if (!match) {
      // Says which half is wrong: a doctor who sees "needs DD/MM/YYYY" can fix
      // a short year in the review box, where it will then convert cleanly.
      return { status: "skipped", reason: "this date box needs DD/MM/YYYY" };
    }
    const [, day, month, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

    if (!writeOrRestore(el, iso)) {
      return { status: "skipped", reason: "the date box rejected this date" };
    }
    notify(el);
    return { status: "filled" };
  }

  /**
   * Selects are matched on option text, then value. A value with no matching
   * option is left alone rather than forced — an unselectable option means the
   * schema and the portal disagree about what this field accepts, and guessing
   * is how a wrong clinical answer gets submitted.
   */
  function applySelect(el, value) {
    const wanted = String(value == null ? "" : value).trim().toLowerCase();
    if (!wanted) return { status: "skipped", reason: "no value" };

    const options = Array.from(el.options || []);
    const match =
      options.find((o) => String(o.textContent || "").trim().toLowerCase() === wanted) ||
      options.find((o) => String(o.value || "").trim().toLowerCase() === wanted);

    if (!match) {
      return { status: "skipped", reason: "no matching option" };
    }

    setNativeValue(el, match.value);
    notify(el);
    return { status: "filled" };
  }

  /**
   * Checkboxes are clicked rather than assigned, but only when the state
   * actually needs to change.
   *
   * A real click is what frameworks and custom widgets listen for, and it
   * carries the label/wrapper handlers a bare property write misses. Clicking
   * a checkbox that is already correct would toggle it to wrong, which is why
   * the state check comes first.
   */
  // What a checkbox understands, compared case-insensitively. The previous
  // check was `value === "yes"`, which is false for "Yes" — the exact string
  // an options list supplies — so a correct answer read as "don't tick".
  const CHECKBOX_TRUE = new Set(["true", "yes", "y", "on", "checked", "1"]);
  const CHECKBOX_FALSE = new Set(["false", "no", "n", "off", "unchecked", "0"]);

  /** true, false, or null when the value says nothing about a tick. */
  function checkboxIntent(value) {
    if (value === true) return true;
    if (value === false) return false;
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (CHECKBOX_TRUE.has(text)) return true;
    if (CHECKBOX_FALSE.has(text)) return false;
    return null;
  }

  function applyCheckbox(el, value) {
    const wanted = checkboxIntent(value);

    // An unrecognised value must NOT fall through to `false`. That is what the
    // old expression did, and on a box the doctor had already ticked it meant
    // the "fill" silently UNTICKED their answer — the same clearance bug that
    // writeOrRestore exists to prevent, on the one control writeOrRestore
    // does not cover.
    if (wanted === null) {
      return { status: "skipped", reason: "not a tick/untick answer" };
    }

    if (el.checked === wanted) return { status: "unchanged" };

    el.click();
    // Some custom widgets swallow the click; fall back to the property write
    // plus events so the value still lands.
    if (el.checked !== wanted) {
      setNativeChecked(el, wanted);
      notify(el);
    }
    return { status: "filled" };
  }

  // An option that lets the doctor say "none of these apply" explicitly.
  // Deliberately narrow: it must look like a refusal of the whole list, not
  // merely contain the word "no" (which would match "No known allergies").
  const NONE_OF_THE_ABOVE =
    /^\s*(none(\s+of\s+the\s+above)?|not\s+applicable|n\.?\/?a\.?|no\s+(other|further)\b.*)\s*$/i;

  function isNoneOption(el, labelOf) {
    const text = String(labelOf ? labelOf(el) : "") || String(el.value || "");
    return NONE_OF_THE_ABOVE.test(text);
  }

  /**
   * A multi-select checkbox group with nothing ticked: unanswered, or answered
   * "none of these"?
   *
   * The list itself decides. If it offers an explicit "none of the above",
   * then a doctor who meant that would have ticked it — so an empty group is
   * genuinely unanswered and safe to fill. If it offers no such option, empty
   * carries both meanings at once and nothing here can separate them, so the
   * question is left alone.
   *
   * That asymmetry is the same bet the rest of the product makes: a blank the
   * doctor completes costs seconds, a wrong tick is a clinical statement they
   * sign. Radio groups are excluded — they are single-select and an empty one
   * is always simply unanswered.
   */
  function isAmbiguousEmptyGroup(els, labelOf) {
    if (!Array.isArray(els) || els.length === 0) return false;
    if (els[0].type !== "checkbox") return false;
    if (els.some((el) => el.checked === true)) return false;
    return !els.some((el) => isNoneOption(el, labelOf));
  }

  /**
   * Is this control already answered?
   *
   * "Answered" is deliberately asymmetric for a lone checkbox: ticked is an
   * answer, unticked is indistinguishable from unanswered, so an untouched box
   * stays fillable while a ticked one is never cleared. That matches the rule
   * everywhere else here — never leave a control emptier than it was found.
   *
   * A <select> showing its placeholder reads as "" and is therefore unanswered,
   * which is what makes "— Select —" fillable.
   */
  function hasExistingAnswer(target) {
    if (Array.isArray(target)) return target.some((el) => el.checked === true);
    if (!target) return false;
    const type = String(target.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio") return target.checked === true;
    return String(target.value == null ? "" : target.value).trim() !== "";
  }

  /**
   * One question spread over several inputs — a radio group, or a set of
   * checkboxes sharing a name. Click the member whose label matches the value.
   * No match means no selection — never "pick the first one".
   */
  function applyOption(els, value, labelOf) {
    const wanted = String(value == null ? "" : value).trim().toLowerCase();
    if (!wanted) return { status: "skipped", reason: "no value" };

    const match = els.find((el) => {
      const label = String(labelOf ? labelOf(el) : "").trim().toLowerCase();
      return (
        label === wanted || String(el.value || "").trim().toLowerCase() === wanted
      );
    });

    if (!match) return { status: "skipped", reason: "no matching option" };
    if (match.checked) return { status: "unchanged" };

    // No conflict check is needed here any more: `applyOne` refuses any group
    // with a member already selected, so reaching this point means nothing in
    // the group was answered. Kept as a note rather than a guard because the
    // two used to be separate and a future caller reaching applyOption
    // directly would want to know the check lives upstream.

    match.click();
    if (!match.checked) {
      setNativeChecked(match, true);
      notify(match);
    }
    return { status: "filled" };
  }

  // ------------------------------------------------------------------
  // Dispatch
  // ------------------------------------------------------------------

  /**
   * Apply one value to one located target.
   *
   * `target` is an element, or an array of elements for a radio group.
   * Guarded rather than trusted: a control that turned readonly or disabled
   * between locating and filling is skipped, because the page may have
   * re-rendered in between.
   */
  function applyOne(target, value, options) {
    const opts = options || {};

    // No value supplied is not the same as an empty value. Writing "" here
    // would clear whatever is already in the control — including something
    // the doctor typed by hand a moment ago — and report it as filled. The
    // panel already excludes valueless rows from its plan, so reaching this
    // means the plan and the values disagreed; leave the page alone.
    if (value === undefined || value === null) {
      return { status: "skipped", reason: "no value" };
    }

    if (!Array.isArray(target)) {
      if (!target) return { status: "skipped", reason: "no target" };
      if (target.disabled || target.readOnly) {
        return { status: "skipped", reason: "not writable" };
      }
    }

    // AN ANSWER ALREADY IN THE CONTROL OUTRANKS OURS, on every question type.
    //
    // A question that already carries an answer has been settled — by the
    // doctor, or by the insurer pre-populating the form before they ever saw
    // it. Writing over it replaces a human decision with a model's, silently,
    // after the review step has passed. So a control that is already answered
    // is left exactly as found and the filler moves to the next question.
    //
    // This also makes a re-run genuinely inert: the second pass over a step
    // finds its own values in place and writes nothing.
    if (hasExistingAnswer(target)) {
      return { status: "skipped", reason: "already answered" };
    }

    if (isAmbiguousEmptyGroup(target, opts.labelOf)) {
      return {
        status: "skipped",
        reason: "nothing ticked and no 'none of the above' — cannot tell unanswered from none",
      };
    }

    if (Array.isArray(target)) {
      return applyOption(target, value, opts.labelOf);
    }

    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    const type = String(target.type || "").toLowerCase();

    if (tag === "select") return applySelect(target, value);
    if (type === "checkbox") return applyCheckbox(target, value);
    if (type === "radio") return applyOption([target], value, opts.labelOf);
    // Before the text fallback: a native date control looks like a text input
    // from here, and is the one that silently swallows what we write.
    if (type === "date") return applyDate(target, value);
    return applyText(target, value);
  }

  /**
   * Apply a located plan.
   *
   * Takes the matcher's report plus a ref->element map and a fieldId->value
   * map. Refuses outright when the matcher says the page did not look like the
   * form the schema describes — the decision belongs to the matcher, and this
   * function does not get to second-guess it.
   *
   * Idempotent by construction, so it can be re-run as a wizard advances:
   * re-applying an already-correct value is a no-op.
   */
  function applyPlan(report, elements, values, options) {
    if (!report || !report.safeToFill) {
      return {
        filled: 0,
        applied: [],
        refused: true,
        reason: "the page does not match the form this schema describes",
      };
    }

    const applied = [];
    for (const result of report.results) {
      if (result.status !== "matched") {
        applied.push({ fieldId: result.fieldId, status: "skipped", reason: result.status });
        continue;
      }
      const target = elements.get(result.control.ref);
      const outcome = applyOne(target, values[result.fieldId], options);
      applied.push({ fieldId: result.fieldId, ref: result.control.ref, ...outcome });
    }

    return {
      filled: applied.filter((a) => a.status === "filled").length,
      applied,
      refused: false,
    };
  }

  const api = {
    applyPlan,
    applyOne,
    applyDate,
    setNativeValue,
    setNativeChecked,
  };

  root.breezefillApply = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
