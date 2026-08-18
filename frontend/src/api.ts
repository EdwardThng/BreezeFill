import type { ClaimResponse, FormInfo, PatientInput, UploadedForm } from "./types";

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

/**
 * A File from an <input type="file">, as base64 with no data: prefix.
 *
 * FileReader rather than `btoa(String.fromCharCode(...bytes))`: the spread
 * form blows the argument limit and throws on anything past a few hundred KB,
 * which is every real insurance form.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.readAsDataURL(file);
  });
}

/**
 * The SHA-256 of a file, hex, computed in the browser.
 *
 * Matches `form_bank.key_for` on the server, which takes the first 32
 * characters of the same digest. Changing either without the other silently
 * turns every cache hit into a miss.
 */
async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A blank insurer form, read into a mappable schema.
 *
 * **Asks before it uploads.** Reading a form nobody has sent in before costs a
 * model call per page and takes a while; reading one that has been sent in
 * before costs nothing and should feel like nothing. So the file is hashed
 * here and the server is asked whether it already knows it — a few hundred
 * bytes — and the PDF itself only travels on a miss. A doctor re-using the
 * same insurer's form, which is the normal case, never uploads it twice.
 *
 * The PDF must be BLANK. The server refuses one that already has answers in
 * it — that is a patient's completed claim, and this is the one route in the
 * product that keeps what it is given.
 */
export async function uploadForm(
  file: File,
  insurer: string,
): Promise<UploadedForm> {
  try {
    const known = await fetch(
      `${API_BASE}/forms/known?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha256: await sha256(file) }),
      },
    );
    if (known.ok) return known.json();
    // Anything else — a 404 saying nobody has sent this form in, or a network
    // fault — falls through to the upload. This is an optimisation, and an
    // optimisation that can fail the request is a liability rather than a win.
  } catch {
    // Deliberately swallowed, same reason.
  }

  const res = await ensureOk(
    await fetch(`${API_BASE}/forms/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdf_base64: await fileToBase64(file),
        filename: file.name,
        insurer: insurer.trim() || null,
      }),
    }),
  );
  return res.json();
}

/**
 * A consultation note that arrived as a PDF, as text.
 *
 * The text comes back to be shown in the notes box rather than sent onward —
 * a PDF's text layer is not always what the page looks like, and what sits in
 * that box is what redaction searches through.
 */
export async function extractNote(file: File): Promise<string> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/notes/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_base64: await fileToBase64(file) }),
    }),
  );
  return (await res.json()).text as string;
}

/**
 * The blank form with every box drawn on it, stamped with its own field id.
 *
 * Only meaningful for a form read from a SCAN, where the geometry was worked
 * out by a model looking at a picture of the page and nothing downstream can
 * check it. A box fifteen points too high produces a perfectly reasonable
 * answer printed across the question above it, and the review screen renders
 * that exactly like a correct one.
 */
export async function formProof(formId: string): Promise<Blob> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/forms/${encodeURIComponent(formId)}/proof`, {
      method: "POST",
    }),
  );
  return res.blob();
}
