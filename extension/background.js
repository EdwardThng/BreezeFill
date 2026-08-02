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
 *
 * ---------------------------------------------------------------------------
 * Opening the panel, and the call that is deliberately absent
 * ---------------------------------------------------------------------------
 *
 * The one-liner for this is `setPanelBehavior({ openPanelOnActionClick: true })`
 * and it does open the panel. But Chrome then handles the toolbar click
 * itself, `action.onClicked` never fires, and — the part that matters — the
 * click does not count as invoking the extension, so **no `activeTab` is
 * granted**. The panel opens and cannot touch the tab beside it. Verified on
 * Chrome 150: the panel reported "no access to this tab" on a page the doctor
 * was plainly looking at.
 *
 * Taking the click here instead is what earns the grant. An `action.onClicked`
 * handler is the canonical `activeTab` trigger, and opening the panel from
 * inside it keeps the same single click. The grant lasts until that tab
 * navigates or closes, which is the whole claim.
 *
 * There is no `setPanelBehavior({ openPanelOnActionClick: false })` call to
 * match. `false` is already the default, so it cannot help a clean install,
 * and it threw `Error: No SW` on Chrome 150 from the worker's top level *and*
 * from `onInstalled` — the side panel API refuses to attach a behaviour to a
 * worker it does not consider active, and there is no reliable moment at which
 * it does. Since the default is correct, the call was pure liability: an error
 * on every start, fixing nothing.
 *
 * The consequence to know: a stored `true` from an earlier build is cleared by
 * removing the extension and loading it again, not by calling this API. If the
 * panel ever opens without the listener below running, that flag is the reason.
 */

chrome.action.onClicked.addListener((tab) => {
  // Must stay synchronous with the click: `sidePanel.open` requires the user
  // gesture, and awaiting anything first can spend it. This listener firing at
  // all is also the signal that `activeTab` was granted.
  chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
    // No patient data can reach here — this fires before any claim exists —
    // but keep it terse regardless, out of habit rather than necessity.
    console.error("ClaimFill: could not open the side panel", error);
  });
});
