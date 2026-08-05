import { useState } from "react";
import type { ClaimResponse, FieldStatus, MappedField } from "./types";

interface Props {
  claim: ClaimResponse;
  busy: boolean;
  error: string | null;
  onApprove: (values: Record<string, string | boolean | null>) => void;
  onDiscard: () => void;
}

interface RowState extends MappedField {
  confirmed: boolean;
}

/** Plain wording — a doctor should not have to learn what "inferred" means. */
const STATUS: Record<FieldStatus, { label: string; note: string }> = {
  extracted: { label: "From your notes", note: "Copied from what you wrote." },
  inferred: {
    label: "Worked out",
    note: "Not stated outright — the AI concluded this from your notes. Please check it.",
  },
  missing: {
    label: "Not found",
    note: "This wasn't in the notes. Type it in, or leave it blank to fill by hand.",
  },
  demographic: { label: "From patient details", note: "Copied from what you entered." },
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A date spelled out, plus the date it might have been instead.
 *
 * A row asking "is the day and month the right way round" is only answerable
 * if the doctor can see both readings, and "03/07/2026" shows neither. The
 * rival is offered only when the day could itself be a month — 25/07 has one
 * reading, and a second one that cannot exist is noise.
 *
 * Display only: it never changes the value sent to the server, and it never
 * expands a two-digit year, because choosing 2026 over 1926 is a guess the
 * backend deliberately refuses to make (see `_apply_date_format`).
 *
 * The extension's panel carries its own copy. Two bundles, and this is
 * presentation rather than a rule, so a drift between them costs a phrasing
 * difference and nothing more — unlike the redaction patterns, which is why
 * those live on the server alone.
 */
export function readableDate(value: string | boolean | null): string {
  if (typeof value !== "string") return "";
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}(?:\d{2})?)\s*$/.exec(value);
  if (!match) return "";
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3];
  if (day < 1 || day > 31 || month < 1 || month > 12) return "";

  const reading = `${day} ${MONTH_NAMES[month - 1]} ${year}`;
  if (day > 12) return reading;
  return `${reading} — or ${month} ${MONTH_NAMES[day - 1]} ${year} if the notes wrote the month first`;
}

