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
    setNativeValue(el, value == null ? "" : String(value));
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
  function applyCheckbox(el, value) {
    const wanted = value === true || value === "true" || value === "yes";
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

  /**
   * Radio groups: click the member whose label matches the value. No match
   * means no selection — never "pick the first one".
   */
  function applyRadio(els, value, labelOf) {
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

    if (Array.isArray(target)) {
      return applyRadio(target, value, opts.labelOf);
    }
    if (!target) return { status: "skipped", reason: "no target" };
    if (target.disabled || target.readOnly) {
      return { status: "skipped", reason: "not writable" };
    }

    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    const type = String(target.type || "").toLowerCase();

    if (tag === "select") return applySelect(target, value);
    if (type === "checkbox") return applyCheckbox(target, value);
    if (type === "radio") return applyRadio([target], value, opts.labelOf);
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
    setNativeValue,
    setNativeChecked,
  };

  root.breezefillApply = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
