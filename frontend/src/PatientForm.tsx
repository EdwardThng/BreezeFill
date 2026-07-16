import { useState } from "react";
import type { FormInfo, PatientInput } from "./types";

interface Props {
  forms: FormInfo[];
  busy: boolean;
  onSubmit: (formId: string, patient: PatientInput) => void;
}

const EMPTY: PatientInput = {
  full_name: "",
  nric: "",
  dob: "",
  phone: "",
  address: "",
  policy_number: "",
  insurer: "",
  clinical_text: "",
};

export default function PatientForm({ forms, busy, onSubmit }: Props) {
  const [formId, setFormId] = useState(forms[0]?.form_id ?? "");
  const [patient, setPatient] = useState<PatientInput>(EMPTY);

  const set = (key: keyof PatientInput) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setPatient({ ...patient, [key]: e.target.value });

  const canSubmit =
    !busy &&
    formId !== "" &&
    patient.full_name.trim() !== "" &&
    patient.nric.trim() !== "" &&
    patient.dob !== "" &&
    patient.insurer.trim() !== "" &&
    patient.clinical_text.trim() !== "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(formId, {
      ...patient,
      phone: patient.phone?.trim() || null,
      address: patient.address?.trim() || null,
      policy_number: patient.policy_number?.trim() || null,
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>New claim</h2>
      <p className="hint">
        Demographics are copied onto the form directly and used to strip
        identifiers from the notes — they are never sent to the AI model.
      </p>

      <label>
        Insurance form
        <select value={formId} onChange={(e) => setFormId(e.target.value)}>
          {forms.map((f) => (
            <option key={f.form_id} value={f.form_id}>
              {f.form_id}
            </option>
          ))}
        </select>
      </label>

      <div className="grid2">
        <label>
          Full name (as registered) *
          <input value={patient.full_name} onChange={set("full_name")} autoComplete="off" />
        </label>
        <label>
          NRIC / FIN *
          <input value={patient.nric} onChange={set("nric")} autoComplete="off" />
        </label>
        <label>
          Date of birth *
          <input type="date" value={patient.dob} onChange={set("dob")} />
        </label>
        <label>
          Phone
          <input value={patient.phone ?? ""} onChange={set("phone")} autoComplete="off" />
        </label>
        <label>
          Address
          <input value={patient.address ?? ""} onChange={set("address")} autoComplete="off" />
        </label>
        <label>
          Policy number
          <input
            value={patient.policy_number ?? ""}
            onChange={set("policy_number")}
            autoComplete="off"
          />
        </label>
        <label>
          Insurer *
          <input value={patient.insurer} onChange={set("insurer")} autoComplete="off" />
        </label>
      </div>

      <label>
        Clinical notes (paste from your clinic system) *
        <textarea
          rows={12}
          value={patient.clinical_text}
          onChange={set("clinical_text")}
          placeholder="Paste the patient's clinical notes here…"
        />
      </label>

      <button type="submit" disabled={!canSubmit}>
        {busy ? "Extracting…" : "Extract form fields"}
      </button>
    </form>
  );
}
