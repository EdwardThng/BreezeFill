import { Arrow } from "./Hero";
import { GET_ROUTE, PRICE, subscribeUrl } from "./config";
import WindMark from "./WindMark";

// What the subscription actually buys. Written as capability and support,
// never as a change to how the software behaves: the refusals are the product
// and they are identical at every price, including free.
const INCLUDED = [
  "Unlimited claims, on every insurer form the extension can read",
  "The described forms — AIA and Great Eastern group hospital & surgical — plus any form it meets, read from the page",
  "Updates as insurers change their forms, delivered automatically through Chrome",
  "Support by email, answered by the person who wrote it",
];

export default function Pricing() {
  return (
    <section className="section pricing" id="pricing" aria-labelledby="pricing-title">
      <div className="pricing-copy">
        <h2 id="pricing-title">One price, one user.</h2>
        {/* "Per clinic" until 2026-11-22. The owner's call: a subscription is
            for one person, so a clinic where the doctor and an assistant both
            fill forms holds two. This is a licence term; the extension does
            not yet enforce it, so the copy states it and claims nothing
            about detection. */}
        <p className="section-lede">
          No per-claim charge and no per-form charge. A claim you decide not to
          submit costs nothing, and neither does a form it declines to fill.
          Each subscription is for one person — the doctor, or the member of
          staff who fills the forms.
        </p>
        {/* The honest caveat, in the pricing section rather than buried in a
            FAQ. A doctor deciding whether to pay should read this before they
            decide, not after. */}
        <p className="price-caveat">
          What it will not do does not change with the price: it still leaves a
          question blank rather than guess at it, still asks you to confirm
          anything it did not quote from your note, and still never presses
          submit.
        </p>
      </div>

      <div className="price-card">
        <WindMark className="price-mark" />
        <p className="price">
          <span className="price-currency">{PRICE.currency}</span>
          <span className="price-amount">{PRICE.amount}</span>
          <span className="price-period">per {PRICE.period}, one user</span>
        </p>
        <ul className="price-included">
          {INCLUDED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {/* No dead button. Until the payment link exists there is nothing to
            subscribe to, and a control that looks live and does nothing is
            worse on a page taking money than no control at all. Through #/get
            rather than straight to Stripe, so the price and the install are
            read in that order. One funnel; see GET_ROUTE. */}
        {subscribeUrl() ? (
          <>
            <a className="act act-navy" href={GET_ROUTE}>
              Subscribe
            </a>
            <p className="price-note">
              Billed monthly, cancel any time. Checkout is handled by Stripe,
              then you install from the Chrome Web Store.
            </p>
          </>
        ) : (
          <>
            <p className="price-pending">
              Subscriptions are not open yet. The extension is on the Chrome Web
              Store and free to install during the pilot.
            </p>
            <a className="act act-navy" href={GET_ROUTE}>
              Get BreezeFill
              <Arrow />
            </a>
          </>
        )}
      </div>
    </section>
  );
}
