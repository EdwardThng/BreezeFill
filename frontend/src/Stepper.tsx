const STEPS = ["Patient & notes", "Check the answers", "Download"];

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
