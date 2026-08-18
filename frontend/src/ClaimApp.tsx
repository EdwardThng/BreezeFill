import { useState } from "react";
import { fillPdf, mapClaim } from "./api";
import PatientForm from "./PatientForm";
import ReviewScreen from "./ReviewScreen";
import Stepper from "./Stepper";
import type { ClaimResponse, PatientInput } from "./types";

type Stage =
  | { name: "input" }
  | { name: "review"; claim: ClaimResponse }
  | { name: "done"; fileName: string };

const STEP_OF: Record<Stage["name"], number> = { input: 1, review: 2, done: 3 };

/**
 * The PDF claim flow: paste notes, review, download a filled form.
 *
 * No longer the front door. The extension is the product surface now (it fills
 * the insurer's own web form in place), and the site's job is to hand that out
 * — see Landing.tsx. This is kept, and kept working, because not every insurer
 * sends a link: the five acroform/overlay schemas are real forms doctors still
 * receive as PDFs, and this is the only way to use them. It lives at #/app and
 * is not advertised.
 */
export default function ClaimApp() {
  /**
   * The uploaded form, held for as long as the claim is being worked on.
   *
   * The server keeps no copy of an uploaded form between requests unless a
   * bank is provisioned, so the schema and the blank PDF travel with the map
   * and the fill. This browser is the only thing that reliably has them, and a
   * doctor who typed in a whole claim should not lose it to a storage
   * decision — which is exactly what `unknown form_id: upload_…` was.
   *
   * Both are null for a form this repo already describes; the server has those.
   */
  const [carried, setCarried] = useState<{
    schema: unknown | null;
    blankForm: File | null;
  }>({ schema: null, blankForm: null });

  const [stage, setStage] = useState<Stage>({ name: "input" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No form list is fetched any more. The doctor sends in the blank form and
  // the server works out what it is — see the header of PatientForm for why
  // the picker went. Connectivity now surfaces on the first thing they try,
  // which is the upload, rather than as a banner about a list they never saw.

  const handleCreate = async (
    formId: string,
    patient: PatientInput,
    form: { schema: unknown | null; blankForm: File | null },
  ) => {
    setCarried(form);
    setBusy(true);
    setError(null);
    try {
      const claim = await mapClaim(formId, patient, form.schema);
      setStage({ name: "review", claim });
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async (
    claim: ClaimResponse,
    values: Record<string, string | boolean | null>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const blob = await fillPdf(
        claim.form_id,
        values,
        carried.schema,
        carried.blankForm,
      );
      const fileName = `${claim.form_id}_filled.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      setStage({ name: "done", fileName });
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Discarding needs no request. The server never had a copy — dropping the
  // stage is the whole of it.
  const handleDiscard = () => {
    setError(null);
    setStage({ name: "input" });
  };

  const startAnother = () => {
    // The next claim is a different form as often as not, and a stale blank
    // PDF paired with a fresh schema is refused by the server anyway — it
    // checks the bytes hash to the form the answers were mapped against.
    setCarried({ schema: null, blankForm: null });
    setStage({ name: "input" });
  };

  // The LLM call takes 10-30s. Without a full-screen state people click twice
  // or assume it has hung.
  if (stage.name === "input" && busy) {
    return (
      <main>
        <Header />
        <Stepper current={1} />
        <div className="card center waiting">
          <div className="spinner" aria-hidden="true" />
          <h2>Reading the notes…</h2>
          <p className="hint">
            This usually takes 10 to 30 seconds. You'll get a chance to check
            and correct every answer on the next screen.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <Header />
      <Stepper current={STEP_OF[stage.name]} />

      {stage.name === "input" && (
        <>
          {error && <div className="error">{error}</div>}
          <PatientForm onSubmit={handleCreate} />
        </>
      )}

      {stage.name === "review" && (
        <ReviewScreen
          claim={stage.claim}
          busy={busy}
          error={error}
          onApprove={(values) => handleApprove(stage.claim, values)}
          onDiscard={handleDiscard}
        />
      )}

      {stage.name === "done" && (
        <div className="card">
          <h2>Done — your form has downloaded</h2>
          <p>
            <code>{stage.fileName}</code> is in your Downloads folder.
          </p>
          <ol className="next-steps">
            <li>Open the PDF and read it once more.</li>
            <li>
              Fill in anything left blank by hand — tick boxes and small
              day/month/year boxes aren't filled automatically.
            </li>
            <li>Print, sign and stamp it as usual.</li>
          </ol>
          <p className="hint">
            Nothing was saved. The server kept no copy of this patient at any
            point — it read the note, returned the answers, and forgot both.
          </p>
          <button onClick={startAnother}>Start another claim</button>
        </div>
      )}
    </main>
  );
}

function Header() {
  return (
    <header>
      <h1>BreezeFill</h1>
      <p>
        Upload the empty insurance form, add your notes, check what's been
        filled in, download it ready to sign.
      </p>
    </header>
  );
}
