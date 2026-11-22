import { GET_ROUTE, PRICE } from "./config";
import Logo from "./Logo";

export default function Closing() {
  return (
    <div className="closing">
      <FinalCta />
      <Footer />
      {/* Decoration, so it is hidden from assistive tech and unreachable. The
          mark sits with the word and is tinted to the same value, so the two
          read as one object printed on the band rather than a logo placed on
          top of it. */}
      <div className="closing-mark" aria-hidden="true">
        <Logo />
        <span>breezefill</span>
      </div>
    </div>
  );
}

function FinalCta() {
  return (
    <section className="section final-cta">
      <p className="eyebrow">Ready to start</p>
      <h2>Your forms, filled and checked.</h2>
      {/* The offer and the price in the same breath. A free download sitting
          silently next to a priced plan asks the reader to work out whether
          they are about to be charged, and that is the one thing a page taking
          money must not make them guess at. */}
      {/* The offer and the price in the same breath, still — but the trigger
          has changed. This used to say the price starts "when it reaches the
          Chrome Web Store", which stopped being a future event on 2026-08-17
          and would have read as "you are being charged from today" beside a
          pricing card that has no Subscribe button. The pilot is what is on
          offer; the price is what it becomes, and neither is tied to an event
          that has already happened. */}
      <p>
        Free during the pilot. It becomes {PRICE.currency} {PRICE.amount} a{" "}
        {PRICE.period} once subscriptions open — the pilot is not a trial that
        expires underneath you, and you will be asked before anything is
        charged.
      </p>
      <p>
        Works in Chrome. Uninstalling it leaves nothing behind, because nothing
        was ever saved.
      </p>
      <div className="cta-row">
        <a className="btn btn-primary btn-large" href={GET_ROUTE}>
          Get BreezeFill
        </a>
        <a className="btn btn-ghost btn-large" href="#/demo">
          See the demo first
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-row">
        <p className="footer-copy">
          © 2026 BreezeFill · It fills. You check. You submit.
        </p>
        {/* Privacy only. The reference has "Terms" beside it and there is no
            terms page — a link to one that does not exist is worse than one
            fewer link, particularly on a page a Web Store reviewer reads.
            A real path, not a #/ route: the policy is static HTML so it reads
            even if this bundle does not. `cleanUrls` in vercel.json is what
            makes /privacy resolve to public/privacy.html. */}
        <nav className="footer-links" aria-label="Legal">
          <a href="/privacy">Privacy</a>
        </nav>
      </div>
      <p className="footer-note">
        Assists with form completion. The reviewing doctor remains responsible
        for the accuracy of every submitted form.
      </p>
    </footer>
  );
}
