export type FieldStatus = "extracted" | "inferred" | "missing" | "demographic";
export type FieldType = "text" | "date" | "checkbox";

export interface MappedField {
  field_id: string;
  pdf_field_name: string;
  field_type: FieldType;
  /** Plain wording for the doctor, e.g. "Date of first consultation". */
  label: string;
  /** The question the insurer's form actually asks. */
  help: string | null;
  value: string | boolean | null;
  status: FieldStatus;
  source: string | null;
  needs_review: boolean;
}

/**
 * What POST /map returns: the rows, and which form they are for.
 *
 * There is deliberately no claim id. The server keeps nothing between the
 * mapping call and the fill, so there would be nothing for an id to refer to —
 * and a field declared here that the server does not send is worse than no
 * field at all, because the compiler would promise it is a string.
 */
export interface ClaimResponse {
  form_id: string;
  fields: MappedField[];
}

export interface FormFieldInfo {
  id: string;
  type: FieldType;
  source: string;
  label: string;
  description: string | null;
}

export interface FormInfo {
  form_id: string;
  display_name: string;
  insurer: string;
  fields: FormFieldInfo[];
}

export interface PatientInput {
  full_name: string;
  nric: string;
  dob: string; // ISO yyyy-mm-dd from <input type="date">
  phone?: string | null;
  address?: string | null;
  policy_number?: string | null;
  insurer: string;
  clinical_text: string;
}
