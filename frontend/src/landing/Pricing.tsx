import { GET_ROUTE, PRICE, subscribeUrl } from "./config";

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
    <section className="section pricing" id="pricing">
      <p className="eyebrow">Pricing</p>
      <h2>One price, per clinic.</h2>
      <p className="section-lede">
        No per-claim charge and no per-form charge. A claim you decide not to
        submit costs nothing, and neither does a form it declines to fill.
      </p>

      <div className="price-card">
        <p className="price">
          <span className="price-amount">
            {PRICE.currency} {PRICE.amount}
          </span>
          <span className="price-period">per {PRICE.period}</span>
        </p>
        <ul className="price-included">
          {INCLUDED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {/* No dead button. Until the payment link exists there is nothing to
            subscribe to, and a control that looks live and does nothing is
            worse on a page taking money than no control at all. */}
        {/* Through #/get rather than straight to Stripe, so the price and the
            install are read in that order and nobody reaches checkout without
            the honest paragraph about what a subscription does and does not
            do. One funnel; see GET_ROUTE. */}
        {subscribeUrl() ? (
          <>
            <a className="btn btn-primary btn-large" href={GET_ROUTE}>
              Subscribe
            </a>
            <p className="price-note">
              Billed monthly, cancel any time. Checkout is handled by Stripe,
              then you install from the Chrome Web Store.
            </p>
          </>
        ) : (
          <p className="price-pending">
            Subscriptions are not open yet. The extension is on the Chrome Web
            Store and free to install during the pilot.
          </p>
        )}
      </div>

      {/* The honest caveat, in the pricing section rather than buried in a
          FAQ. A doctor deciding whether to pay should read this before they
          decide, not after. */}
      <p className="price-caveat">
        What it will not do does not change with the price: it still leaves a
        question blank rather than guess at it, still asks you to confirm
        anything it did not quote from your note, and still never presses
        submit.
      </p>
    </section>
  );
}
