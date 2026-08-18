import { useRef, useState } from "react";
import { extractNote, formProof, uploadForm } from "./api";
import type { PatientInput, UploadedForm } from "./types";

interface Props {
  onSubmit: (
    formId: string,
    patient: PatientInput,
    /**
     * What the server will need again and has not kept: the schema it derived,
     * and the blank PDF itself. Both null for a form this repo describes.
     */
    form: { schema: unknown | null; blankForm: File | null },
  ) => void;
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

/**
 * The PDF claim flow: send in the blank form, then the notes, then who it is for.
 *
 * There is no form picker any more, and its absence is the design rather than a
 * simplification. A doctor holding a claim form does not know or care whether
 * this repository has a schema for it; asking them to find their insurer in a
 * list of six is asking a question the file itself answers. So the form is
 * uploaded, and the server works out what it is: a hand-authored schema when
 * the PDF is one it already describes, the bank when somebody has sent that
 * form in before, and a fresh read when nobody has.
 */
export default function PatientForm({ onSubmit }: Props) {
  const [form, setForm] = useState<UploadedForm | null>(null);
  // The file itself, kept because the fill needs the blank PDF back and this
  // browser is the only thing that reliably still has it.
  const [blankForm, setBlankForm] = useState<File | null>(null);
  const [insurer, setInsurer] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const set = (key: keyof Draft) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ ...draft, [key]: e.target.value });

  // Spell out what is still missing rather than just greying the button out —
  // a disabled button with no explanation is the classic first-use dead end.
  const missing: string[] = [];
  if (!form) missing.push("the blank insurance form");
  if (draft.clinical_text.trim() === "") missing.push("the consultation notes");
  if (draft.full_name.trim() === "") missing.push("patient name");
  if (draft.nric.trim() === "") missing.push("NRIC / FIN");
  if (draft.dob === "") missing.push("date of birth");
  const ready = missing.length === 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !form) return;
    onSubmit(
      form.form_id,
      {
        ...draft,
        insurer: insurer.trim(),
        phone: draft.phone?.trim() || null,
        address: draft.address?.trim() || null,
        policy_number: draft.policy_number?.trim() || null,
      },
      // Only what the server lacks. A curated form carries no schema back and
      // its PDF is already in the deployment, so neither is sent.
      { schema: form.schema, blankForm: form.schema ? blankForm : null },
    );
  };

  const addNotes = (text: string) =>
    setDraft((current) => ({
      ...current,
      // Appended, never replaced. A doctor who pasted a consultation and then
      // attached an operation record meant to send both, and losing the first
      // is unrecoverable from this screen.
      clinical_text: current.clinical_text.trim()
        ? `${current.clinical_text.trim()}\n\n${text}`
        : text,
    }));

  return (
    <form onSubmit={submit}>
      <section className="card">
        <h2>1. The blank insurance form</h2>
        <FormUpload
          form={form}
          insurer={insurer}
          onInsurer={setInsurer}
          onUploaded={(read, file) => {
            setForm(read);
            setBlankForm(file);
          }}
          onCleared={() => {
            setForm(null);
            setBlankForm(null);
          }}
        />
      </section>

      <section className="card">
        <h2>2. The consultation notes</h2>
        <NotesSection
          text={draft.clinical_text}
          onText={(value) => setDraft((current) => ({ ...current, clinical_text: value }))}
          onAppend={addNotes}
        />
      </section>

      <section className="card">
        <h2>3. Patient details</h2>
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

      <div className="submit-bar">
        <button type="submit" disabled={!ready}>
          Read the notes and fill the form
        </button>
        {!ready && <p className="hint">Still needed: {missing.join(", ")}.</p>}
      </div>
    </form>
  );
}

/**
 * Send in the blank form, and say what came back.
 *
 * The insurer name is asked for rather than guessed at. It goes onto the claim
 * as a demographic — copied deterministically, skipping both the model and the
 * review confirm — so it is not a thing to infer from a filename.
 */
