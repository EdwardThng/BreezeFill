import { useEffect, useRef, useState } from "react";

/**
 * The front door.
 *
 * The site's only job now is to hand out the extension and show what it does.
 * Everything here is static: no API call, no backend dependency, so the page
 * still renders if the server is asleep — which it now is, most of the time.
 *
 * Tone note, because it is easy to undo by accident: this product's claim is
 * *precision*, not coverage. Copy that promises to fill whole forms
 * automatically would be writing a cheque the software deliberately refuses to
 * cash — it leaves fields blank rather than guess, and it never submits. Say
 * that plainly; for a doctor signing the result, it is the selling point.
 */

export const DOWNLOAD_URL = "/download/breezefill-extension.zip";

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

// What the subscription actually buys. Written as capability and support,
// never as a change to how the software behaves: the refusals are the product
// and they are identical at every price, including free.
const INCLUDED = [
  "Unlimited claims, on every insurer form the extension can read",
  "The described forms — AIA and Great Eastern group hospital & surgical — plus any form it meets, read from the page",
  "Updates as insurers change their forms, delivered automatically through Chrome",
  "Support by email, answered by the person who wrote it",
];


/**
 * The scroll-driven fill.
 *
 * The design storyboards this as a tall section whose inner panel sticks while
 * the page scrolls past it, filling a form a row at a time. Its own copy was
 * built around a "Remember this answer? Save / Not now" prompt — a feature
 * that would need chrome.storage, which this extension deliberately does not
 * have. So the stages follow the panel's real sequence instead, and the beat
 * the design gave to saving is given to the refusal that actually happens:
 * two candidates in the note, and the doctor picking which is the patient's.
 */
const DEMO_ROWS = [
  { label: "Patient name", value: "Tan Wei Ling", note: "Typed by you at step 1" },
  { label: "NRIC", value: "S8012345D", note: "Found by pattern, not by the model" },
  { label: "Date of admission", value: "02/08/2026", note: "Quoted from your note" },
  { label: "Diagnosis", value: "Acute tonsillitis", note: "Quoted from your note" },
  { label: "Contact number", value: "", note: "Two in the note — you choose", choose: ["9123 4567", "6123 4567"] },
];

const DEMO_STAGES = [
  {
    title: "Paste the consultation.",
    body: "One box, beside the insurer's form. Exactly as it sits in your CMS — demographics header and clinical note together.",
  },
  {
    title: "It reads the questions on the page.",
    body: "Every field on the form becomes something to answer, matched by the wording of the question rather than the page's code.",
  },
  {
    title: "Each answer arrives with its source.",
    body: "Quoted from your note, marked as inferred, or left as not found. Nothing is written into the form yet.",
  },
  {
    title: "Where the note says two things, it asks.",
    body: "Two phone numbers in one note. It fills neither and hands you the choice, because guessing here writes the clinic's number onto the patient's claim.",
  },
  {
    title: "You confirm. Then it fills.",
    body: "The values you accepted go into the insurer's own form, and it stops. You read it, sign it and submit it yourself.",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Read the form in front of you",
    body: "Every question on the insurer's page becomes something to answer — matched by the wording of the question, not by the page's code, so a redesign usually changes nothing. Where BreezeFill knows the form, it uses the instruction a colleague would give instead of the question as the page happens to word it.",
  },
  {
    n: "02",
    title: "Propose one answer, with its source",
    body: "Each value arrives quoted from your note, marked as inferred, or left as not found. Where the note says two things — two phone numbers, two policy numbers — it fills neither and asks which one is the patient's.",
  },
  {
    n: "03",
    title: "Nothing is written until you confirm",
    body: "Anything not quoted directly from your note needs an explicit click. Then the values go into the insurer's own form and stop: it never overwrites an answer you already gave, never presses a button, and never submits.",
  },
];

const GUARANTEES = [
  {
    title: "Names never reach the model",
    body: "Your patient's name, NRIC, phone and address are pulled out by pattern matching — no AI involved — and are used to scrub the note before any of it is sent. The model only ever sees text with [PATIENT] and [NRIC] where the identifiers were.",
  },
  {
    title: "Nothing is stored",
    body: "There is no database. The claim lives in the panel while it is open and is gone when you close it. The server keeps nothing at all from a form filled this way.",
  },
  {
    title: "Blanks over guesses",
    body: "A field left empty costs you a few seconds of typing. A field filled wrongly gets signed and submitted as your clinical statement. So it declines: ambiguous questions are left for you, and a page it does not recognise is not touched at all.",
  },
  {
    title: "It cannot read your other tabs",
    body: "No standing access to any site. It sees one page, once, because you clicked the BreezeFill icon on it — and it asks for no permission to save anything to your computer.",
  },
];

