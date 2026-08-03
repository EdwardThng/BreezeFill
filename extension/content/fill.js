/**
 * ClaimFill content orchestrator — the only code that touches the insurer's page.
 *
 * Injected on an explicit doctor gesture, together with learn/dump.js,
 * fill/locate.js and fill/apply.js. Answers two messages from the side panel:
 *
 *   survey -> collect + locate, return the match report. Nothing is written.
 *   fill   -> collect + locate + apply. Nothing is submitted.
 *
 * ---------------------------------------------------------------------------
 * Page structure never leaves the browser
 * ---------------------------------------------------------------------------
 *
 * This is the boundary the hybrid design rests on. The server sees the schema
 * and the redacted note; it never sees the portal's DOM. Locating happens
 * here, where the structure already is, so there is no code path that could
 * make page structure a per-claim LLM input.
 *
 * The report does travel to the panel, which is still the doctor's browser and
 * still never the network. Every label in it has been through the learn-mode
 * scrubber, because `collectControls` uses the same scrubbed `labelFor` that
 * a shareable dump does. A portal that renders the patient's name into a
 * field label therefore cannot leak it into the panel either — with the known
 * limit that the scrubber finds identifiers by shape, and a name has none.
 *
 * ---------------------------------------------------------------------------
 * Why fill re-locates instead of trusting the survey
 * ---------------------------------------------------------------------------
 *
 * These portals are wizards. Between the doctor reviewing values and pressing
 * fill, a step can advance, a conditional section can appear, or a framework
 * can re-render and replace every node. Element references captured during the
 * survey would then be detached — writes would land on nodes no longer in the
 * document and silently do nothing, which looks exactly like a portal that
 * ignored us. Re-locating costs a few milliseconds and removes the failure.
 *
 * ---------------------------------------------------------------------------
 * Known gap: the top frame only
 * ---------------------------------------------------------------------------
 *
 * Injection is not `allFrames`, so a form rendered inside an iframe reads as a
 * page with no controls — the panel will report nothing matched rather than
 * filling the wrong thing, which is the safe direction to fail. Whether
 * ClaimEZ uses one is unknown until a real page is seen. Fixing it properly
 * means deciding how per-frame reports merge and which frame a match rate is
 * computed over, so it waits for evidence rather than being guessed at.
 */

(function () {
  "use strict";

  // Injecting twice into the same tab would register a second listener and
  // every message would be handled twice — the second run writing over the
  // first. The panel re-injects freely, so this has to be idempotent.
  if (globalThis.__claimfillContentReady) return;
  globalThis.__claimfillContentReady = true;

  const learn = globalThis.claimfillLearn;
  const locate = globalThis.claimfillLocate;
  const apply = globalThis.claimfillApply;

  /**
   * The visible text of a radio's own label, used to decide which member of a
   * group a value selects.
   *
   * Deliberately the raw text rather than the scrubbed one: this never leaves
   * the page, and it is compared against a schema value like "Yes". Scrubbing
   * could rewrite an option into something that no longer matches, which would
   * silently turn a fillable field into a skipped one.
   */
  function labelOf(el) {
    const wrapper = el.closest("label");
    if (!wrapper) return "";
    const clone = wrapper.cloneNode(true);
    clone.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
    return clone.textContent.trim();
  }

  /**
   * Trim a locate report to what the panel needs to render.
   *
   * Everything crossing this boundary must survive structured cloning, so no
   * element references — only the plain descriptors `collectControls` built.
   */
  function serialise(report) {
    return {
      matched: report.matched,
      intended: report.intended,
      matchRate: report.matchRate,
      safeToFill: report.safeToFill,
      results: report.results.map((r) => ({
        fieldId: r.fieldId,
        status: r.status,
        score: r.score,
        control: r.control
          ? { ref: r.control.ref, label: r.control.label, type: r.control.type }
          : null,
      })),
      // Live controls no schema field claimed. Not an error: it is how a
      // portal that grew a question surfaces, and the input to extending the
      // schema rather than something to paper over.
      unknownControls: report.unknownControls,
    };
  }

  /**
   * Score several schemas against this page at once.
   *
   * "Is this form one we already have?" is a question the page can answer
   * itself, and this is a better key than anything in the source: a form id or
   * version string in the markup rots at the insurer's next deploy, while what
   * actually matters is whether the page carries the fields a schema
   * describes. That is precisely what `locate` already computes, so
   * identifying a form and deciding whether it is safe to fill are the same
   * measurement read at two different thresholds.
   *
   * Only the counts cross back. The per-field results would name which of the
   * schema's questions this page asks, which the panel has no use for until a
   * schema is actually chosen.
   */
  function score(candidates, controls) {
    return (candidates || []).map((candidate) => {
      const report = locate.locate(candidate.fields || [], controls);
      return {
        formId: candidate.formId,
        matched: report.matched,
        intended: report.intended,
        matchRate: report.matchRate,
      };
    });
  }

  function survey(plan, candidates) {
    const { controls, skippedPassword } = learn.collectControls(document);
    const report = locate.locate(plan || [], controls);
    return {
      ok: true,
      host: location.host,
      controlCount: controls.length,
      skippedPassword,
      report: serialise(report),
      candidates: score(candidates, controls),
    };
  }

  function fill(plan, values) {
    const { controls, elements } = learn.collectControls(document);
    const report = locate.locate(plan || [], controls);
    const result = apply.applyPlan(report, elements, values || {}, { labelOf });
    return {
      ok: true,
      host: location.host,
      report: serialise(report),
      refused: result.refused,
      reason: result.reason || null,
      filled: result.filled,
      applied: result.applied,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "claimfill-content") return undefined;

    try {
      if (message.action === "survey") {
        sendResponse(survey(message.plan, message.candidates));
      } else if (message.action === "fill") {
        sendResponse(fill(message.plan, message.values));
      } else {
        sendResponse({ ok: false, error: "unknown action" });
      }
    } catch (error) {
      // The message may name a field but never carries a value back out, and
      // an exception here could have touched anything on the page. Report the
      // type and nothing else.
      sendResponse({ ok: false, error: String((error && error.name) || "error") });
    }
    // Everything above answers synchronously; returning true would leave the
    // channel open and the panel waiting.
    return undefined;
  });

  globalThis.claimfillContent = { survey, fill, labelOf, serialise, score };
})();
