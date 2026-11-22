import { useState } from "react";

/**
 * The four guarantees, as panels that open one at a time.
 *
 * The first title says "the model that answers the form", not "the model".
 * Pass 3 of redaction is itself a Claude call on the scrubbed text, so the
 * unqualified version is the claim CLAUDE.md's hard rules forbid; the body
 * says so in plain words rather than leaving it to the privacy policy.
 */
const GUARANTEES = [
  {
    title: "Names never reach the model that answers the form",
    body: "Your patient's name, NRIC, phone and address are pulled out by pattern matching — no AI involved — and are used to scrub the note before any of it is sent. The model that answers the form only ever sees text with [PATIENT] and [NRIC] where the identifiers were. One check runs before it: a separate AI pass reads the scrubbed text for anything the patterns missed.",
    art: "redact",
  },
  {
    // NOT "Nothing is stored. There is no database." — that was the copy until
    // 2026-10-10 and it was already false: the extension saves a licence key,
    // and blank insurer forms are kept so the same form is not read twice. The
    // promise worth making is the patient one. privacy.html carries the same
    // correction and the two have to agree for the store listing.
    title: "Your patient's data is never kept",
    body: "No patient record, no claim record, no copy of your note. The claim lives in the panel while it is open and is gone when you close it — there is nothing to export and nothing to delete, because nothing about a patient was stored.",
    art: "gone",
  },
  {
    title: "Blanks over guesses",
    body: "A field left empty costs you a few seconds of typing. A field filled wrongly gets signed and submitted as your clinical statement. So it declines: ambiguous questions are left for you, and a page it does not recognise is not touched at all.",
    art: "blank",
  },
  {
    title: "It cannot read your other tabs",
    body: "No standing access to any site. It sees one page, once, because you clicked the BreezeFill icon on it. The only thing it saves on your computer is your licence key, so you are not retyping it between patients.",
    art: "tabs",
  },
];

export default function Privacy() {
  const [open, setOpen] = useState(0);

  return (
    <section className="section privacy" id="privacy" aria-labelledby="privacy-title">
      <div className="privacy-head">
        <h2 id="privacy-title">Designed by asking what must never happen.</h2>
        <p className="section-lede">
          A tool that handles clinical notes has to be judged on its worst case,
          not its best one. These are the four the product is built around.
        </p>
      </div>
      <div className="guarantees">
        {GUARANTEES.map((g, i) => {
          const isOpen = open === i;
          return (
            <article
              className={"guarantee" + (isOpen ? " is-open" : "")}
              key={g.title}
              onMouseEnter={() => setOpen(i)}
            >
              <h3>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`guarantee-${i}`}
                  onClick={() => setOpen(i)}
                  onFocus={() => setOpen(i)}
                >
                  {g.title}
                </button>
              </h3>
              <div className="guarantee-body" id={`guarantee-${i}`}>
                <p>{g.body}</p>
                {g.art === "redact" && <RedactToggle />}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** The same synthetic line, before and after the scrub. */
function RedactToggle() {
  const [scrubbed, setScrubbed] = useState(true);
  return (
    <div className="redact">
      <div className="redact-line" aria-live="polite">
        {scrubbed ? (
          <>
            <mark>[PATIENT]</mark> · <mark>[NRIC]</mark> · <mark>[PHONE]</mark>
            <br />
            Imp: acute tonsillitis. Adm 02/08/2026.
          </>
        ) : (
          <>
            Tan Wei Ling · S8012345D · 9123 4567
            <br />
            Imp: acute tonsillitis. Adm 02/08/2026.
          </>
        )}
      </div>
      <button
        type="button"
        className="redact-switch"
        aria-pressed={scrubbed}
        onClick={() => setScrubbed((s) => !s)}
      >
        {scrubbed ? "Show what you pasted" : "Show what the model sees"}
      </button>
    </div>
  );
}
