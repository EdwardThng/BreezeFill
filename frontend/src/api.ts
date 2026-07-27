import type { ClaimResponse, FormInfo, PatientInput } from "./types";

// In production the API and this page are served by the same app, so relative
// URLs are correct and there is nothing to configure. In dev, Vite serves this
// on :5173 while uvicorn runs on :8000.
const API_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.DEV ? "http://localhost:8000" : "");

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) {
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      // non-JSON error body; keep the status line
    }
    throw new Error(detail);
  }
  return res;
}

export async function getForms(): Promise<FormInfo[]> {
  const res = await ensureOk(await fetch(`${API_BASE}/forms`));
  return res.json();
}

export async function createClaim(
  formId: string,
  patient: PatientInput,
): Promise<ClaimResponse> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form_id: formId, patient }),
    }),
  );
  return res.json();
}

export async function approveClaim(
  claimId: string,
  values: Record<string, string | boolean | null>,
): Promise<Blob> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/claims/${claimId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }),
  );
  return res.blob();
}

export async function discardClaim(claimId: string): Promise<void> {
  await ensureOk(await fetch(`${API_BASE}/claims/${claimId}`, { method: "DELETE" }));
}
