/**
 * The listing, live and public since 2026-08-17.
 *
 * The id is Google's, not ours, and it is permanent for the life of the item —
 * so it is written here once and imported everywhere rather than repeated.
 */
export const STORE_ID = "efkojikbkmdglnjljmadmoboifjbblkm";
export const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_ID}`;

/**
 * The by-hand install — advertised again, temporarily, and under protest.
 *
 * `GET /download/breezefill-extension.zip` zips `extension/` from the source
 * tree on request, so it can never be older than the server serving it. That is
 * why it is the stopgap: it is 0.3.0 today, and 0.3.0 is what production's
 * `min_extension_version` requires.
 *
 * IT IS POINTED AT BY `#/get` STEP 2 UNTIL 0.3.0 IS APPROVED, and then it stops
 * being. The published item is 0.2.1, the floor is 0.3.0, so a store install
 * today refuses to send anything — sending a doctor to the store would hand them
 * a dead panel. This is the lesser of two bad options, not a good one:
 *
 * - It needs Developer Mode and "Load unpacked", which is the friction the store
 *   listing exists to remove and the thing a GP is least likely to finish.
 * - It does NOT auto-update. That is the stale-build trap in CLAUDE.md, walked
 *   into deliberately with a note on the page telling people to switch.
 * - An unpacked install has no `update_url`, so the panel shows the developer
 *   Advanced drawer to anyone who installs this way.
 *
 * Revert step 2 to STORE_URL the day the review clears.
 */
export const DOWNLOAD_URL = "/download/breezefill-extension.zip";

/**
 * Where every "get it" control on the site now goes.
 *
 * One funnel, not two. The store link and the Subscribe button used to be
 * separate offers on the same page, which asked a doctor to work out for
 * themselves whether installing meant paying. `#/get` puts the two in order
 * and says which one is required.
 */
export const GET_ROUTE = "#/get";

/**
 * ---------------------------------------------------------------------------
 * Two places to drop an asset in
 * ---------------------------------------------------------------------------
 *
 * Put the file in `frontend/public/` and set the path here — `public/` is
 * copied to the site root at build time, so a file at
 * `frontend/public/hero.png` is served as `/hero.png`.
 *
 * Local paths only. The page loads nothing from another origin and there is a
 * test asserting it, so a CDN or a YouTube embed would fail the suite as well
 * as the privacy argument the page makes.
 *
 * Until they are set, the hero falls back to the built-from-markup mock and
 * the video area shows a labelled placeholder.
 */
export const HERO_SHOT = "";
export const DEMO_VIDEO = "";
/** A still shown under the video before it plays. Optional. */
export const DEMO_VIDEO_POSTER = "";

/**
 * Where the Subscribe button sends a doctor.
 *
 * A Stripe Payment Link, set at build time the way `VITE_API_URL` is, so the
 * link can be created, replaced or repriced in the Stripe dashboard without a
 * code change. Until it is set the button points at the pricing section
 * itself, which is inert rather than broken — a dead `href` on the one control
 * that takes money is worse than a button that visibly does nothing yet.
 */
export function subscribeUrl(): string {
  return (import.meta.env.VITE_STRIPE_PAYMENT_LINK as string | undefined) || "";
}

/** 200 SGD/month, stated once so the page and the tests cannot drift apart. */
export const PRICE = { amount: "200", currency: "SGD", period: "month" };
