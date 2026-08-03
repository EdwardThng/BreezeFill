import { useState } from "react";

/**
 * A walkthrough of one claim, driven by hand.
 *
 * Entirely local: no fetch, no backend, no API key, no model. Every value
 * below is written into this file, so the demo works while the server sleeps
 * and cannot be affected by a model having an off day. What it is showing is
 * the *shape* of the product — what the doctor is asked to do, what they are
 * shown, and what the tool declines to do — which is exactly the part a
 * screenshot cannot convey.
 *
 * Stepped rather than auto-playing on purpose. The interesting moments (a
 * value needing confirmation, a field left deliberately blank) are the ones an
 * animation would carry past before they were read.
 *
 * THE PATIENT IS INVENTED. Same synthetic case as docs/test_notes.md, so a
 * repo fixture and the public demo cannot drift into disagreeing. Never put a
 * real note here — this file is served to the public internet.
 */

const NOTE = `Patient: Chua Beng Huat · S7211043C · 04/11/1972 · 91112233 ·
18 Toa Payoh Lorong 4, Singapore 310018 · Policy GHS-4471902

14/03/2026, 0930h. 53M, previously well, presents with 2-day history of
periumbilical pain migrating to right iliac fossa. Nausea, two episodes
of vomiting.

O/E: T 38.1, HR 96. Marked RIF tenderness with rebound.
Ix: WBC 15.4, CRP 88. CT abdomen 14/03/2026: acute appendicitis.

Admitted Mount Elizabeth Hospital 14/03/2026. Laparoscopic
appendicectomy 15/03/2026. Discharged 17/03/2026.`;

const DEMOGRAPHICS = [
  { label: "Full name", value: "Chua Beng Huat" },
  { label: "NRIC", value: "S7211043C" },
  { label: "Date of birth", value: "04/11/1972" },
  { label: "Phone", value: "91112233" },
  { label: "Policy number", value: "GHS-4471902" },
];

type Status = "extracted" | "inferred" | "missing" | "demographic";

interface Row {
  id: string;
  label: string;
  value: string;
  status: Status;
  source?: string;
}

const ROWS: Row[] = [
  {
    id: "patient_name",
    label: "Patient name",
    value: "Chua Beng Huat",
    status: "demographic",
  },
  {
    id: "diagnosis",
    label: "Diagnosis",
    value: "Acute appendicitis",
    status: "extracted",
    source: "CT abdomen 14/03/2026: acute appendicitis",
  },
  {
    id: "admitted",
    label: "Date of admission",
    value: "14/03/2026",
    status: "extracted",
    source: "Admitted Mount Elizabeth Hospital 14/03/2026",
  },
  {
    id: "operation",
    label: "Operation performed",
    value: "Laparoscopic appendicectomy",
    status: "extracted",
    source: "Laparoscopic appendicectomy 15/03/2026",
  },
  {
    id: "icd",
    label: "ICD-10 code",
    value: "K35.80",
    status: "inferred",
    source: "acute appendicitis",
  },
  {
    id: "referral",
    label: "Referring doctor",
    value: "",
    status: "missing",
  },
];

const STATUS_TEXT: Record<Status, string> = {
  demographic: "From the details you pasted",
  extracted: "Quoted from your note",
  inferred: "Inferred — confirm this",
  missing: "Not in the note — fill by hand",
};

interface Step {
  title: string;
  caption: string;
  /** What the panel is showing at this point. */
  panel: "empty" | "pasted" | "parsed" | "bank" | "review" | "filled";
}

const STEPS: Step[] = [
  {
    title: "Open the panel beside the form",
    caption:
      "The insurer's form is open on the right. ClaimFill has no access to it — or to any page — until you click its icon on that tab. Nothing is running in the background.",
    panel: "empty",
  },
  {
    title: "Paste the consultation",
    caption:
      "One box. Paste the note exactly as it sits in your clinic system, patient header and all. There is nothing to type twice and no seven fields to fill first.",
    panel: "pasted",
  },
  {
    title: "The identifiers are pulled out — without AI",
    caption:
      "Name, NRIC, date of birth, phone and policy number are found by pattern matching, not by a model. That ordering is the whole privacy design: these values are what the note is scrubbed against before any of it is sent, so they have to be known first. You can correct any of them.",
    panel: "parsed",
  },
  {
    title: "Is this form one we already know?",
    caption:
      "The page is scored against every form ClaimFill has a description for. This one matches the AIA Group H&S claim, so the model gets told what each question means. When nothing matches, it reads the questions off the page instead — and afterwards offers you a description of that new form.",
    panel: "bank",
  },
  {
    title: "Check what it proposes",
    caption:
      "Every answer says where it came from. Green is quoted from your note, and the quote is shown. Amber is an inference and cannot be written until you click Confirm. Grey was not in the note and is left for you — the tool would rather leave a blank than invent a referring doctor.",
    panel: "review",
  },
  {
    title: "It fills the form. You submit it.",
    caption:
      "The values you accepted are written into the insurer's own form, in your browser. The referring doctor field is untouched, because nothing in the note answered it. ClaimFill does not press submit — you read it, sign it and send it yourself.",
    panel: "filled",
  },
];

const FORM_FIELDS = [
  { rowId: "patient_name", label: "Name of patient" },
  { rowId: "diagnosis", label: "Diagnosis" },
  { rowId: "admitted", label: "Date of admission" },
  { rowId: "operation", label: "Operation performed" },
  { rowId: "icd", label: "ICD-10 code" },
  { rowId: "referral", label: "Referring doctor" },
];

