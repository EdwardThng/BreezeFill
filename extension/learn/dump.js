/**
 * ClaimFill learn mode — sanitised field inventory for an insurer web form.
 *
 * This is the web-portal analogue of `python backend/pdf_fill.py <form.pdf>`:
 * it reports what fields a form HAS so a schema can be written against them.
 * It is authoring tooling, not fill tooling.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE: this file emits field STRUCTURE, never field CONTENT.
 * ---------------------------------------------------------------------------
 *
 * An insurer claim page arrives pre-populated by the insurer — patient name,
 * NRIC, policy number are already sitting in the DOM when the doctor opens the
 * link. The obvious version of this tool (dump the DOM, hand it to a model,
 * get a schema back) would ship all of that straight to an LLM, around the
 * entire redaction pipeline in `backend/redaction.py`. So:
 *
 *   1. No control's value is ever read into the output. `hasValue` is a
 *      boolean and that is the only thing said about content.
 *   2. Every string that DOES get emitted — labels, headings, placeholders,
 *      option text — is run through `scrub()` first, because an SPA will
 *      happily render "Claim for Tan Wei Ming (S1234567D)" as a heading and
 *      that heading is a label as far as the DOM is concerned.
 *   3. `type="password"` controls are skipped entirely, never counted.
 *
 * Rule 2 is the one that is easy to forget. The patterns mirror pass 2 of
 * `redaction.py` (NRIC/FIN, SG phone, email) plus the long digit runs that
 * policy and claim numbers take.
 *
 * ---------------------------------------------------------------------------
 * Running it
 * ---------------------------------------------------------------------------
 *
 * Paste into the DevTools console on the form page:
 *
 *     claimfillLearn.dump()            // -> inventory object
 *     copy(JSON.stringify(claimfillLearn.dump(), null, 2))
 *
 * Wizard forms only have the current step in the DOM, so run it once per step
 * and combine:
 *
 *     claimfillLearn.mergeDumps([step1, step2, step3])
 *
 * The same functions become the extension's learn mode later; nothing here
 * depends on the extension APIs.
 */

