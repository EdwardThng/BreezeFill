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

const STEPS = [
  {
    n: "01",
    title: "Paste the consultation",
    body: "One box, in a side panel next to the insurer's form. Paste the note exactly as it sits in your CMS — patient details and all. Nothing is typed twice.",
  },
  {
    n: "02",
    title: "Check what it proposes",
    body: "Every value arrives with where it came from: quoted from the note, inferred, or not found. Anything not quoted directly needs your explicit click before it can be written.",
  },
  {
    n: "03",
    title: "It fills the form in place",
    body: "Values land in the insurer's own form, in your browser. You read it, sign it and submit it yourself — BreezeFill never presses submit.",
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
    a: "Today the model runs outside Singapore, so use synthetic or anonymised notes until in-region inference is in place. This is stated plainly rather than buried — it is the reason the pilot is not live on real notes yet.",
  },
];

export default function Landing() {
  return (
    <div className="landing">
      <Nav />
      <Hero />
      <Marquee />
      <Problem />
      <HowItWorks />
      <Privacy />
      <Coverage />
      <Faq />
      <FinalCta />
      <Footer />
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
      <p className="eyebrow">For Singapore GPs</p>
      <h1>
        Insurance forms, filled from
        <br />
        the notes you already wrote.
      </h1>
      <p className="lede">
        BreezeFill sits beside the insurer's form in your browser. Paste the
        consultation once and it proposes each answer with its source, for you
        to check and sign. It fills. You submit.
      </p>
      <div className="cta-row">
        <a className="btn btn-primary btn-large" href={DOWNLOAD_URL} download>
          Download for Chrome
        </a>
        <a className="btn btn-ghost btn-large" href="#/demo">
          See it work →
        </a>
      </div>
      <p className="fineprint">
        Not on the Chrome Web Store yet — unzip it and load it from
        <code> chrome://extensions</code>. Takes about a minute.
      </p>
      <HeroVisual />
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
      <h2>The form is not the hard part. Retyping is.</h2>
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

function Coverage() {
  return (
    <section className="section coverage">
      <div className="two-col">
        <div>
          <p className="eyebrow">Forms</p>
          <h2>Knows the common ones. Handles the rest.</h2>
          <p>
            AIA and Great Eastern group hospital &amp; surgical claims are
            described in detail, so the model is told what each question means
            rather than guessing from its wording.
          </p>
          <p>
            Meet a form it does not know and it reads the questions off the page
            instead, then hands back a description of that form for review — so
            the tool gets better at your insurers, not at insurers in general.
          </p>
        </div>
        <div className="coverage-card">
          <h3>Also fills PDFs</h3>
          <p>
            Not every insurer sends a link. Five printed forms — including the
            scanned ones with no fillable fields — are filled and returned as a
            PDF ready to print and sign.
          </p>
          <a className="btn btn-ghost" href="#/app">
            Open the PDF form filler
          </a>
        </div>
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
      <h2>Put it beside your next claim form.</h2>
      <p>
        Free while in pilot. Works in Chrome. Uninstalling it leaves nothing
        behind, because nothing was ever saved.
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

function Footer() {
  return (
    <footer className="footer">
      <div className="brand">
        <Logo />
        <span>BreezeFill</span>
      </div>
      <p>
        Assists with form completion. The reviewing doctor remains responsible
        for the accuracy of every submitted form.
      </p>
      {/* A real path, not a #/ route: the policy is served as static HTML so
          that it reads even if this bundle does not. The file is
          public/privacy.html; `cleanUrls` in vercel.json drops the extension,
          which is why this links to /privacy and why that is the URL given to
          the Chrome Web Store. */}
      <p>
        <a href="/privacy">Privacy policy</a>
      </p>
    </footer>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="2" width="18" height="20" rx="3" className="logo-page" />
      <path d="M7.5 9.5h9M7.5 13h9M7.5 16.5h5" className="logo-lines" />
      <path d="M14.5 17.5l2.5 2.5 4.5-5.5" className="logo-tick" />
    </svg>
  );
}
