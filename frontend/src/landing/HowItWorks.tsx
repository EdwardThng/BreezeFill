import { Arrow } from "./Hero";

/**
 * The three steps, as cards that stack as the page scrolls.
 *
 * Each card pairs the step's copy with a small picture of that step built from
 * markup, using the same synthetic patient as the hero. Markup rather than
 * screenshots, so the pictures cannot drift from what the panel really does
 * without someone editing the words beside them.
 */
const STEPS = [
  {
    title: "Read the form in front of you",
    body: "Every question on the insurer's page becomes something to answer — matched by the wording of the question, not by the page's code, so a redesign usually changes nothing. Where BreezeFill knows the form, it uses the instruction a colleague would give instead of the question as the page happens to word it.",
    tone: "paper",
    art: <ReadArt />,
  },
  {
    title: "Propose one answer, with its source",
    body: "Each value arrives quoted from your note, marked as inferred, or left as not found. Where the note says two things — two phone numbers, two policy numbers — it fills neither and asks which one is the patient's.",
    tone: "sky",
    art: <ProposeArt />,
  },
  {
    title: "Nothing is written until you confirm",
    body: "Anything not quoted directly from your note needs an explicit click. Then the values go into the insurer's own form and stop: it never overwrites an answer you already gave, never presses a button, and never submits.",
    tone: "mist",
    art: <ConfirmArt />,
  },
];

export default function HowItWorks() {
  return (
    <section className="section how" id="how" aria-labelledby="how-title">
      <div className="how-head">
        <h2 id="how-title">Three steps, and you can stop at any of them.</h2>
        <a className="btn btn-sky" href="#/demo">
          Watch it happen on a sample claim
          <Arrow />
        </a>
      </div>
      <div className="stack">
        {STEPS.map((step, i) => (
          <article
            className={`stack-card is-${step.tone}`}
            key={step.title}
            style={{ ["--i" as string]: i }}
          >
            <div className="stack-copy">
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
            <div className="stack-art" aria-hidden="true">
              {step.art}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ReadArt() {
  const rows = [
    ["Adm. date (dd/mm/yyyy)*", "When was the patient admitted?"],
    ["Dx / Impression", "What is the diagnosis?"],
    ["Contact no. of insured", "The patient's own phone number"],
  ];
  return (
    <div className="art-read">
      {rows.map(([page, meant]) => (
        <div className="art-read-row" key={page}>
          <span className="art-read-page">{page}</span>
          <svg className="art-read-wind" viewBox="0 0 64 20" focusable="false">
            <path d="M2 14 H46 A6 6 0 1 0 40 9" />
          </svg>
          <span className="art-read-meant">{meant}</span>
        </div>
      ))}
    </div>
  );
}

function ProposeArt() {
  return (
    <div className="art-propose">
      <div className="art-quote">
        <span className="art-quote-src">Imp: acute tonsillitis.</span>
        <span className="art-quote-from">from your note</span>
      </div>
      <svg className="art-propose-wind" viewBox="0 0 120 60" focusable="false">
        <path d="M10 6 C10 34 70 38 96 38 H104 A8 8 0 1 0 96.5 32.7" />
      </svg>
      <div className="art-answers">
        <span className="art-answer is-quoted">
          <b>Acute tonsillitis</b>
          <i>Quoted</i>
        </span>
        <span className="art-answer is-inferred">
          <b>J03.9</b>
          <i>Inferred</i>
        </span>
        <span className="art-answer is-missing">
          <b>—</b>
          <i>Not found</i>
        </span>
      </div>
    </div>
  );
}

function ConfirmArt() {
  return (
    <div className="art-confirm">
      <span className="art-confirm-btn">
        Write 4 confirmed answers
      </span>
      <ul className="art-never">
        <li>Never overwrites an answer you gave</li>
        <li>Never presses a page button</li>
        <li>Never submits</li>
      </ul>
      <span className="art-submit">
        <span>Submit claim</span>
        <em>yours to press</em>
      </span>
    </div>
  );
}
