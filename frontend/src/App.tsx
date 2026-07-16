import { useEffect, useState } from "react";
import { approveClaim, createClaim, discardClaim, getForms } from "./api";
import PatientForm from "./PatientForm";
import ReviewTable from "./ReviewTable";
import type { ClaimResponse, FormInfo, PatientInput } from "./types";

type Stage =
  | { name: "input" }
  | { name: "review"; claim: ClaimResponse }
  | { name: "done"; fileName: string };

export default function App() {
  const [forms, setForms] = useState<FormInfo[] | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "input" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getForms()
      .then(setForms)
      .catch((e: Error) =>
        setError(`Could not reach the FormFill backend: ${e.message}`),
      );
  }, []);

  const handleCreate = async (formId: string, patient: PatientInput) => {
    setBusy(true);
    setError(null);
    try {
      const claim = await createClaim(formId, patient);
      setStage({ name: "review", claim });
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

  return (
    <main>
      <header>
        <h1>FormFill</h1>
        <p>Insurance forms from clinical notes — reviewed and approved by you.</p>
      </header>

      {stage.name === "input" && (
        <>
          {error && <div className="error">{error}</div>}
          {forms === null && !error && <p className="hint">Loading forms…</p>}
          {forms !== null && forms.length === 0 && (
            <p className="hint">No form schemas found on the server.</p>
          )}
          {forms !== null && forms.length > 0 && (
            <PatientForm forms={forms} busy={busy} onSubmit={handleCreate} />
          )}
        </>
      )}

      {stage.name === "review" && (
        <ReviewTable
          claim={stage.claim}
          busy={busy}
          error={error}
          onApprove={(values) => handleApprove(stage.claim, values)}
          onDiscard={() => handleDiscard(stage.claim)}
        />
      )}

      {stage.name === "done" && (
        <div className="card center">
          <h2>PDF downloaded</h2>
          <p className="hint">
            {stage.fileName} has been downloaded. All patient data for this
            claim has been deleted from the server.
          </p>
          <button onClick={() => setStage({ name: "input" })}>Start a new claim</button>
        </div>
      )}
    </main>
  );
}
