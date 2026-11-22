import { useEffect, useRef, useState } from "react";

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

export default function ScrollDemo() {
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