export default function ReviewScreen({ claim, busy, error, onApprove, onDiscard }: Props) {
  const [rows, setRows] = useState<RowState[]>(() =>
    claim.fields.map((f) => ({ ...f, confirmed: !f.needs_review })),
  );
  const [showSettled, setShowSettled] = useState(true);

  const setRow = (fieldId: string, patch: Partial<RowState>) =>
    setRows((rs) => rs.map((r) => (r.field_id === fieldId ? { ...r, ...patch } : r)));

  // A row starts in "needs checking" and stays in that group even after it is
  // confirmed, so answers never jump around the page under the doctor's cursor.
  const needsChecking = rows.filter((r) => r.needs_review);
  const settled = rows.filter((r) => !r.needs_review);
  const pending = needsChecking.filter((r) => !r.confirmed).length;
  const pendingRecheck = needsChecking.filter((r) => !r.confirmed && r.recheck).length;

  // "Confirm all" deliberately does not reach a row with a recheck reason.
  // Those rows exist because reading them one at a time is the whole point —
  // a bulk button over a swapped date confirms it as fast as a correct one,
  // which is the failure this was added to prevent. Everything else is a
  // value the doctor has read and agreed with, and clearing those in one
  // click is what keeps the remaining ones worth stopping at.
  const bulkConfirmable = needsChecking.filter((r) => !r.confirmed && !r.recheck).length;
  const confirmAll = () =>
    setRows((rs) =>
      rs.map((r) => (r.needs_review && !r.recheck ? { ...r, confirmed: true } : r)),
    );

  const approve = () => {
    const values: Record<string, string | boolean | null> = {};
    for (const row of rows) {
      if (row.field_type === "checkbox") {
        values[row.field_id] = row.value === true;
      } else {
        const text = typeof row.value === "string" ? row.value.trim() : "";
        values[row.field_id] = text === "" ? null : text;
      }
    }
    onApprove(values);
  };

  return (
    <div>
      <section className="card">
        <h2>Check the answers</h2>
        <p>
          Nothing is on the form yet. Every answer below is a suggestion —
          correct anything that's wrong, then confirm it.
        </p>
        {pending > 0 ? (
          <div className="banner banner-warn">
            <div>
              <strong>
                {pending} answer{pending === 1 ? "" : "s"} still need
                {pending === 1 ? "s" : ""} your check.
              </strong>
              <div className="hint">
                {pendingRecheck > 0
                  ? "Dates are checked one at a time — the day and month can be the wrong way round. The rest were worked out by the AI or weren't in the notes at all."
                  : "These were worked out by the AI or weren't in the notes at all."}
              </div>
            </div>
            {bulkConfirmable > 0 && (
              <button type="button" className="secondary" onClick={confirmAll}>
                I've read them — confirm all {bulkConfirmable}
              </button>
            )}
          </div>
        ) : (
          <div className="banner banner-ok">
            <strong>All answers confirmed.</strong> You can generate the form.
          </div>
        )}
      </section>

      {needsChecking.length > 0 && (
        <section className="card">
          <h3 className="group-head">
            Needs your check
            <span className="count">{needsChecking.length}</span>
          </h3>
          <div className="rows">
            {needsChecking.map((row) => (
              <Row key={row.field_id} row={row} setRow={setRow} />
            ))}
          </div>
        </section>
      )}

      {settled.length > 0 && (
        <section className="card">
          <h3 className="group-head">
            Taken straight from your notes
            <span className="count">{settled.length}</span>
            <button
              type="button"
              className="link"
              onClick={() => setShowSettled(!showSettled)}
            >
              {showSettled ? "Hide" : "Show"}
            </button>
          </h3>
          <p className="hint">
            These matched your notes word for word. You can still edit any of
            them.
          </p>
          {showSettled && (
            <div className="rows">
              {settled.map((row) => (
                <Row key={row.field_id} row={row} setRow={setRow} />
              ))}
            </div>
          )}
        </section>
      )}

      {error && <div className="error">{error}</div>}

      <div className="actions">
        <button type="button" className="secondary" onClick={onDiscard} disabled={busy}>
          Cancel this claim
        </button>
        <div className="submit-bar right">
          <button type="button" onClick={approve} disabled={busy || pending > 0}>
            {busy ? "Making the PDF…" : "Generate the filled form"}
          </button>
          {pending > 0 && (
            <p className="hint">
              Confirm the {pending} remaining answer{pending === 1 ? "" : "s"} first.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  row,
  setRow,
}: {
  row: RowState;
  setRow: (fieldId: string, patch: Partial<RowState>) => void;
}) {
  const status = STATUS[row.status];
  return (
    <div className={`row ${row.needs_review && !row.confirmed ? "row-pending" : ""}`}>
      <div className="row-label">
        <label htmlFor={row.field_id} className="field-label">
          {row.label}
        </label>
        {row.help && <div className="field-help">{row.help}</div>}
        <span className={`pill pill-${row.status}`}>{status.label}</span>
      </div>

      <div className="row-value">
        {row.field_type === "checkbox" ? (
          <label className="inline-check">
            <input
              id={row.field_id}
              type="checkbox"
              checked={row.value === true}
              onChange={(e) =>
                setRow(row.field_id, { value: e.target.checked, confirmed: true })
              }
            />
            Yes
          </label>
        ) : (
          <textarea
            id={row.field_id}
            rows={2}
            value={typeof row.value === "string" ? row.value : ""}
            placeholder={row.status === "missing" ? "Not found — type it in, or leave blank" : ""}
            onChange={(e) => setRow(row.field_id, { value: e.target.value, confirmed: true })}
          />
        )}

        {row.field_type === "date" && readableDate(row.value) && (
          <div className="date-hint">{readableDate(row.value)}</div>
        )}

        {row.source && <div className="source">From your notes: “{row.source}”</div>}
        {/* The recheck reason wins over the status note. A date held for
            checking would otherwise read "Copied from what you wrote", which
            tells the doctor there is nothing here to look at. */}
        {row.needs_review && (
          <div className={row.recheck ? "status-note recheck" : "status-note"}>
            {row.recheck ?? status.note}
          </div>
        )}

        {row.needs_review && (
          <label className={`confirm ${row.confirmed ? "confirm-on" : ""}`}>
            <input
              type="checkbox"
              checked={row.confirmed}
              onChange={(e) => setRow(row.field_id, { confirmed: e.target.checked })}
            />
            {row.confirmed ? "Confirmed" : "Confirm this answer"}
          </label>
        )}
      </div>
    </div>
  );
}
