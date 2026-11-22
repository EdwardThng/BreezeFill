export default function Problem() {
  return (
    <section className="section problem" aria-labelledby="problem-title">
      <div className="problem-head">
        <h2 id="problem-title">Nobody went to medical school to fill forms.</h2>
        <p className="section-lede">
          {/* The design compared this to password managers. That invites the
              comparison you lose — they are free and genuinely local. The
              thing BreezeFill competes with is retyping. */}
          Every claim form asks the same clinical facts you already wrote, in a
          different order, with different wording, on a page that changes
          without warning.
        </p>
      </div>
      <div className="problem-pair">
        <article className="problem-card is-today">
          <h3>Today</h3>
          <p>
            The insurer emails a link. You open it beside the clinical record
            and copy across the same facts you already documented — name, NRIC,
            policy number, diagnosis, dates of admission and discharge, the ICD
            code. Fifteen minutes of transcription, per claim, for information
            that is already written down.
          </p>
        </article>
        <article className="problem-card is-with">
          <h3>With BreezeFill</h3>
          <p>
            You paste the consultation once. The panel proposes an answer for
            every question the form asks, shows you the sentence each one came
            from, and writes the ones you accept into the form. What is left is
            what genuinely needs a doctor: reading it, and signing it.
          </p>
        </article>
      </div>
    </section>
  );
}
