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

/**
 * Opening the panel, and why it is done the long way.
 *
 * The one-liner for this is `setPanelBehavior({ openPanelOnActionClick: true })`
 * and it does open the panel. But Chrome then handles the toolbar click itself,
 * `action.onClicked` never fires, and — the part that matters — the click does
 * not count as invoking the extension, so **no `activeTab` is granted**. The
 * panel opens and then cannot touch the tab it is sitting next to.
 * Verified on Chrome 150: the panel reported "no access to this tab" on a page
 * the doctor was looking at.
 *
 * Taking the click here instead is what earns the grant: an `action.onClicked`
 * handler is the canonical `activeTab` trigger, and opening the panel from
 * inside it keeps the same one-click gesture. The grant then lasts until that
 * tab navigates or closes, which is the whole claim.
 *
 * `openPanelOnActionClick` is set to false explicitly rather than left unset.
 * It is persisted per-extension, so an install that ever set it true keeps
 * swallowing the click until something sets it back.
 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch((error) => {
    console.error("ClaimFill: could not set panel behaviour", error);
  });

chrome.action.onClicked.addListener((tab) => {
  // Must stay synchronous with the click: `sidePanel.open` requires the user
  // gesture, and awaiting anything first can spend it.
  chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
    // No patient data can reach here — this fires before any claim exists —
    // but keep it terse regardless, out of habit rather than necessity.
    console.error("ClaimFill: could not open the side panel", error);
  });
});
