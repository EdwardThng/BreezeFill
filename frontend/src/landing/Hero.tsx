import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GET_ROUTE, HERO_SHOT } from "./config";
import WindMark from "./WindMark";

/*
 * Three things were removed from this header on 2026-08-17, all on the owner's
 * call, and two of them had become untrue:
 *
 * - A badge reading "Now on the Chrome Web Store". The published build does
 *   not run against production and `#/get` hands out a zip instead.
 * - A fineprint line, "One click from the Chrome Web Store." Same problem.
 * - A trust line reading "No sign-in · Identifiers never reach the model ·
 *   Nothing is stored". Pass 3 of redaction IS a Claude call, so the
 *   defensible claim is narrower — the model *answering the form* is not shown
 *   identifiers — and it is made properly in the privacy section.
 *
 * Do not restore any of them from a design file.
 */
export default function Hero() {
  return (
    <header className="hero">
      <WindMark className="hero-mark" />
      <div className="hero-copy">
        <h1>
          You already wrote this. <span className="hero-once">Once.</span>
        </h1>
        <div className="hero-sub">
          <p className="hero-lede">
            Paste the consultation into a panel beside the insurer's form.
            BreezeFill reads the questions on that form, proposes an answer to
            each one with the line from your note that supports it, and writes
            in only what you confirm. It never submits.
          </p>
          <div className="cta-row">
            <a className="act act-navy" href={GET_ROUTE}>
              Get BreezeFill
              <Arrow />
            </a>
            <a className="act act-quiet" href="#/demo">
              Watch it fill a form
            </a>
          </div>
        </div>
      </div>
      <HeroShot />
    </header>
  );
}

