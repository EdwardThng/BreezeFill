import { GET_ROUTE, PRICE, STORE_URL, subscribeUrl } from "./Landing";

/**
 * The one way in: subscribe, then install.
 *
 * Every "get it" control on the site lands here rather than on the Chrome Web
 * Store, so the price is read before the install rather than discovered after
 * it. Step 2 stays shut until Stripe sends the doctor back with a completed
 * checkout.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PAGE DOES NOT DO, and it must not be written as though it does
 * ---------------------------------------------------------------------------
 *
 * It does not make a subscription necessary. The listing is PUBLIC: anyone who
 * searches the Chrome Web Store, or who has the item id — which is in this
 * bundle, because the button needs it — installs in one click without ever
 * seeing this page. A website cannot gate a store listing, and no arrangement
 * of this file can change that.
 *
 * The gate that would work lives in the panel: a licence key checked against
 * Stripe before the extension will map anything (CLAUDE.md, next steps 2c). It
 * is not built. Until it is, **the extension works without paying**, and this
 * page is a funnel rather than a lock.
 *
 * That is why the copy below says "supports" and "keeps" and never "unlocks",
 * "activates" or "required to use". Taking SGD 200 a month off a GP for
 * something they would have got free is worse than shipping no paywall at all,
 * and it is the kind of claim that is easy to add here by accident when the
 * gate finally ships somewhere else. Change this wording when the panel
 * refuses to work without a key, and not one commit before.
 *
 * There is a second reason not to claim it, and it is not ours to waive:
 * Chrome's terms say you may not collect future charges from users for copies
 * they were allowed to download for free. Every install from the public
 * listing today is a free one, permanently.
 */

/** Did Stripe just send this doctor back from a completed checkout? */
export function checkoutDone(hash: string): boolean {
  return /[?&]paid=1(&|$)/.test(String(hash || ""));
}

/**
 * Where Stripe should return to.
 *
 * Absolute, because a Payment Link's redirect is configured in the Stripe
 * dashboard against a real URL and cannot be a fragment on its own. Built from
 * the page's own origin so a preview deploy returns to the preview rather than
 * to production.
 */
export function returnUrl(): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/${GET_ROUTE}?paid=1`;
}

function Step({
  index,
  title,
  state,
  children,
}: {
  index: number;
  title: string;
  state: "open" | "shut" | "done";
  children: React.ReactNode;
}) {
  return (
    <li className={`get-step ${state}`}>
      <span className="get-step-index" aria-hidden="true">
        {state === "done" ? "✓" : index}
      </span>
      <div className="get-step-body">
        <h2>{title}</h2>
        {children}
      </div>
    </li>
  );
}

export default function Subscribe() {
  const paid = checkoutDone(window.location.hash);
  const stripe = subscribeUrl();

  return (
    <div className="landing get-page">
      <header className="get-head">
        <a className="get-back" href="#/">
          ← BreezeFill
        </a>
        <p className="eyebrow">Get BreezeFill</p>
        <h1>Subscribe, then install.</h1>
        <p className="lede">
          One subscription per clinic. {PRICE.currency} {PRICE.amount} a{" "}
          {PRICE.period}, billed monthly, cancel any time.
        </p>
      </header>

      <ol className="get-steps">
        <Step
          index={1}
          title="Subscribe"
          state={paid ? "done" : "open"}
        >
          {paid ? (
            <p className="get-note">
              Thank you — your subscription is active. A receipt is on its way
              to the address you gave Stripe.
            </p>
          ) : stripe ? (
            <>
              <p>
                Checkout is handled by Stripe. We never see your card, and the
                subscription is the only record either of us keeps.
              </p>
              <a className="btn btn-primary btn-large" href={stripe}>
                Subscribe — {PRICE.currency} {PRICE.amount}/{PRICE.period}
              </a>
            </>
          ) : (
            /* No dead button, the same rule the pricing card follows. Until
               the payment link exists there is nothing to subscribe to, and a
               control that looks live and does nothing is at its worst on the
               one that takes money. */
            <p className="price-pending">
              Subscriptions are not open yet. The extension is free to install
              in the meantime — step 2 is below.
            </p>
          )}
        </Step>

        <Step
          index={2}
          title="Install from the Chrome Web Store"
          /* Shut only while there is something to complete first. With no
             payment link there is no step 1 to finish, and a step 2 that
             cannot be reached would leave the page with no way out at all. */
          state={paid || !stripe ? "open" : "shut"}
        >
          {paid || !stripe ? (
            <>
              <p>
                One click, and Chrome keeps it up to date from here on. Open an
                insurer's claim form, click the BreezeFill icon on that tab, and
                paste the consultation into the panel.
              </p>
              <a
                className="btn btn-primary btn-large"
                href={STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Install from the Chrome Web Store
              </a>
            </>
          ) : (
            <p className="get-note">
              Available once step 1 is complete.
            </p>
          )}
        </Step>
      </ol>

      {/* The honest paragraph, and the reason it is on the page rather than in
          a FAQ: a doctor about to enter card details is exactly who is owed
          it. See the header of this file for why softening it would be the
          worst change anyone could make here. */}
      <section className="get-honest">
        <h2>What you are paying for, and what you are not</h2>
        <p>
          BreezeFill is free to install today and the pilot stays free — the
          listing is public, so nothing here locks the extension. Subscribing
          funds the work and keeps the backend running; it does not switch
          anything on that would otherwise be off, and the refusals that make
          the product trustworthy are identical at every price, including free.
        </p>
        <p>
          If you would rather wait, install it and use it. You will be asked
          before anything is ever charged.
        </p>
      </section>

      <p className="fineprint">
        Prefer not to install from the store?{" "}
        <a href="#/demo">Watch it fill a form first</a>, or read the{" "}
        <a href="/privacy">privacy policy</a>.
      </p>
    </div>
  );
}