const FAQS = [
  {
    q: "Does it submit the claim for me?",
    a: "No, and it never will. It fills the fields; you read them, sign and submit. That boundary is enforced in the code and covered by tests.",
  },
  {
    q: "What if the insurer's form is one you have never seen?",
    a: "It reads the questions off the page and maps against those instead. Afterwards it hands back a description of that form, so the next claim on it is faster.",
  },
  {
    q: "What happens when a form changes?",
    a: "It matches on the wording of questions, not on the page's code, so a redesign usually changes nothing. When too little matches, it fills nothing and says so rather than filling part of a form you might assume was complete.",
  },
  {
    q: "Is my patient data leaving Singapore?",
    a: "Your patient's identifiers do not: name, NRIC, date of birth, phone, address and policy number are stripped out before anything is sent, and they are what the note is scrubbed against. The de-identified clinical text does — the model runs outside Singapore. The PDPA expects a comparable-protection agreement for an overseas transfer and there is not one in place yet, which the privacy policy says in those words rather than burying it. Read that section before you decide.",
  },
];

export default function Landing() {
  return (
    <div className="landing">
      <Nav />
      <Hero />
      <Marquee />
      <Problem />
      <ScrollDemo />
      <HowItWorks />
      <Privacy />
      <VideoDemo />
      <Pricing />
      <Faq />
      <Closing />
    </div>
  );
}

function Nav() {
  return (
    <nav className="nav" aria-label="Main">
      <a className="brand" href="#/">
        <Logo />
        <span>BreezeFill</span>
      </a>
      <div className="nav-links">
        <a href="#how">How it works</a>
        <a href="#privacy">Privacy</a>
        <a href="#pricing">Pricing</a>
        <a href="#faq">FAQ</a>
      </div>
      <a className="btn btn-small" href="#/demo">
        See the demo
      </a>
    </nav>
  );
}

