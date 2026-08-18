import { useRef, useState } from "react";
import { extractNote, uploadForm } from "./api";
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
  /**
   * Forms this doctor uploaded in this session, alongside the ones the bank
   * already had. They are kept here rather than pushed back up to ClaimApp
   * because nothing above this component needs them: an uploaded form is
   * addressed by its `form_id` exactly like any other, and the server finds it
   * again from that id alone.
   */
  const [uploaded, setUploaded] = useState<FormInfo[]>([]);
  const available = [...forms, ...uploaded];

  const [formId, setFormId] = useState(forms[0]?.form_id ?? "");
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const set = (key: keyof Draft) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ ...draft, [key]: e.target.value });

  const selected = available.find((f) => f.form_id === formId);

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

  const onUploaded = (form: FormInfo) => {
    // Replace rather than append when the same form comes back: the id is a
    // hash of the PDF, so re-uploading one is the same form and must not
    // appear twice in the list.
    setUploaded((current) => [
      ...current.filter((f) => f.form_id !== form.form_id),
      form,
    ]);
    setFormId(form.form_id);
  };

  return (
    <form onSubmit={submit}>
      <section className="card">
        <h2>1. Which form are you filling in?</h2>
        <div className="form-choices">
          {available.map((f) => (
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
                <strong>{f.insurer || "Your upload"}</strong>
                <span className="choice-sub">{f.display_name}</span>
              </span>
            </label>
          ))}
        </div>

        <FormUpload onUploaded={onUploaded} />
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

        <NoteUpload
          onExtracted={(text) =>
            setDraft((current) => ({
              ...current,
              // Appended, never replaced. A doctor who pasted something and
              // then attached a discharge summary meant to send both, and
              // silently dropping the first is unrecoverable from this screen.
              clinical_text: current.clinical_text.trim()
                ? `${current.clinical_text.trim()}\n\n${text}`
                : text,
            }))
          }
        />
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

/**
 * Upload a blank insurer form the bank has never seen.
 *
 * The insurer name is asked for rather than guessed at. It goes onto the claim
 * as a demographic — copied to the form deterministically, skipping both the
 * model and the review confirm — so it is not a thing to infer from a filename.
 */
function FormUpload({ onUploaded }: { onUploaded: (form: FormInfo) => void }) {
  const [open, setOpen] = useState(false);
  const [insurer, setInsurer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await uploadForm(file, insurer);
      onUploaded({
        form_id: result.form_id,
        display_name: result.display_name,
        insurer: insurer.trim(),
        fields: result.fields.map((f) => ({
          id: f.id,
          type: f.type,
          source: f.source,
          label: f.label,
          description: f.description,
        })),
      });
      setNote(
        result.known
          ? `Read ${result.fields.length} questions — this form was already known.`
          : `Read ${result.fields.length} questions from that form.`,
      );
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="upload">
        <button type="button" className="upload-open" onClick={() => setOpen(true)}>
          Not listed? Upload a blank form
        </button>
        {note && <p className="upload-ok">{note}</p>}
      </div>
    );
  }

  return (
    <div className="upload upload-open-panel">
      <p className="hint">
        Upload the <strong>empty</strong> form the insurer sent you. It is read
        once and remembered, so the next time anyone uploads it there is nothing
        to wait for. Do not upload a form you have already filled in.
      </p>
      <label>
        Blank form (PDF)
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" />
      </label>
      <label>
        Insurer <Opt />
        <input
          value={insurer}
          onChange={(e) => setInsurer(e.target.value)}
          autoComplete="off"
          placeholder="e.g. Great Eastern"
        />
      </label>
      <div className="upload-actions">
        <button type="button" onClick={send} disabled={busy}>
          {busy ? "Reading the form…" : "Read this form"}
        </button>
        <button type="button" className="upload-cancel" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {busy && (
        <p className="hint">
          This takes a few seconds per page the first time a form is seen.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Attach a note that arrived as a PDF instead of retyping it.
 *
 * What comes back goes into the notes box above, visible and editable, rather
 * than straight onward. A PDF's text layer is not always what the page looks
 * like — columns interleave, footers repeat — and what sits in that box is
 * what gets redacted and what gets read.
 */
function NoteUpload({ onExtracted }: { onExtracted: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onExtracted(await extractNote(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      // Clear it, so attaching the same file twice still fires a change event.
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="upload">
      <label className="upload-note">
        <span>Or attach the notes as a PDF — a discharge summary, a referral,
          an operation record. The text is added to the box above for you to
          check.</span>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={send}
          disabled={busy}
        />
      </label>
      {busy && <p className="hint">Reading that PDF…</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const Req = () => <span className="req">required</span>;
const Opt = () => <span className="opt">optional</span>;
