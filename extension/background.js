/**
 * ClaimFill service worker.
 *
 * ---------------------------------------------------------------------------
 * Why this file is nearly empty, and should stay that way
 * ---------------------------------------------------------------------------
 *
 * The obvious MV3 shape is a service worker acting as a message broker between
 * the side panel and the injected content script. That would be wrong here on
 * two counts.
 *
 * First, it is unnecessary. The side panel is an extension page, so it already
 * has the full extension API surface — it can call `chrome.scripting`,
 * `chrome.tabs`, and `chrome.permissions` itself. Routing through here would
 * add a hop and no capability.
 *
 * Second, and worse, it would put patient data somewhere it does not need to
 * be. An MV3 service worker is evicted after about thirty seconds idle and
 * restarted on demand, so a broker holding a clinical note either loses it
 * mid-claim or has to persist it to survive — and persisting it means
 * `chrome.storage`, which means patient data on disk. Neither is acceptable.
 *
 * The note lives in the panel's memory for exactly as long as the doctor has
 * the panel open, and nowhere else. Keeping this worker stateless is what
 * makes that true. If something here ever needs to remember a value between
 * two events, that is the signal it belongs in the panel instead.
 */

// Clicking the toolbar icon opens the side panel. Without this, the action
// click does nothing at all, since the manifest deliberately declares no
// default_popup — a popup closes the moment the doctor clicks the form, which
// is every time they check a filled value against the page.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => {
    // No patient data can reach here — this fires before any claim exists —
    // but keep it terse regardless, out of habit rather than necessity.
    console.error("ClaimFill: could not set panel behaviour", error);
  });
