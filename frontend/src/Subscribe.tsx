import { useEffect, useState } from "react";
import { DOWNLOAD_URL, PRICE, STORE_URL } from "./Landing";
import { openCheckout, claimLicence } from "./api";

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

/**
 * The checkout Stripe just sent this doctor back from, if any.
 *
 * A session id, NOT a `?paid=1`. The old flag was a string anyone could type
 * into the address bar, which was fine while this page was only a funnel and
 * useless the moment it hands out a credential. A `cs_…` is minted by Stripe,
 * names one checkout, cannot be guessed — and the server re-checks with Stripe
 * that it was actually paid before signing anything, so a stolen one is worth
 * no more than the payment behind it.
 */
export function sessionOf(hash: string): string {
  const match = /[?&]session_id=(cs_[A-Za-z0-9_]+)/.exec(String(hash || ""));
  return match ? match[1] : "";
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
  const session = sessionOf(window.location.hash);

  /**
   * The licence, once the server has confirmed the payment behind it.
   *
   * Held in component state and nowhere else. It is a credential, and this
   * page has no business writing one into localStorage on the doctor's behalf
   * — they copy it into the panel, which is the only place it is needed.
   */
  const [licence, setLicence] = useState("");
  const [claiming, setClaiming] = useState(Boolean(session));
  const [failed, setFailed] = useState("");

  useEffect(() => {
    if (!session) return;
    let live = true;
    claimLicence(session)
      .then((key) => live && setLicence(key))
      // The message, not a generic one: the server distinguishes "not paid"
      // from "no such checkout" and a doctor who has just been charged needs
      // to be told which of those happened.
      .catch((error) => live && setFailed(String(error.message || error)))
      .finally(() => live && setClaiming(false));
    return () => {
      live = false;
    };
  }, [session]);

  const [opening, setOpening] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");

  async function subscribe() {
    setOpening(true);
    setCheckoutError("");
    try {
      // Straight to Stripe. The session is created server-side so the price
      // cannot be tampered with on the way.
      window.location.href = await openCheckout();
    } catch (error) {
      setCheckoutError(String((error as Error).message || error));
      setOpening(false);
    }
  }

  // Paid means the server signed a licence for this session. A session id in
  // the URL is not enough on its own, which is the whole reason the exchange
  // happens rather than the page trusting what it was handed.
  const paid = Boolean(licence);

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
        <Step index={1} title="Subscribe" state={paid ? "done" : "open"}>
          {paid ? (
            <>
              <p className="get-note">
                Thank you — your subscription is active. A receipt is on its way
                to the address you gave Stripe.
              </p>
              <p>
                <strong>This is your licence key.</strong> Paste it into the
                BreezeFill panel once, under Advanced. Keep it — it is the only
                copy, and it is a credential: anyone holding it can map claims
                on your subscription.
              </p>
              <code className="licence-key">{licence}</code>
              <p className="get-note">
                Lost it? Open the link in your Stripe receipt again and this
                page will re-issue the same key.
              </p>
            </>
          ) : claiming ? (
            <p className="get-note">Confirming your payment with Stripe…</p>
          ) : failed ? (
            <>
              {/* Never a dead end. Whatever went wrong, the doctor has either
                  already paid or has not, and both need a way forward. */}
              <p className="get-error">{failed}</p>
              <button className="btn btn-primary btn-large" type="button" onClick={subscribe}>
                Try again
              </button>
            </>
          ) : (
            <>
              <p>
                Checkout is handled by Stripe. We never see your card, and the
                subscription is the only record either of us keeps.
              </p>
              <button
                className="btn btn-primary btn-large"
                type="button"
                onClick={subscribe}
                disabled={opening}
              >
                {opening
                  ? "Opening Stripe…"
                  : `Subscribe — ${PRICE.currency} ${PRICE.amount}/${PRICE.period}`}
              </button>
              {checkoutError ? <p className="get-error">{checkoutError}</p> : null}
            </>
          )}
        </Step>

        {/* STOPGAP, 2026-08-17. This step pointed at the Chrome Web Store, and
            it will again the moment 0.3.0 is approved.

            Why it cannot right now: the published item is 0.2.1, production
            publishes `min_extension_version: "0.3.0"`, and so the panel on every
            store install refuses to send before it does anything else. Sending a
            doctor to the store today hands them an extension that cannot work.
            The download below is the current build, zipped from the source tree
            on request, so it is 0.3.0 and it passes the floor.

            What this step must NOT do is keep the old label over the new
            target. "Install from the Chrome Web Store" on a control that
            downloads a zip is a lie to the person least able to check it, and
            the by-hand install has real conditions attached — Developer Mode,
            and no auto-update — which are exactly what the store install exists
            to avoid. So the label changed and the conditions are stated. The
            layout, the classes and the funnel are untouched. */}
        <Step
          index={2}
          title="Install the current build"
          /* Opens on a licence the SERVER signed, never on a session id in
             the URL. That is the difference between a funnel and a gate, and
             it is one line. */
          state={paid ? "open" : "shut"}
        >
          {paid ? (
            <>
              <p>
                The Chrome Web Store listing is one version behind while an
                update is in review, and that older version will not run. This
                downloads the current build instead. It takes a few more steps
                than the store, and Chrome will not keep it up to date.
              </p>
              <a className="btn btn-primary btn-large" href={DOWNLOAD_URL}>
                Download BreezeFill (.zip)
              </a>
              <ol className="install-steps">
                <li>Unzip it. You will get a <code>breezefill-extension</code> folder.</li>
                <li>
                  Open <code>chrome://extensions</code> and turn on{" "}
                  <strong>Developer mode</strong>, top right.
                </li>
                <li>
                  Click <strong>Load unpacked</strong> and select that folder.
                </li>
                <li>
                  Open an insurer's claim form, click the BreezeFill icon on that
                  tab, and paste the consultation into the panel.
                </li>
              </ol>
              <p className="get-note">
                Once the update is approved, install from{" "}
                <a href={STORE_URL} target="_blank" rel="noopener noreferrer">
                  the Chrome Web Store
                </a>{" "}
                instead and remove this copy — the store version updates itself,
                and this one will not.
              </p>
            </>
          ) : (
            <p className="get-note">
              Available once your subscription is confirmed.
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
          Your subscription is what funds this and keeps the backend running.
          The licence key above is what the BreezeFill panel asks for, and it
          is checked against your subscription every time a claim is mapped.
        </p>
        <p>
          Being straight about one thing: enforcement is being switched on, and
          until it is, a copy of the extension obtained another way will still
          work. We are not going to backdate a charge to anyone who installed
          it while that was true, and you will always be asked before anything
          is charged.
        </p>
        <p>
          The refusals that make this trustworthy — it never submits, it leaves
          a field blank rather than guess, identifiers never reach the model
          that answers the form — are identical at every price, including free.
          A subscription buys the service, never a change in how carefully it
          behaves.
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
