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

export default function Faq() {
  return (
    <section className="section faq" id="faq">
      <div className="faq-grid">
        <div className="faq-intro">
          <p className="eyebrow">Questions</p>
          {/* No manual break: the column is narrow and a hard break left a
              single short word stranded on its own line. */}
          <h2>The ones worth asking first.</h2>
          <span className="faq-ornament" aria-hidden="true" />
        </div>
        <div className="faq-list">
          {FAQS.map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
