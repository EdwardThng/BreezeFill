// Step 1 is the form, the notes AND the patient since the picker went — the
// label names the first thing asked for rather than trying to list all three.
const STEPS = ["Form & notes", "Check the answers", "Download"];

/** Three numbered steps so a first-time user can see where they are and what
 *  is still coming. */
export default function Stepper({ current }: { current: number }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {STEPS.map((title, i) => {
        const n = i + 1;
        const state = n === current ? "on" : n < current ? "past" : "future";
        return (
          <li key={title} className={`step step-${state}`}>
            <span className="step-num">{state === "past" ? "✓" : n}</span>
            <span className="step-title">{title}</span>
          </li>
        );
      })}
    </ol>
  );
}
