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

export default function HowItWorks() {
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
