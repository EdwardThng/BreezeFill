import { useState } from "react";
import type { FormInfo, PatientInput } from "./types";

interface Props {
  forms: FormInfo[];
  onSubmit: (formId: string, patient: PatientInput) => void;
}

type Draft = Omit<PatientInput, "insurer">;

const EMPTY: Draft = {
  full_name: "",
  nric: "",
  dob: "",
  phone: "",
  address: "",
  policy_number: "",
  clinical_text: "",
};

export default function PatientForm({ forms, onSubmit }: Props) {
  const [formId, setFormId] = useState(forms[0]?.form_id ?? "");
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const set = (key: keyof Draft) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ ...draft, [key]: e.target.value });

  const selected = forms.find((f) => f.form_id === formId);

  // Spell out what is still missing rather than just greying the button out —
  // a disabled button with no explanation is the classic first-use dead end.
  const missing: string[] = [];
  if (!selected) missing.push("an insurance form");
  if (draft.full_name.trim() === "") missing.push("patient name");
  if (draft.nric.trim() === "") missing.push("NRIC / FIN");
  if (draft.dob === "") missing.push("date of birth");
  if (draft.clinical_text.trim() === "") missing.push("clinical notes");
  const ready = missing.length === 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !selected) return;
    onSubmit(formId, {
      ...draft,
      insurer: selected.insurer,
      phone: draft.phone?.trim() || null,
      address: draft.address?.trim() || null,
      policy_number: draft.policy_number?.trim() || null,
    });
  };

  return (
    <form onSubmit={submit}>
      <section className="card">
        <h2>1. Which form are you filling in?</h2>
        <div className="form-choices">
          {forms.map((f) => (
            <label
              key={f.form_id}
              className={`choice ${f.form_id === formId ? "choice-on" : ""}`}
            >
              <input
                type="radio"
                name="form"
                value={f.form_id}
                checked={f.form_id === formId}
                onChange={() => setFormId(f.form_id)}
              />
              <span>
                <strong>{f.insurer}</strong>
                <span className="choice-sub">{f.display_name}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>2. Patient details</h2>
        <p className="hint">
          These are copied onto the form exactly as you type them. They are also
          used to strip names and identifiers out of the notes — they are never
          sent to the AI.
        </p>

        <div className="grid2">
          <label>
            Patient name <Req />
            <input
              value={draft.full_name}
              onChange={set("full_name")}
              autoComplete="off"
              placeholder="As it appears on the policy"
            />
          </label>
          <label>
            NRIC / FIN <Req />
            <input
              value={draft.nric}
              onChange={set("nric")}
              autoComplete="off"
              placeholder="S1234567D"
            />
          </label>
          <label>
            Date of birth <Req />
            <input type="date" value={draft.dob} onChange={set("dob")} />
          </label>
          <label>
            Policy number <Opt />
            <input
              value={draft.policy_number ?? ""}
              onChange={set("policy_number")}
              autoComplete="off"
            />
          </label>
          <label>
            Phone <Opt />
            <input value={draft.phone ?? ""} onChange={set("phone")} autoComplete="off" />
          </label>
          <label>
            Address <Opt />
            <input
              value={draft.address ?? ""}
              onChange={set("address")}
              autoComplete="off"
            />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>3. Clinical notes</h2>
        <p className="hint">
          Copy the consultation notes straight from your clinic system and paste
          them below — untidy is fine. Include the diagnosis, dates, treatment
          and any operation details, and the answers will be more complete.
        </p>
        <label className="sr-label">
          Clinical notes <Req />
          <textarea
            rows={12}
            value={draft.clinical_text}
            onChange={set("clinical_text")}
            placeholder={"Paste the patient's notes here…"}
          />
        </label>
      </section>

      <div className="submit-bar">
        <button type="submit" disabled={!ready}>
          Read the notes and fill the form
        </button>
        {!ready && (
          <p className="hint">Still needed: {missing.join(", ")}.</p>
        )}
      </div>
    </form>
  );
}

const Req = () => <span className="req">required</span>;
const Opt = () => <span className="opt">optional</span>;