export default function Demo() {
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const current = STEPS[step];

  const go = (next: number) => {
    setStep(Math.max(0, Math.min(STEPS.length - 1, next)));
  };

  const restart = () => {
    setStep(0);
    setConfirmed(false);
  };

  // Reaching the fill step without confirming would show the amber value
  // landing in the form, which is precisely what the product does not do.
  const canAdvance = !(current.panel === "review" && !confirmed);

  return (
    <div className="demo">
      <DemoNav />

      <div className="demo-banner" role="note">
        <strong>Sample data.</strong> Chua Beng Huat does not exist — this
        patient, NRIC and note are invented for the demo. Nothing here contacts
        a server.
      </div>

      <div className="demo-stage">
        <section className="demo-panel" aria-label="ClaimFill side panel">
          <div className="demo-panel-head">
            <span className="dot-live" />
            ClaimFill
          </div>

          <Panel step={current} confirmed={confirmed} onConfirm={() => setConfirmed(true)} />
        </section>

        <section className="demo-browser" aria-label="The insurer's form">
          <div className="demo-browser-head">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span className="url">claims.aia.com.sg/attending-physician</span>
          </div>
          <div className="demo-form">
            <h3>Attending physician's statement</h3>
            {FORM_FIELDS.map((field) => {
              const row = ROWS.find((r) => r.id === field.rowId)!;
              const written =
                current.panel === "filled" && row.status !== "missing";
              return (
                <label className="demo-field" key={field.rowId}>
                  <span>{field.label}</span>
                  <output className={written ? "written" : ""}>
                    {written ? row.value : ""}
                  </output>
                </label>
              );
            })}
            <button className="demo-submit" type="button" disabled>
              Submit claim — you do this, not ClaimFill
            </button>
          </div>
        </section>
      </div>

      <div className="demo-controls">
        <div className="demo-caption">
          <p className="demo-step-count">
            Step {step + 1} of {STEPS.length}
          </p>
          <h2>{current.title}</h2>
          <p>{current.caption}</p>
          {!canAdvance && (
            <p className="demo-nudge">
              Confirm the amber value in the panel to continue — that click is
              required in the real product too.
            </p>
          )}
        </div>
        <div className="demo-buttons">
          <button
            className="btn btn-ghost"
            onClick={() => go(step - 1)}
            disabled={step === 0}
          >
            Back
          </button>
          {step === STEPS.length - 1 ? (
            <button className="btn btn-ghost" onClick={restart}>
              Start again
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => go(step + 1)}
              disabled={!canAdvance}
            >
              Next
            </button>
          )}
        </div>
      </div>

      <div className="demo-outro">
        <a className="btn btn-primary btn-large" href="/download/claimfill-extension.zip" download>
          Download for Chrome
        </a>
        <a className="btn btn-ghost btn-large" href="#/">
          Back to the start
        </a>
      </div>
    </div>
  );
}

function DemoNav() {
  return (
    <nav className="nav" aria-label="Main">
      <a className="brand" href="#/">
        <span>← ClaimFill</span>
      </a>
      <div className="nav-links">
        <span>Interactive demo</span>
      </div>
    </nav>
  );
}

function Panel({
  step,
  confirmed,
  onConfirm,
}: {
  step: Step;
  confirmed: boolean;
  onConfirm: () => void;
}) {
  const shown = step.panel;

  if (shown === "empty") {
    return (
      <div className="demo-empty">
        <p>Click the ClaimFill icon on this tab to begin.</p>
        <p className="demo-hint">
          That click is the only access it ever gets, and it lasts for this page
          only.
        </p>
      </div>
    );
  }

  return (
    <>
      <label className="demo-paste-label">
        Paste the consultation
        <textarea className="demo-paste" readOnly value={NOTE} rows={9} />
      </label>

      {(shown === "parsed" || shown === "bank" || shown === "review" || shown === "filled") && (
        <div className="demo-found">
          <p className="demo-found-head">Patient details — 5 of 7 found</p>
          {DEMOGRAPHICS.map((d) => (
            <div className="demo-found-row" key={d.label}>
              <span>{d.label}</span>
              <strong>{d.value}</strong>
            </div>
          ))}
          <p className="demo-hint">Found by pattern, never sent to the model.</p>
        </div>
      )}

      {(shown === "bank" || shown === "review" || shown === "filled") && (
        <div className="demo-bank">
          <p className="demo-bank-hit">✓ AIA — Group Hospital &amp; Surgical claim</p>
          <p className="demo-hint">
            Matched 6 of 6 questions on this page.
          </p>
        </div>
      )}

      {(shown === "review" || shown === "filled") && (
        <div className="demo-rows">
          {ROWS.map((row) => {
            const needsClick = row.status === "inferred" && !confirmed;
            return (
              <div className={"demo-row " + row.status} key={row.id}>
                <span className={"pill " + pillClass(row.status)}>
                  {STATUS_TEXT[row.status]}
                </span>
                <p className="demo-row-label">{row.label}</p>
                <p className="demo-row-value">
                  {row.value || <em>left for you</em>}
                </p>
                {row.source && (
                  <p className="demo-row-source">“{row.source}”</p>
                )}
                {needsClick && (
                  <button className="demo-confirm" onClick={onConfirm}>
                    Confirm
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function pillClass(status: Status): string {
  if (status === "extracted" || status === "demographic") return "green";
  if (status === "inferred") return "amber";
  return "grey";
}
