import { GET_ROUTE, HERO_SHOT } from "./config";

export default function Hero() {
  return (
    <header className="hero">
      {/* Three things were removed from this header on 2026-08-17, all on the
          owner's call, and two of them had become untrue:

          - A badge reading "Now on the Chrome Web Store". The listing is public
            but the published build does not run against production, and `#/get`
            hands out a zip instead, so announcing the store was advertising the
            one route that is broken.
          - A fineprint line, "One click from the Chrome Web Store." Same
            problem, and it is now several clicks and Developer Mode.
          - A trust line reading "No sign-in · Identifiers never reach the model
            · Nothing is stored". The middle claim is the one CLAUDE.md's hard
            rules forbid making: pass 3 of redaction IS a Claude call, so a name
            the browser's pass 1 misses reaches Anthropic in the sweep. The
            defensible claim is narrower — the model *answering the form* is not
            shown identifiers — and it is made properly in the privacy section
            rather than compressed into a badge.

          Do not restore any of them from a design file. */}
      <h1>
        You already wrote this.
        <br />
        Once.
      </h1>
      <p className="lede">
        Paste the consultation into a panel beside the insurer's form.
        BreezeFill reads the questions on that form, proposes an answer to each
        one with the line from your note that supports it, and writes in only
        what you confirm. It never submits.
      </p>
      <div className="cta-row">
        <a className="btn btn-primary btn-large" href={GET_ROUTE}>
          Get BreezeFill
        </a>
        <a className="btn btn-ghost btn-large" href="#/demo">
          Watch it fill a form
        </a>
      </div>
      <HeroShot />
    </header>
  );
}

/** The hero still. Falls back to the built-from-markup mock until HERO_SHOT is set. */
function HeroShot() {
  // The chrome is drawn only around a real screenshot. The fallback mock
  // already renders its own address bar, and stacking both put two URL bars on
  // top of each other.
  if (!HERO_SHOT) {
    return (
      <div className="shot-frame is-mock">
        <HeroVisual />
      </div>
    );
  }
  return (
    <div className="shot-frame">
      <div className="shot-chrome" aria-hidden="true">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span className="url">insurer.com.sg/claim</span>
      </div>
      <img
        className="shot-img"
        src={HERO_SHOT}
        alt="The BreezeFill panel beside an insurer's claim form"
      />
    </div>
  );
}

/**
 * A still of the product: the panel on the left, the insurer's form on the
 * right, mid-fill. Built from markup rather than a screenshot so it stays
 * truthful when the panel changes, and so the page carries no image of a
 * filled claim form.
 */
function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="mock">
        <div className="mock-panel">
          <div className="mock-panel-head">BreezeFill</div>
          <div className="mock-paste">
            <span className="ln" />
            <span className="ln" />
            <span className="ln short" />
          </div>
          <div className="mock-rows">
            <div className="mock-row">
              <span className="pill green">From your notes</span>
              <span className="bar" />
            </div>
            <div className="mock-row">
              <span className="pill amber">Check this</span>
              <span className="bar short" />
            </div>
            <div className="mock-row">
              <span className="pill grey">Not found</span>
              <span className="bar empty" />
            </div>
          </div>
        </div>
        <div className="mock-form">
          <div className="mock-form-head">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span className="url">insurer.com.sg/claim</span>
          </div>
          {["Patient name", "Diagnosis", "Date of admission", "ICD-10 code"].map(
            (label, i) => (
              <div className="mock-field" key={label}>
                <span className="mock-label">{label}</span>
                <span className={"mock-input" + (i === 3 ? " blank" : " filled")} />
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
