const GUARANTEES = [
  {
    title: "Names never reach the model",
    body: "Your patient's name, NRIC, phone and address are pulled out by pattern matching — no AI involved — and are used to scrub the note before any of it is sent. The model only ever sees text with [PATIENT] and [NRIC] where the identifiers were.",
  },
  {
    // NOT "Nothing is stored. There is no database." — that was the copy until
    // 2026-10-10 and it was already false: the extension saves a licence key,
    // and blank insurer forms are kept so the same form is not read twice. The
    // promise worth making is the patient one, which survives a doctor having
    // an account. Do not restore the absolute version; privacy.html carries the
    // same correction and the two have to agree for the store listing.
    title: "Your patient's data is never kept",
    body: "No patient record, no claim record, no copy of your note. The claim lives in the panel while it is open and is gone when you close it — there is nothing to export and nothing to delete, because nothing about a patient was stored.",
  },
  {
    title: "Blanks over guesses",
    body: "A field left empty costs you a few seconds of typing. A field filled wrongly gets signed and submitted as your clinical statement. So it declines: ambiguous questions are left for you, and a page it does not recognise is not touched at all.",
  },
  {
    title: "It cannot read your other tabs",
    body: "No standing access to any site. It sees one page, once, because you clicked the BreezeFill icon on it. The only thing it saves on your computer is your licence key, so you are not retyping it between patients.",
  },
];

export default function Privacy() {
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
