import type { ClaimResponse, FormInfo, PatientInput } from "./types";

// Empty means "same origin", which is right when the backend serves this
// bundle. Set VITE_API_URL at build time when the site is hosted separately —
// the backend's FORMFILL_ALLOWED_ORIGINS is the other half of that. In dev,
// Vite serves this on :5173 while uvicorn runs on :8000.
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

/**
 * Redact the note and map it onto the form's fields.
 *
 * Returns the review rows and nothing else — no id, because the server keeps
 * no copy. From here until the PDF is generated, the only place these values
 * exist is this browser tab.
 */
export async function mapClaim(
  formId: string,
  patient: PatientInput,
): Promise<ClaimResponse> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form_id: formId, patient }),
    }),
  );
  return res.json();
}

/**
 * Final values in, filled PDF out.
 *
 * Send every field: the server has nothing to fall back on, so anything
 * omitted comes back blank. Discarding a claim needs no call at all now —
 * dropping the values on this side is the whole of it.
 */
export async function fillPdf(
  formId: string,
  values: Record<string, string | boolean | null>,
): Promise<Blob> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/forms/${encodeURIComponent(formId)}/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }),
  );
  return res.blob();
}

/**
 * Open a Stripe Checkout for the one plan this product sells.
 *
 * Takes no arguments, and that is the point: the price, the quantity and the
 * address Stripe returns to are all decided on the server, where a caller
 * cannot reach them.
 */
export async function openCheckout(): Promise<string> {
  const res = await ensureOk(await fetch(`${API_BASE}/checkout`, { method: "POST" }));
  return (await res.json()).url as string;
}

/**
 * A paid checkout session, in; the clinic's licence key, out.
 *
 * The server asks Stripe whether the session was really paid before it signs
 * anything, so this is safe to call with whatever came back in the URL.
 */
export async function claimLicence(sessionId: string): Promise<string> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/licence/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    }),
  );
  return (await res.json()).licence as string;
}