function Hero() {
  return (
    <header className="hero">
      <p className="badge">Chrome Web Store listing coming soon</p>
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
        <a className="btn btn-primary btn-large" href={DOWNLOAD_URL} download>
          Download for Chrome
        </a>
        <a className="btn btn-ghost btn-large" href="#/demo">
          Watch it fill a form
        </a>
      </div>
      {/* The three things a doctor most needs to be true, and all three are.
          The design put "Nothing leaves your browser" here, which is false —
          the paste goes to the backend to be scrubbed. What is true, and is
          the stronger claim anyway, is that the MODEL never sees identifiers. */}
      <p className="trustline">
        No sign-in · Identifiers never reach the model · Nothing is stored
      </p>
      <p className="fineprint">
        Not on the Chrome Web Store yet — unzip it and load it from
        <code> chrome://extensions</code>. Takes about a minute.
      </p>
      <HeroShot />
    </header>
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

function Marquee() {
  const facts = [
    "Never submits on your behalf",
    "No patient data stored",
    "Identifiers never sent to the model",
    "Leaves a field blank rather than guess",
  ];
  return (
    <div className="marquee">
      {facts.map((f) => (
        <span key={f}>{f}</span>
      ))}
    </div>
  );
}

function Problem() {
  return (
    <section className="section problem">
      <p className="eyebrow">A new patient, the same form, again</p>
      <h2>Nobody went to medical school to fill forms.</h2>
      <p className="section-lede">
        {/* The design compared this to password managers. That invites the
            comparison you lose — they are free and genuinely local. The thing
            BreezeFill competes with is retyping. */}
        Every claim form asks the same clinical facts you already wrote, in a
        different order, with different wording, on a page that changes without
        warning.
      </p>
      <div className="two-col">
        <div>
          <h3>Today</h3>
          <p>
            The insurer emails a link. You open it beside the clinical record
            and copy across the same facts you already documented — name, NRIC,
            policy number, diagnosis, dates of admission and discharge, the ICD
            code. Fifteen minutes of transcription, per claim, for information
            that is already written down.
          </p>
        </div>
        <div>
          <h3>With BreezeFill</h3>
          <p>
            You paste the consultation once. The panel proposes an answer for
            every question the form asks, shows you the sentence each one came
            from, and writes the ones you accept into the form. What is left is
            what genuinely needs a doctor: reading it, and signing it.
          </p>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="section" id="how">
      <p className="eyebrow">How it works</p>
      <h2>Three steps, and you can stop at any of them.</h2>
      <div className="steps">
        {STEPS.map((step) => (
          <article className="step" key={step.n}>
            <span className="step-n">{step.n}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </article>
        ))}
      </div>
      <a className="btn btn-primary" href="#/demo">
        Watch it happen on a sample claim
      </a>
    </section>
  );
}

function Privacy() {
  return (
    <section className="section privacy" id="privacy">
      <p className="eyebrow">Privacy</p>
      <h2>Designed by asking what must never happen.</h2>
      <p className="section-lede">
        A tool that handles clinical notes has to be judged on its worst case,
        not its best one. These are the four the product is built around.
      </p>
      <div className="guarantees">
        {GUARANTEES.map((g) => (
          <article className="guarantee" key={g.title}>
            <h3>{g.title}</h3>
            <p>{g.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Pricing() {
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
        {subscribeUrl() ? (
          <>
            <a className="btn btn-primary btn-large" href={subscribeUrl()}>
              Subscribe
            </a>
            <p className="price-note">
              Billed monthly, cancel any time. After checkout you are given a
              licence key and the link to install from the Chrome Web Store.
            </p>
          </>
        ) : (
          <p className="price-pending">
            Subscriptions open when the Chrome Web Store listing is approved.
            Until then it is free and installs by hand.
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


/**
 * How far the page has scrolled through a tall section, 0..1.
 *
 * Returns 0 in jsdom and 1 when the visitor has asked for reduced motion — in
 * both cases the section renders its finished state rather than an empty one,
 * so a test and a motion-sensitive reader each see a form that is filled
 * rather than a form that never starts.
 */
function useScrollProgress(ref: React.RefObject<HTMLElement | null>) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setProgress(1);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // The panel is sticky for everything except the last viewport of the
      // section, so that is the distance the animation is spread over.
      const travel = rect.height - window.innerHeight;
      if (travel <= 0) return;
      const scrolled = Math.min(Math.max(-rect.top, 0), travel);
      setProgress(scrolled / travel);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ref]);

  return progress;
}

function ScrollDemo() {
  const ref = useRef<HTMLElement>(null);
  const progress = useScrollProgress(ref);

  const stageIndex = Math.min(
    DEMO_STAGES.length - 1,
    Math.floor(progress * DEMO_STAGES.length),
  );
  const stage = DEMO_STAGES[stageIndex];
  // Rows land one stage at a time, and the last one never fills itself: it is
  // the question the panel asks rather than an answer it wrote.
  const filled = Math.min(DEMO_ROWS.filter((r) => !r.choose).length, stageIndex);

  return (
    <section className="scroll-demo" id="demo" ref={ref} aria-label="How a claim fills">
      <div className="scroll-demo-sticky">
        <div className="scroll-demo-grid">
          <div className="scroll-demo-copy">
            <p className="eyebrow">Watch it fill</p>
            <h2>{stage.title}</h2>
            <p>{stage.body}</p>
            <div className="scroll-demo-bar" aria-hidden="true">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="scroll-demo-count">
              {filled} of {DEMO_ROWS.length} answered · nothing submitted
            </p>
          </div>

          <div className="scroll-demo-form">
            <div className="scroll-demo-form-head">
              <span>Insurer's claim form</span>
              <span className="mono">Step 2 of 4</span>
            </div>
            <ol className="scroll-demo-rows">
              {DEMO_ROWS.map((row, i) => {
                const done = i < filled;
                const asking = Boolean(row.choose) && stageIndex >= DEMO_STAGES.length - 2;
                return (
                  <li key={row.label} className={done ? "is-filled" : asking ? "is-asking" : ""}>
                    <span className="scroll-demo-label">{row.label}</span>
                    <span className="scroll-demo-value">
                      {done ? row.value : asking ? "" : <i aria-hidden="true" />}
                    </span>
                    {(done || asking) && (
                      <span className="scroll-demo-note">
                        {done ? row.note : "2 found in the note — pick the patient's:"}
                      </span>
                    )}
                    {asking && (
                      <span className="scroll-demo-choices">
                        {row.choose!.map((c) => (
                          <span className="choice" key={c}>
                            {c}
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </section>
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

function VideoDemo() {
  return (
    <section className="section video">
      <div className="video-head">
        <div>
          <p className="eyebrow">See it in action</p>
          <h2>The whole flow, start to finish.</h2>
        </div>
        <p>
          A consultation pasted, answers proposed with their sources, the two it
          refuses to guess between, and the fill — recorded from the extension.
        </p>
      </div>
      <div className="video-frame">
        {DEMO_VIDEO ? (
          <video
            controls
            preload="none"
            poster={DEMO_VIDEO_POSTER || undefined}
            src={DEMO_VIDEO}
          />
        ) : (
          <p className="video-placeholder">
            Demo video goes here — put the file in <code>frontend/public/</code>{" "}
            and set <code>DEMO_VIDEO</code> in <code>Landing.tsx</code>.
          </p>
        )}
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section className="section faq" id="faq">
      <p className="eyebrow">Questions</p>
      <h2>The ones worth asking first.</h2>
      <div className="faq-list">
        {FAQS.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
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
      <p>
        Free during the pilot, while it installs by hand. It becomes{" "}
        {PRICE.currency} {PRICE.amount} a {PRICE.period} when it reaches the
        Chrome Web Store — the pilot is not a trial that expires underneath
        you, and you will be asked before anything is charged.
      </p>
      <p>
        Works in Chrome. Uninstalling it leaves nothing behind, because nothing
        was ever saved.
      </p>
      <div className="cta-row">
        <a className="btn btn-primary btn-large" href={DOWNLOAD_URL} download>
          Download for Chrome
        </a>
        <a className="btn btn-ghost btn-large" href="#/demo">
          See the demo first
        </a>
      </div>
    </section>
  );
}

function Closing() {
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

/**
 * The mark itself, generated from the master by scripts/make_logo_assets.py
 * and served from public/. This used to be a hand-drawn SVG of a document
 * with a tick — nothing like the actual logo, which is why it read as missing
 * rather than wrong.
 */
function Logo({ className = "" }: { className?: string }) {
  return (
    <img
      className={`logo ${className}`.trim()}
      src="/website-logo-128.png"
      alt=""
      width={128}
      height={128}
      aria-hidden="true"
    />
  );
}
