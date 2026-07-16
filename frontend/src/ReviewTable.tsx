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
  accepted: boolean;
}

const STATUS_LABEL: Record<FieldStatus, string> = {
  extracted: "Extracted",
  inferred: "Inferred",
  missing: "Missing",
  demographic: "Demographics",
};

function prettify(fieldId: string): string {
  const label = fieldId.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export default function ReviewTable({ claim, busy, error, onApprove, onDiscard }: Props) {
  const [rows, setRows] = useState<RowState[]>(() =>
    claim.fields.map((f) => ({ ...f, accepted: !f.needs_review })),
  );

  const setRow = (fieldId: string, patch: Partial<RowState>) =>
    setRows(rows.map((r) => (r.field_id === fieldId ? { ...r, ...patch } : r)));

  const pending = rows.filter((r) => !r.accepted).length;

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
    <div className="card">
      <h2>Review extracted fields</h2>
      <p className="hint">
        Every value below is a proposal — you decide what goes on the form.
        Amber and red rows were inferred or not found in the notes: edit them
        if needed, then tick <strong>Accept</strong> on each before generating.
      </p>

      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            <th>Status</th>
            <th>Accept</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field_id} className={row.accepted ? "" : "pending"}>
              <td>
                <div className="field-label">{prettify(row.field_id)}</div>
                {row.source && <div className="source">“{row.source}”</div>}
              </td>
              <td>
                {row.field_type === "checkbox" ? (
                  <input
                    type="checkbox"
                    checked={row.value === true}
                    onChange={(e) =>
                      setRow(row.field_id, { value: e.target.checked, accepted: true })
                    }
                  />
                ) : (
                  <input
                    type="text"
                    value={typeof row.value === "string" ? row.value : ""}
                    onChange={(e) =>
                      setRow(row.field_id, { value: e.target.value, accepted: true })
                    }
                  />
                )}
              </td>
              <td>
                <span className={`pill pill-${row.status}`}>{STATUS_LABEL[row.status]}</span>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={row.accepted}
                  onChange={(e) => setRow(row.field_id, { accepted: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && <div className="error">{error}</div>}

      <div className="actions">
        <button className="secondary" onClick={onDiscard} disabled={busy}>
          Discard claim
        </button>
        <button onClick={approve} disabled={busy || pending > 0}>
          {busy
            ? "Generating…"
            : pending > 0
              ? `Accept ${pending} remaining field${pending === 1 ? "" : "s"} to continue`
              : "Approve & generate PDF"}
        </button>
      </div>
    </div>
  );
}
