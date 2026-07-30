import { useEffect, useState } from "react";
import { approveClaim, createClaim, discardClaim, getForms } from "./api";
import PatientForm from "./PatientForm";
import ReviewScreen from "./ReviewScreen";
import Stepper from "./Stepper";
import type { ClaimResponse, FormInfo, PatientInput } from "./types";

type Stage =
  | { name: "input" }
  | { name: "review"; claim: ClaimResponse }
  | { name: "done"; fileName: string };

const STEP_OF: Record<Stage["name"], number> = { input: 1, review: 2, done: 3 };

export default function App() {
  const [forms, setForms] = useState<FormInfo[] | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "input" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getForms()
      .then(setForms)
      .catch(() =>
        setError(
          "Can't reach the ClaimFill server. Check your internet connection, " +
            "then reload this page.",
        ),
      );
  }, []);

  const handleCreate = async (formId: string, patient: PatientInput) => {
    setBusy(true);
    setError(null);
    try {
      const claim = await createClaim(formId, patient);
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
      const blob = await approveClaim(claim.claim_id, values);
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

  const handleDiscard = async (claim: ClaimResponse) => {
    setBusy(true);
    try {
      await discardClaim(claim.claim_id);
    } catch {
      // Discard is best-effort; the server purges stale claims anyway.
    } finally {
      setBusy(false);
      setError(null);
      setStage({ name: "input" });
    }
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
          {forms === null && !error && <p className="hint">Loading forms…</p>}
          {forms !== null && forms.length === 0 && (
            <p className="hint">No insurance forms are set up on the server yet.</p>
          )}
          {forms !== null && forms.length > 0 && (
            <PatientForm forms={forms} onSubmit={handleCreate} />
          )}
        </>
      )}

      {stage.name === "review" && (
        <ReviewScreen
          claim={stage.claim}
          busy={busy}
          error={error}
          onApprove={(values) => handleApprove(stage.claim, values)}
          onDiscard={() => handleDiscard(stage.claim)}
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
            This patient's details have already been deleted from the server.
            Nothing was saved.
          </p>
          <button onClick={() => setStage({ name: "input" })}>
            Start another claim
          </button>
        </div>
      )}
    </main>
  );
}

function Header() {
  return (
    <header>
      <h1>ClaimFill</h1>
      <p>
        Paste your clinical notes, check what's been filled in, download the
        insurance form ready to sign.
      </p>
    </header>
  );
}