export function Arrow() {
  return (
    <span className="act-arrow" aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path
          d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** A real screenshot once HERO_SHOT is set; until then, the working sample. */
function HeroShot() {
  if (HERO_SHOT) {
    return (
      <div className="shot-frame">
        <img
          className="shot-img"
          src={HERO_SHOT}
          alt="The BreezeFill panel beside an insurer's claim form"
        />
      </div>
    );
  }
  return (
    <div className="shot-frame is-mock">
      <SampleClaim />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sample claim
// ---------------------------------------------------------------------------
//
// One synthetic patient, the same one the walkthrough further down fills, so
// the page tells one story. Every identifier here is invented.
//
// The four statuses are the product's own: quoted from the note, inferred
// (which needs a click), not found (left blank), and two candidates (handed
// back to the doctor). Proposals render dashed and only go solid when the
// visitor confirms them, because nothing is written until a click.

type Status = "quoted" | "inferred" | "missing" | "choose";

interface Field {
  id: string;
  label: string;
  value: string;
  status: Status;
  sources: string[];
  note: string;
  choices?: string[];
}

const FIELDS: Field[] = [
  {
    id: "tel",
    label: "Contact number",
    value: "",
    status: "choose",
    sources: ["hp", "tel"],
    note: "Two in the note — pick the patient's",
    choices: ["9123 4567", "6123 4567"],
  },
  {
    id: "dx",
    label: "Diagnosis",
    value: "Acute tonsillitis",
    status: "quoted",
    sources: ["imp"],
    note: "Quoted from your note",
  },
  {
    id: "icd",
    label: "ICD-10 code",
    value: "J03.9",
    status: "inferred",
    sources: ["imp"],
    note: "Inferred — needs your click",
  },
  {
    id: "adm",
    label: "Date of admission",
    value: "02/08/2026",
    status: "quoted",
    sources: ["adm"],
    note: "Quoted from your note",
  },
  {
    id: "dis",
    label: "Date of discharge",
    value: "",
    status: "missing",
    sources: [],
    note: "Not in your note — left blank",
  },
];

type Phase = "idle" | "proposing" | "review";

interface Stroke {
  key: string;
  d: string;
  field: string;
  order: number;
  inferred: boolean;
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function SampleClaim() {
  const root = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [run, setRun] = useState(0);
  const [lit, setLit] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [chosen, setChosen] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);

  // Start once the sample is on screen. Where that cannot be observed (jsdom,
  // old browsers) or motion is unwelcome, show the finished proposal at once:
  // a reader should never be left looking at an empty form.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setPhase("review");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setPhase("proposing");
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [run]);

  useEffect(() => {
    if (phase !== "proposing") return;
    const t = window.setTimeout(() => setPhase("review"), 2600);
    return () => window.clearTimeout(t);
  }, [phase]);

  const measure = useCallback(() => {
    const box = root.current;
    if (!box) return;
    const note = box.querySelector<HTMLElement>(".sc-note");
    if (!note) return;
    const b = box.getBoundingClientRect();
    const n = note.getBoundingClientRect();
    // Stacked layout (phones): the strokes would have to cross the note
    // itself, so the highlight carries the link there instead.
    if (b.width < 760 || n.width === 0) {
      setStrokes([]);
      return;
    }
    const next: Stroke[] = [];
    FIELDS.forEach((field, order) => {
      const target = box.querySelector<HTMLElement>(`[data-field="${field.id}"]`);
      if (!target) return;
      const f = target.getBoundingClientRect();
      field.sources.forEach((src) => {
        const span = box.querySelector<HTMLElement>(`[data-src="${src}"]`);
        if (!span) return;
        const s = span.getBoundingClientRect();
        const sx = n.right - b.left + 2;
        const sy = s.top + s.height / 2 - b.top;
        const ex = f.left - b.left - 26;
        const ey = f.top + 22 - b.top;
        const gap = ex - sx;
        const d =
          `M${sx} ${sy} C${sx + gap * 0.45} ${sy} ${ex - gap * 0.55} ${ey} ${ex - 24} ${ey} ` +
          `H${ex} A8 8 0 1 0 ${ex - 7.5} ${ey - 5.3}`;
        next.push({
          key: `${field.id}-${src}`,
          d,
          field: field.id,
          order,
          inferred: field.status === "inferred",
        });
      });
    });
    setStrokes(next);
  }, []);

  useLayoutEffect(() => {
    measure();
    const box = root.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(box);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, [measure]);

  const replay = () => {
    setConfirmed({});
    setChosen(null);
    setLit(null);
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setPhase("review");
      return;
    }
    setPhase("idle");
    setRun((r) => r + 1);
  };

  const litSources = new Set(lit ? FIELDS.find((f) => f.id === lit)?.sources ?? [] : []);
  const answerable = FIELDS.filter((f) => f.status !== "missing").length;
  const done =
    FIELDS.filter((f) => (f.status === "quoted" || f.status === "inferred") && confirmed[f.id])
      .length + (chosen ? 1 : 0);

  return (
    <div
      ref={root}
      className="mock sc"
      data-phase={phase}
      aria-label="A sample claim, filled from a synthetic consultation note"
      role="group"
    >
      <figure className="sc-note">
        <figcaption>
          <span>Your consultation note</span>
          <span className="sc-synthetic">Synthetic patient</span>
        </figcaption>
        <pre>
          <span className="sc-line">Tan Wei Ling · S8012345D · 14/03/1978</span>
          <span className="sc-line">
            <Src id="hp" lit={litSources}>HP 9123 4567</Src> ·{" "}
            <Src id="tel" lit={litSources}>Tel 6123 4567</Src>
          </span>
          <span className="sc-line sc-gap">3/7 sore throat, fever 38.6°C,</span>
          <span className="sc-line">odynophagia. O/E tonsils enlarged,</span>
          <span className="sc-line">bilateral exudate.</span>
          <span className="sc-line sc-gap">
            <Src id="imp" lit={litSources}>Imp: acute tonsillitis.</Src>
          </span>
          <span className="sc-line">
            <Src id="adm" lit={litSources}>Adm 02/08/2026</Src> for IV antibiotics.
          </span>
        </pre>
      </figure>

      <svg className="sc-strokes" aria-hidden="true" focusable="false">
        {strokes.map((s) => (
          <path
            key={`${s.key}-${run}`}
            d={s.d}
            pathLength={1}
            className={
              "sc-stroke" +
              (s.inferred ? " is-inferred" : "") +
              (lit === s.field ? " is-lit" : "") +
              (lit && lit !== s.field ? " is-dim" : "")
            }
            style={{ ["--i" as string]: s.order }}
          />
        ))}
      </svg>

      <div className="sc-form">
        <div className="sc-form-head">
          <span className="url">insurer.com.sg/claim</span>
          <span className="sc-form-title">Inpatient claim · Part B</span>
        </div>
        <ol className="sc-fields">
          {FIELDS.map((field, i) => (
            <li
              key={field.id}
              data-field={field.id}
              data-status={field.status}
              className={
                (confirmed[field.id] || (field.status === "choose" && chosen) ? "is-set " : "") +
                (lit === field.id ? "is-lit" : "")
              }
              style={{ ["--i" as string]: i }}
              onMouseEnter={() => setLit(field.id)}
              onMouseLeave={() => setLit(null)}
              onFocus={() => setLit(field.id)}
              onBlur={() => setLit(null)}
            >
              <span className="sc-label">{field.label}</span>
              <FieldValue
                field={field}
                isSet={Boolean(confirmed[field.id])}
                chosen={chosen}
                onConfirm={() =>
                  setConfirmed((c) => ({ ...c, [field.id]: !c[field.id] }))
                }
                onChoose={(v) => setChosen((c) => (c === v ? null : v))}
              />
              <span className="sc-status">{field.note}</span>
            </li>
          ))}
        </ol>
        <div className="sc-foot">
          <span className="sc-count" aria-live="polite">
            {done} of {answerable} confirmed · nothing submitted
          </span>
          <button type="button" className="sc-replay" onClick={replay}>
            Replay
          </button>
        </div>
      </div>
    </div>
  );
}

function Src({
  id,
  lit,
  children,
}: {
  id: string;
  lit: Set<string>;
  children: React.ReactNode;
}) {
  return (
    <span data-src={id} className={"sc-src" + (lit.has(id) ? " is-lit" : "")}>
      {children}
    </span>
  );
}

function FieldValue({
  field,
  isSet,
  chosen,
  onConfirm,
  onChoose,
}: {
  field: Field;
  isSet: boolean;
  chosen: string | null;
  onConfirm: () => void;
  onChoose: (v: string) => void;
}) {
  if (field.status === "missing") {
    return <span className="sc-value is-blank" aria-label="Left blank" />;
  }
  if (field.status === "choose") {
    return (
      <span className="sc-value sc-choices">
        {field.choices!.map((c) => (
          <button
            type="button"
            key={c}
            className={"sc-choice" + (chosen === c ? " is-chosen" : "")}
            aria-pressed={chosen === c}
            onClick={onChoose.bind(null, c)}
          >
            {c}
          </button>
        ))}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={"sc-value sc-proposal" + (isSet ? " is-set" : "")}
      aria-pressed={isSet}
      onClick={onConfirm}
      title={isSet ? "Confirmed — click to undo" : "Click to confirm"}
    >
      <span>{field.value}</span>
      <span className="sc-tick" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false">
          <path
            d="M3.5 8.5 6.5 11.5 12.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}
