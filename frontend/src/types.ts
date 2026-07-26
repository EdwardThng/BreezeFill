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

export interface ClaimResponse {
  claim_id: string;
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