function FormUpload({
  form,
  insurer,
  onInsurer,
  onUploaded,
  onCleared,
}: {
  form: UploadedForm | null;
  insurer: string;
  onInsurer: (value: string) => void;
  onUploaded: (form: UploadedForm, file: File) => void;
  onCleared: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onUploaded(await uploadForm(file, insurer), file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      // Cleared so re-attaching the same file still fires a change event.
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (form) {
    return (
      <div className="chosen">
        <p className="chosen-name">
          {/* The tick is the completion signal. What replaced the "Reading
              the form…" line is already proof it finished, but a doctor who
              looked away during a seven-page scan comes back to a card and
              has to work out whether it is a result or a status. */}
          <span className="chosen-tick" aria-hidden="true">✓</span>
          <strong>{form.display_name}</strong>
          <span className="chosen-sub">
            Read — {form.fields.length} questions found
            {form.known ? " — this form was already known" : ""}
          </span>
        </p>
        {form.fill_mode === "overlay" && <ProofCheck formId={form.form_id} />}
        <button type="button" className="back" onClick={onCleared}>
          ← Use a different form
        </button>
      </div>
    );
  }

  return (
    <div className="upload">
      <p className="hint">
        Upload the <strong>empty</strong> form the insurer sent you — the one you
        would otherwise print and fill in by hand. Do not upload a form you have
        already filled in.
      </p>
      <label>
        Blank form (PDF) <Req />
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={send}
          disabled={busy}
        />
      </label>
      <label>
        Insurer <Opt />
        <input
          value={insurer}
          onChange={(e) => onInsurer(e.target.value)}
          autoComplete="off"
          placeholder="e.g. Great Eastern"
        />
      </label>
      {busy && (
        <p className="hint">
          Reading the form… the first time anyone sends in a particular form this
          takes a few seconds per page.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * The notes, entered whichever way the doctor has them.
 *
 * The choice is asked outright instead of showing a paste box with a file input
 * tucked under it, because these are two different situations rather than a
 * main path and a fallback: a note copied out of a clinic system and a stack of
 * PDFs from a hospital are equally normal, and the second is most of what
 * arrives with a claim.
 *
 * Choosing is reversible. Nothing entered is discarded by changing the answer —
 * the text box is the same box either way — so going back costs nothing and
 * needs no warning.
 */
function NotesSection({
  text,
  onText,
  onAppend,
}: {
  text: string;
  onText: (value: string) => void;
  onAppend: (text: string) => void;
}) {
  const [mode, setMode] = useState<"paste" | "upload" | null>(null);

  if (mode === null) {
    return (
      <>
        <p className="hint">How do you have the notes?</p>
        <div className="choices">
          <button type="button" className="pick" onClick={() => setMode("paste")}>
            Type or paste them
            <span className="pick-sub">Straight out of your clinic system</span>
          </button>
          <button type="button" className="pick" onClick={() => setMode("upload")}>
            Upload documents
            <span className="pick-sub">
              Discharge summaries, referrals, operation records — as many as you have
            </span>
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {mode === "upload" && <NoteFiles onExtracted={onAppend} />}

      <label className="sr-label">
        {mode === "upload" ? "What was read from those documents" : "Clinical notes"}{" "}
        <Req />
        <textarea
          rows={12}
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={
            mode === "upload"
              ? "Text from the documents you attach appears here…"
              : "Paste the patient's notes here — untidy is fine…"
          }
        />
      </label>
      <p className="hint">
        {mode === "upload"
          ? "Check this before continuing. A PDF's text does not always come out in the order it appears on the page, and this is what gets read."
          : "Include the diagnosis, dates, treatment and any operation details, and the answers will be more complete."}
      </p>

      {/* Nothing typed is lost by changing the answer — same box either way. */}
      <button type="button" className="back" onClick={() => setMode(null)}>
        ← Enter the notes a different way
      </button>
    </>
  );
}

/**
 * Attach one or more documents.
 *
 * Several, because a claim rarely travels alone: a discharge summary, an
 * operation record and a referral letter are one consultation's worth of
 * evidence, and making the doctor choose between them would mean the mapper
 * answering from a fraction of what they have.
 *
 * The extracted text goes into the box above rather than onward invisibly. A
 * PDF's text layer is not always what the page looks like — columns interleave,
 * footers repeat — and what sits in that box is what redaction searches through.
 */
function NoteFiles({ onExtracted }: { onExtracted: (text: string) => void }) {
  const [done, setDone] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (!files.length) return;
    setErrors([]);
    for (const file of files) {
      setBusy(file.name);
      try {
        onExtracted(await extractNote(file));
        setDone((current) => [...current, file.name]);
      } catch (err) {
        // Named, and the rest still run. One unreadable scan in a stack of
        // four must not cost the doctor the other three.
        const why = err instanceof Error ? err.message : String(err);
        setErrors((current) => [...current, `${file.name}: ${why}`]);
      }
    }
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="upload">
      <label>
        Documents (PDF) — you can pick several, or add more later
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={send}
          disabled={busy !== null}
        />
      </label>
      {busy && <p className="hint">Reading {busy}…</p>}
      {done.length > 0 && (
        <ul className="attached">
          {done.map((name, i) => (
            <li key={`${name}-${i}`}>{name}</li>
          ))}
        </ul>
      )}
      {errors.map((message) => (
        <p className="error" key={message}>
          {message}
        </p>
      ))}
    </div>
  );
}

/**
 * The one check a doctor can actually make on a form read from a scan.
 *
 * There were no fillable boxes in that PDF, so where each answer goes was
 * worked out by a model looking at a picture of the page. Nothing downstream
 * can verify that: a box fifteen points too high produces a sensible answer
 * printed across the printed question above it, and the review screen shows it
 * exactly like a correct one. A doctor cannot audit a JSON schema — they can
 * look at their own form with the boxes drawn on it and see in one glance that
 * something is sitting on the wrong line.
 *
 * Opened in a tab rather than downloaded. It is a thing to glance at and close,
 * and putting it in Downloads beside the real filled forms is a way to print
 * and sign the wrong file later.
 */
function ProofCheck({ formId }: { formId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = URL.createObjectURL(await formProof(formId));
      window.open(url, "_blank", "noopener");
      // Not revoked immediately: the new tab is still loading from it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="proof">
      <p className="hint">
        That form is a scan, so BreezeFill worked out where each answer goes by
        reading the page. <strong>Check the boxes before you rely on it</strong>
        {" "}— every one is drawn on the form with its own name in it.
      </p>
      <button type="button" className="upload-open" onClick={show} disabled={busy}>
        {busy ? "Preparing…" : "Show me where the answers will go"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const Req = () => <span className="req">required</span>;
const Opt = () => <span className="opt">optional</span>;
