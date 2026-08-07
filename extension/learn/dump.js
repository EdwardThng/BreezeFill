/**
 * BreezeFill learn mode — sanitised field inventory for an insurer web form.
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
 *     breezefillLearn.dump()            // -> inventory object
 *     copy(JSON.stringify(breezefillLearn.dump(), null, 2))
 *
 * Wizard forms only have the current step in the DOM, so run it once per step
 * and combine:
 *
 *     breezefillLearn.mergeDumps([step1, step2, step3])
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

  /** Whitespace-normalised but UNSCRUBBED. Never emit the result directly. */
  function rawTextOf(node) {
    if (!node) return "";
    return String(node.textContent || "").replace(/\s+/g, " ").trim();
  }

  // How far up the tree rule 6 looks for a label sitting in a sibling
  // container. Two hops covers the usual grid nesting (cell -> row); more
  // starts finding text that belongs to a different question.
  const MAX_LABEL_HOPS = 2;

  // The walk never climbs out of the control's own form or fieldset.
  const LABEL_WALK_STOP = new Set(["FORM", "FIELDSET", "TABLE", "BODY", "HTML"]);

  // Never read as a label, whatever the DOM says it is next to.
  //
  // Headings and paragraphs are page prose, and the ban on reading prose is
  // the same one sectionFor() documents: the scrubber finds identifiers by
  // SHAPE, and a name has none, so "Claim for Tan Wei Ming" is indetectable.
  // A control adjacent to another control is the other trap — a <select>'s
  // previous sibling is often another <select>, whose textContent is its whole
  // option list. That is not a label, and worse, it routes option text around
  // buildOptions()'s withholding rule, which exists precisely because option
  // lists enumerate patients.
  const NEVER_A_LABEL = new Set([
    "H1", "H2", "H3", "H4", "H5", "H6", "P",
    "INPUT", "SELECT", "TEXTAREA", "BUTTON",
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD",
  ]);

  // Longer than any question an insurer asks; shorter than a paragraph.
  const MAX_LABEL_CHARS = 200;

  /**
   * Text of a node that might be a label, or "" if it may not be read.
   *
   * Unscrubbed like rawTextOf — callers are still on the hook for scrub().
   */
  function candidateLabelText(node) {
    if (!node || node.nodeType !== 1) return "";
    if (NEVER_A_LABEL.has(node.tagName)) return "";
    if (node.querySelector && node.querySelector("input, select, textarea, button")) {
      return "";
    }
    const text = rawTextOf(node);
    return text.length > MAX_LABEL_CHARS ? "" : text;
  }

  /**
   * Raw label text plus how it was found.
   *
   * Unscrubbed on purpose: callers either scrub it (labelFor) or hand it to
   * buildOptions, which needs to see the original in order to decide whether
   * the list is data and must be withheld. Pre-scrubbing here would make
   * wasScrubbed() always false at the call site and silently disable that
   * check. Nothing may emit this return value without going through one of
   * those two paths.
   */
  function rawLabelFor(el, doc) {
    // 1. Explicit ARIA.
    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (ariaLabel) return { text: ariaLabel.trim(), source: "aria-label" };

    const labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => rawTextOf(doc.getElementById(id)))
        .filter(Boolean);
      if (parts.length) return { text: parts.join(" "), source: "aria-labelledby" };
    }

    // 2. <label for="...">
    if (el.id) {
      const explicit = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
      const text = rawTextOf(explicit);
      if (text) return { text, source: "label[for]" };
    }

    // 3. Wrapping <label>.
    const wrapping = el.closest && el.closest("label");
    if (wrapping) {
      // Strip the control's own text first — a wrapped <select> otherwise
      // contributes every one of its options to textContent and swamps the
      // actual question.
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
      const text = rawTextOf(clone);
      if (text) return { text, source: "wrapping-label" };
    }

    // 4. Table layouts — the cell to the left. Still extremely common on
    //    insurer forms ported from print.
    const cell = el.closest && el.closest("td, th");
    if (cell && cell.previousElementSibling) {
      const text = rawTextOf(cell.previousElementSibling);
      if (text) return { text, source: "table-cell" };
    }

    // 5. Nearest preceding element. Last resort and the least trustworthy —
    //    reported as such so schema authoring treats it as a guess rather
    //    than a match key.
    const sibling = candidateLabelText(el.previousElementSibling);
    if (sibling) return { text: sibling, source: "preceding-sibling" };

    // 6. The same idea one step up: grid layouts put the question and the
    //    control in *sibling containers* rather than sibling elements —
    //    <div class="col">Home Phone</div><div class="col"><input></div> — so
    //    the control's own previous sibling is nothing at all. This is the div
    //    analogue of rule 4, and print-derived insurer forms use it as freely
    //    as they use tables. Without it a whole page can read as unlabelled,
    //    which is not a visible failure: every label scores 0, nothing matches,
    //    and the filler refuses a page it could have filled. Confirmed against
    //    RoboForm's 39-field test form, where 36 controls resolved to "".
    for (let node = el.parentElement, hops = 0; node && hops < MAX_LABEL_HOPS; node = node.parentElement, hops += 1) {
      // A label never lives outside the control's own form or fieldset, and
      // continuing past one is how the walk reaches page prose — the exact
      // surface sectionFor() refuses to read, for the reason spelled out
      // there. Stop rather than climb into it.
      if (LABEL_WALK_STOP.has(node.tagName)) break;
      const text = candidateLabelText(node.previousElementSibling);
      if (text) return { text, source: "ancestor-sibling" };
    }

    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    if (placeholder) return { text: placeholder.trim(), source: "placeholder" };

    return { text: "", source: "none" };
  }

  /** Emittable label: rawLabelFor() put through the scrubber. */
  function labelFor(el, doc) {
    const raw = rawLabelFor(el, doc);
    return { label: scrub(raw.text), labelSource: raw.source };
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
    return scrub(rawTextOf(fieldset.querySelector("legend")));
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
  // Option text is usually structure — Yes/No, ward class, relationship — and
  // a schema needs it. But a <select> can just as easily enumerate the
  // patient: a policy picker reading "80123456 — Tan Wei Ming — GHS" is a list
  // of per-claim data wearing the costume of a control's options.
  //
  // Rule: if scrubbing changes ANY option in a list, the whole list is treated
  // as data and its values are withheld — only the count survives. Withholding
  // the entire list rather than just the offending entries is what catches the
  // name. A name has no shape for the scrubber to find, but it travels next to
  // the policy number, which does.
  //
  // Residual risk, stated plainly: a list of bare names with no number or NRIC
  // beside them would pass. Nothing here detects that, which is one more
  // reason to run learn mode against a test link (see README).

  const MAX_OPTIONS = 30;

  function buildOptions(texts) {
    const nonEmpty = texts
      .map((t) => String(t == null ? "" : t))
      .filter((t) => t.trim() !== "");

    if (nonEmpty.some(wasScrubbed)) {
      return { count: nonEmpty.length, truncated: false, withheld: true, values: [] };
    }
    return {
      count: nonEmpty.length,
      truncated: nonEmpty.length > MAX_OPTIONS,
      withheld: false,
      values: nonEmpty.slice(0, MAX_OPTIONS).map(scrub),
    };
  }

  function optionsFor(el) {
    if (el.tagName !== "SELECT") return null;
    return buildOptions(Array.from(el.options || []).map((o) => o.textContent));
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
      // Same withholding rule as <select>: radio labels are normally an
      // enumeration, but nothing stops a portal listing claimants as radios.
      options: buildOptions(els.map((e) => rawLabelFor(e, doc).text)),
      hasValue: els.some((e) => e.checked === true),
    };
  }

  /**
   * Checkboxes sharing a name are one question too.
   *
   * Radios were grouped from the start; checkboxes were not, so a "tick the
   * one that applies" question arrived as N separate controls each labelled
   * with a single option word ("Yes", "Emergency"). Nothing described the
   * question, so no schema field could match it and the whole question was
   * silently unfillable.
   *
   * Grouped only at two or more. A lone named checkbox is a plain yes/no
   * toggle, and turning it into a one-option group would change what it means.
   */
  function describeCheckboxGroup(els, doc, ref) {
    const first = els[0];
    const groupLabel = sectionFor(first);
    return {
      ref,
      tag: "input",
      type: "checkbox-group",
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
      options: buildOptions(els.map((e) => rawLabelFor(e, doc).text)),
      hasValue: els.some((e) => e.checked === true),
    };
  }

  function collectControls(doc) {
    const nodes = Array.from(
      doc.querySelectorAll("input, select, textarea, [contenteditable='true']")
    );

    const controls = [];
    // ref -> the live element(s) behind that descriptor. Returned alongside
    // the descriptors rather than attached to them, so a dump stays a plain
    // serialisable object with no DOM references hiding inside it. dump()
    // ignores this; the filler is the only caller that wants it.
    const elements = new Map();
    const radioGroups = new Map();
    const checkboxGroups = new Map();
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

      if (type === "checkbox") {
        const name = el.getAttribute("name") || "";
        if (name) {
          if (!checkboxGroups.has(name)) checkboxGroups.set(name, []);
          checkboxGroups.get(name).push(el);
          continue;
        }
      }

      counter += 1;
      controls.push(describe(el, doc, `c${counter}`));
      elements.set(`c${counter}`, el);
    }

    for (const els of radioGroups.values()) {
      counter += 1;
      controls.push(describeRadioGroup(els, doc, `c${counter}`));
      // A radio group is one question over several elements, so the whole
      // set is kept — the filler picks the member matching the value.
      elements.set(`c${counter}`, els);
    }

    for (const els of checkboxGroups.values()) {
      counter += 1;
      if (els.length < 2) {
        // A single named checkbox is a yes/no toggle, not a question with
        // options. Emit it as the plain control it is.
        controls.push(describe(els[0], doc, `c${counter}`));
        elements.set(`c${counter}`, els[0]);
        continue;
      }
      controls.push(describeCheckboxGroup(els, doc, `c${counter}`));
      elements.set(`c${counter}`, els);
    }

    return { controls, elements, skippedPassword };
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
    return scrub(rawTextOf(doc.querySelector("legend")));
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

  root.breezefillLearn = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
