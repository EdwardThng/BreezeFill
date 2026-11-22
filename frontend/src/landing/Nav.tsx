import { useEffect, useState } from "react";
import Logo from "./Logo";

export default function Nav() {
  // The pill tightens once the page has scrolled, so it stops competing with
  // the hero's headline and reads as chrome over everything below it.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={"topbar" + (scrolled ? " is-scrolled" : "")} aria-label="Main">
      <a className="topbar-brand" href="#/">
        <Logo />
        <span>BreezeFill</span>
      </a>
      <div className="topbar-links">
        <a href="#how">How it works</a>
        <a href="#privacy">Privacy</a>
        <a href="#pricing">Pricing</a>
        <a href="#faq">FAQ</a>
      </div>
      <a className="topbar-cta" href="#/demo">
        See the demo
      </a>
    </nav>
  );
}