(function (root) {
  "use strict";

  const DUMPER_VERSION = 1;

  // --------------------------------------------------------------------
  // Scrubbing (rule 2)
  // --------------------------------------------------------------------

  // Mirrors backend/redaction.py pass 2, plus identifiers that show up in
  // portal chrome rather than clinical text. Order matters: email before the
  // digit-run rule, so an address with digits is not half-eaten first.
  const SCRUB_PATTERNS = [
    [/\b[STFGM]\s?\d{7}\s?[A-Z]\b/gi, "[NRIC]"],
    [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]"],
    [/(?<!\d)(?:\+65[ -]?)?[689]\d{3}[ -]?\d{4}(?!\d)/g, "[PHONE]"],
    // Policy / claim / member numbers: a run of 8+ digits, or grouped runs
    // like "1234-5678-9012". Deliberately blunt — a label legitimately
    // containing an 8-digit number is rare, and a false [NUMBER] in an
    // authoring dump costs nothing.
    [/(?<![\d-])\d[\d-]{7,}\d(?![\d-])/g, "[NUMBER]"],
  ];

  /**
   * Replace anything that looks like a patient identifier. Applied to every
   * string this module emits — there is no path out of here that skips it.
   */
  function scrub(text) {
    if (typeof text !== "string") return "";
    let out = text.replace(/\s+/g, " ").trim();
    for (const [pattern, token] of SCRUB_PATTERNS) {
      out = out.replace(pattern, token);
    }
    return out;
  }

  /** True if scrubbing changed the string — used to flag PHI-bearing pages. */
  function wasScrubbed(original) {
    return scrub(original) !== String(original || "").replace(/\s+/g, " ").trim();
  }

  // --------------------------------------------------------------------
  // Label resolution
  // --------------------------------------------------------------------
  //
  // Selectors rot when a portal is redesigned; the question text rarely
  // changes, because it is what the insurer is regulated to ask. So the label
  // is the primary key for matching later, and worth working for. Tried in
  // descending order of how deliberate the association is.

  function textOf(node) {
    if (!node) return "";
    return scrub(node.textContent || "");
  }

  function labelFor(el, doc) {
    // 1. Explicit ARIA.
    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (ariaLabel) return { label: scrub(ariaLabel), labelSource: "aria-label" };

    const labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => textOf(doc.getElementById(id)))
        .filter(Boolean);
      if (parts.length) {
        return { label: parts.join(" "), labelSource: "aria-labelledby" };
      }
    }

    // 2. <label for="...">
    if (el.id) {
      const escaped = cssEscape(el.id);
      const explicit = doc.querySelector(`label[for="${escaped}"]`);
      const text = textOf(explicit);
      if (text) return { label: text, labelSource: "label[for]" };
    }

    // 3. Wrapping <label>.
    const wrapping = el.closest && el.closest("label");
    if (wrapping) {
      // Strip the control's own text (a wrapped <select>'s options land in
      // textContent otherwise and swamp the actual question).
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
      const text = textOf(clone);
      if (text) return { label: text, labelSource: "wrapping-label" };
    }

    // 4. Table layouts — the cell to the left. Still extremely common on
    //    insurer forms ported from print.
    const cell = el.closest && el.closest("td, th");
    if (cell && cell.previousElementSibling) {
      const text = textOf(cell.previousElementSibling);
      if (text) return { label: text, labelSource: "table-cell" };
    }

    // 5. Nearest preceding text node in the same block. Last resort and the
    //    least trustworthy — flagged so schema authoring treats it as a
    //    guess rather than a match key.
    const prev = el.previousElementSibling;
    const text = textOf(prev);
    if (text) return { label: text, labelSource: "preceding-sibling" };

    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    if (placeholder) return { label: scrub(placeholder), labelSource: "placeholder" };

    return { label: "", labelSource: "none" };
  }

  /**
   * The form's own sectioning, taken from <legend> and nothing else.
   *
   * Page prose is deliberately not read — no <h1>, no <h2>, no stray <p>. A
   * <legend> is authored by the insurer and is identical on every claim; the
   * heading of a claim page routinely reads "Claim for <patient> (<NRIC>)",
   * which is per-claim content.
   *
   * The scrubber cannot cover for reading prose. It catches NRICs, phones and
   * emails by shape, but A NAME HAS NO SHAPE — "Tan Wei Ming" is
   * indistinguishable from "Tan Tock Seng" by regex. redaction.py only manages
   * it because pass 1 has the demographics dictionary to match against, and
   * learn mode has no such dictionary: nobody has typed the patient's name in.
   * So the answer is not to read the prose.
   *
   * Cost: a portal that sections with <h3> instead of <fieldset> yields empty
   * sections. That is the right trade — a missing section label is an
   * inconvenience while writing a schema, a leaked name is a breach.
   */
  function sectionFor(el) {
    const fieldset = el.closest && el.closest("fieldset");
    if (!fieldset) return "";
    return textOf(fieldset.querySelector("legend"));
  }

  // --------------------------------------------------------------------
  // Selectors
  // --------------------------------------------------------------------

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === "function") {
      return root.CSS.escape(value);
    }
    return String(value).replace(/([^\w-])/g, "\\$1");
  }

  /**
   * A selector to fall back on when label matching is ambiguous. Framework
   * builds regenerate class names and ids, so this is the weaker key of the
   * two on purpose.
   */
  function selectorFor(el) {
    if (el.id) return `#${cssEscape(el.id)}`;
    const name = el.getAttribute && el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === node.tagName
      );
      const index = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
      node = parent;
    }
    return parts.join(" > ");
  }

  // --------------------------------------------------------------------
  // Options
  // --------------------------------------------------------------------
  //
  // Option text is structural (Yes/No, ward class, relationship) and needed to
  // write a schema, but it is not guaranteed to be — a select could enumerate
  // the patient's own policies. Scrubbed like everything else, and capped so a
  // 3000-entry ICD picker does not drown the dump.

  const MAX_OPTIONS = 30;

  function optionsFor(el) {
    if (el.tagName !== "SELECT") return null;
    const all = Array.from(el.options || []);
    const shown = all.slice(0, MAX_OPTIONS).map((o) => scrub(o.textContent));
    return {
      count: all.length,
      truncated: all.length > MAX_OPTIONS,
      values: shown.filter((v) => v !== ""),
    };
  }

  // --------------------------------------------------------------------
  // Collection
  // --------------------------------------------------------------------

  const SKIP_TYPES = new Set([
    "password", // never inventoried, not even counted
    "submit",
    "button",
    "reset",
    "image",
    "file",
  ]);

  function isVisible(el) {
    // Ancestor walk over computed display/visibility. Deliberately NOT
    // offsetParent or getBoundingClientRect: both need layout, which jsdom
    // does not implement, so under test every control would read as hidden and
    // the visibility assertions would pass for the wrong reason.
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return true;

    let node = el;
    while (node && node.nodeType === 1) {
      const style = view.getComputedStyle(node);
      if (style && (style.display === "none" || style.visibility === "hidden")) {
        return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function describe(el, doc, ref) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "select" ? "select" : "text"))
      .toLowerCase();
    const { label, labelSource } = labelFor(el, doc);
    const maxLength = el.getAttribute("maxlength");

    return {
      ref,
      tag,
      type,
      // Identity attributes are structure, not content — but they are
      // author-controlled strings, so they go through the scrubber too.
      name: scrub(el.getAttribute("name") || ""),
      id: scrub(el.id || ""),
      label,
      labelSource,
      section: sectionFor(el),
      selector: selectorFor(el),
      placeholder: scrub(el.getAttribute("placeholder") || ""),
      required: el.required === true || el.getAttribute("aria-required") === "true",
      disabled: el.disabled === true,
      readOnly: el.readOnly === true,
      // Silent truncation is the web equivalent of the /MaxLen comb-field trap
      // in pdf_fill.py, so it is worth carrying into the schema.
      maxLength: maxLength ? Number(maxLength) : null,
      visible: isVisible(el),
      options: optionsFor(el),
      // Content boundary: presence only, never the value itself.
      hasValue: hasValue(el),
    };
  }

  function hasValue(el) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked === true;
    return Boolean(el.value);
  }

  /**
   * Radios sharing a name are one question, not N. Collapsed into a single
   * entry whose options are the individual radio labels — which is the shape
   * a schema field wants.
   */
  function describeRadioGroup(els, doc, ref) {
    const first = els[0];
    const groupLabel = sectionFor(first);
    return {
      ref,
      tag: "input",
      type: "radio-group",
      name: scrub(first.getAttribute("name") || ""),
      id: "",
      label: groupLabel,
      labelSource: "section-heading",
      section: groupLabel,
      selector: `input[name="${cssEscape(first.getAttribute("name") || "")}"]`,
      placeholder: "",
      required: els.some((e) => e.required === true),
      disabled: els.every((e) => e.disabled === true),
      readOnly: false,
      maxLength: null,
      visible: els.some(isVisible),
      options: {
        count: els.length,
        truncated: false,
        values: els.map((e) => labelFor(e, doc).label).filter(Boolean),
      },
      hasValue: els.some((e) => e.checked === true),
    };
  }

  function collectControls(doc) {
    const nodes = Array.from(
      doc.querySelectorAll("input, select, textarea, [contenteditable='true']")
    );

    const controls = [];
    const radioGroups = new Map();
    let skippedPassword = 0;
    let counter = 0;

    for (const el of nodes) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "password") {
        skippedPassword += 1;
        continue;
      }
      if (SKIP_TYPES.has(type)) continue;
      if (type === "hidden") continue;

      if (type === "radio") {
        const name = el.getAttribute("name") || "";
        if (name) {
          if (!radioGroups.has(name)) radioGroups.set(name, []);
          radioGroups.get(name).push(el);
          continue;
        }
      }

      counter += 1;
      controls.push(describe(el, doc, `c${counter}`));
    }

    for (const els of radioGroups.values()) {
      counter += 1;
      controls.push(describeRadioGroup(els, doc, `c${counter}`));
    }

    return { controls, skippedPassword };
  }

  // --------------------------------------------------------------------
  // Public entry points
  // --------------------------------------------------------------------

  function dump(options) {
    const opts = options || {};
    const doc = opts.document || root.document;
    const { controls, skippedPassword } = collectControls(doc);

    // How many pieces of page chrome held a shaped identifier. Nothing from
    // those elements is emitted, so this is not a leak count — it is a signal
    // to the author that the page is PHI-bearing, and therefore that the raw
    // DOM, a screenshot, or the URL must not be shared alongside this dump.
    // Undercounts by design: names are not shaped and are not detected here.
    const scrubbedStrings = countScrubbed(doc);

    return {
      dumperVersion: DUMPER_VERSION,
      // Host only. The full URL carries the ?pid= claim token, which is a
      // bearer credential for the patient's claim — it must never land in an
      // authoring artefact.
      host: (root.location && root.location.host) || opts.host || "",
      stepHint: scrub(opts.stepHint || currentStepHint(doc)),
      capturedAt: new Date().toISOString(),
      controlCount: controls.length,
      skippedPasswordFields: skippedPassword,
      scrubbedStrings,
      controls,
    };
  }

  function countScrubbed(doc) {
    let n = 0;
    const candidates = Array.from(doc.querySelectorAll("label, legend, h1, h2, h3, h4"));
    for (const node of candidates) {
      if (wasScrubbed(node.textContent || "")) n += 1;
    }
    return n;
  }

  /**
   * Name for the wizard step currently rendered, from the first <legend> only
   * — same prose ban as sectionFor(). Pass `stepHint` to dump() to override
   * when the form has no legends.
   */
  function currentStepHint(doc) {
    return textOf(doc.querySelector("legend"));
  }

  /**
   * Combine per-step dumps into one inventory. Controls are keyed by
   * name/id/selector, so re-running on a step already captured updates rather
   * than duplicates.
   */
  function mergeDumps(dumps) {
    const list = Array.isArray(dumps) ? dumps.filter(Boolean) : [];
    if (!list.length) return null;

    const byKey = new Map();
    const steps = [];
    for (const d of list) {
      if (d.stepHint) steps.push(d.stepHint);
      for (const control of d.controls || []) {
        const key = control.name || control.id || control.selector;
        const existing = byKey.get(key);
        if (existing) {
          // Prefer the capture where the control was visible — that is the
          // step it actually belongs to, and where its label resolved.
          if (!existing.visible && control.visible) {
            byKey.set(key, { ...control, step: d.stepHint || "" });
          }
          continue;
        }
        byKey.set(key, { ...control, step: d.stepHint || "" });
      }
    }

    const controls = Array.from(byKey.values()).map((c, i) => ({
      ...c,
      ref: `c${i + 1}`,
    }));

    return {
      dumperVersion: DUMPER_VERSION,
      host: list[0].host || "",
      steps,
      capturedAt: new Date().toISOString(),
      controlCount: controls.length,
      skippedPasswordFields: list.reduce(
        (n, d) => n + (d.skippedPasswordFields || 0),
        0
      ),
      scrubbedStrings: list.reduce((n, d) => n + (d.scrubbedStrings || 0), 0),
      controls,
    };
  }

  const api = {
    dump,
    mergeDumps,
    // Exported for the tests that guard the content boundary.
    scrub,
    labelFor,
    collectControls,
    selectorFor,
  };

  root.claimfillLearn = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
