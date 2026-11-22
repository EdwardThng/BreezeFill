import { useEffect, useRef, useState } from "react";
import { Arrow } from "./Hero";
import { GET_ROUTE, PRICE } from "./config";
import Logo from "./Logo";
import WindMark from "./WindMark";

export default function Closing() {
  // The wind mark draws itself once the band scrolls into view. Without an
  // observer (jsdom) or with reduced motion it is simply drawn.
  const ref = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") {
      setDrawn(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setDrawn(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className={"closing" + (drawn ? " is-drawn" : "")} ref={ref}>
      <WindMark className="closing-wind" strokeWidth={22} />
      <FinalCta />
      <Footer />
      {/* Decoration, so it is hidden from assistive tech and unreachable. */}
      <div className="closing-mark" aria-hidden="true">
        <Logo />
        <span>breezefill</span>
      </div>
    </div>
  );
}

function FinalCta() {
  return (
    <section className="section final-cta" aria-labelledby="final-title">
      <h2 id="final-title">Your forms, filled and checked.</h2>
      {/* The offer and the price in the same breath. A free download sitting
          silently next to a priced plan asks the reader to work out whether
          they are about to be charged. The pilot is what is on offer; the
          price is what it becomes, and neither is tied to an event that has
          already happened. */}
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
        <a className="btn btn-sky" href={GET_ROUTE}>
          Get BreezeFill
          <Arrow />
        </a>
        <a className="btn btn-quiet-dark" href="#/demo">
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
        <p className="footer-copy">© 2026 BreezeFill · It fills. You check. You submit.</p>
        {/* Privacy only. There is no terms page, and a link to one that does
            not exist is worse than one fewer link. A real path, not a #/
            route: the policy is static HTML so it reads even if this bundle
            does not. */}
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
