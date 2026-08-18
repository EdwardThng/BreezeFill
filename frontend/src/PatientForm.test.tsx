/**
 * The input screen, and specifically the two things it can now be given as a
 * PDF: a blank insurer form the bank has never seen, and the consultation note
 * itself.
 *
 * The properties worth pinning are the ones that would be invisible if they
 * broke — an attached note that silently replaced a pasted one, or an insurer
 * quietly inferred from a filename and copied onto a claim without review.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./api", () => ({
  uploadForm: vi.fn(),
  extractNote: vi.fn(),
}));

import { extractNote, uploadForm } from "./api";
import PatientForm from "./PatientForm";
import type { FormInfo } from "./types";

const FORMS: FormInfo[] = [
  {
    form_id: "ge_ghs_claim",
    display_name: "GHS claim form",
    insurer: "Great Eastern",
    fields: [],
  },
];

const pdf = (name = "blank_form.pdf") =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: "application/pdf",
  });

function uploaded(over = {}) {
  return {
    form_id: `upload_${"a".repeat(32)}`,
    display_name: "blank form",
    known: false,
    fields: [
      { id: "diagnosis", label: "Diagnosis", description: null, type: "text", options: [], source: "llm" },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(uploadForm).mockReset();
  vi.mocked(extractNote).mockReset();
});

describe("uploading a blank form the bank has never seen", () => {
  test("the panel is shut until it is asked for", () => {
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /upload a blank form/i })).toBeTruthy();
    expect(screen.queryByLabelText(/blank form \(pdf\)/i)).toBeNull();
  });

  test("an uploaded form joins the list and is selected", async () => {
    vi.mocked(uploadForm).mockResolvedValue(uploaded() as never);
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /upload a blank form/i }));
    await user.upload(screen.getByLabelText(/blank form \(pdf\)/i), pdf());
    await user.click(screen.getByRole("button", { name: /read this form/i }));

    const choice = await screen.findByRole("radio", { name: /blank form/i });
    expect((choice as HTMLInputElement).checked).toBe(true);
  });

  test("the insurer is asked for, never taken from the filename", async () => {
    // It goes onto the claim as a demographic — copied deterministically,
    // skipping the model AND the review confirm — so it must be typed by the
    // person who knows, not guessed from what the file happened to be called.
    vi.mocked(uploadForm).mockResolvedValue(uploaded() as never);
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /upload a blank form/i }));
    await user.upload(screen.getByLabelText(/blank form \(pdf\)/i), pdf("AIA_claim.pdf"));
    await user.type(screen.getByLabelText(/insurer/i), "AIA");
    await user.click(screen.getByRole("button", { name: /read this form/i }));

    await waitFor(() => expect(uploadForm).toHaveBeenCalled());
    expect(vi.mocked(uploadForm).mock.calls[0][1]).toBe("AIA");
  });

  test("the doctor is told not to upload a form they already filled in", async () => {
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /upload a blank form/i }));
    expect(screen.getByText(/already filled in/i)).toBeTruthy();
  });

  test("a refusal from the server is shown rather than swallowed", async () => {
    vi.mocked(uploadForm).mockRejectedValue(
      new Error("This form is a scan — an image of a page."),
    );
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /upload a blank form/i }));
    await user.upload(screen.getByLabelText(/blank form \(pdf\)/i), pdf());
    await user.click(screen.getByRole("button", { name: /read this form/i }));

    expect(await screen.findByText(/is a scan/i)).toBeTruthy();
  });

  test("re-uploading the same form does not list it twice", async () => {
    vi.mocked(uploadForm).mockResolvedValue(uploaded() as never);
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);

    for (let i = 0; i < 2; i++) {
      await user.click(screen.getByRole("button", { name: /upload a blank form/i }));
      await user.upload(screen.getByLabelText(/blank form \(pdf\)/i), pdf());
      await user.click(screen.getByRole("button", { name: /read this form/i }));
      await screen.findByRole("radio", { name: /blank form/i });
    }
    // The id is a hash of the PDF, so the same file is the same form.
    expect(screen.getAllByRole("radio", { name: /blank form/i })).toHaveLength(1);
  });
});

describe("attaching the notes as a PDF", () => {
  test("the extracted text lands in the notes box for checking", async () => {
    // Shown, not sent onward. A PDF's text layer is not always what the page
    // looks like, and this box is what redaction searches through.
    vi.mocked(extractNote).mockResolvedValue("Dx acute tonsillitis. MC 2 days.");
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText(/attach the notes as a pdf/i), pdf("note.pdf"));

    const box = await screen.findByPlaceholderText(/paste the patient's notes/i);
    expect((box as HTMLTextAreaElement).value).toContain("acute tonsillitis");
  });

  test("an attachment is added to what was pasted, never over it", async () => {
    // A doctor who pasted a consultation and then attached a discharge summary
    // meant to send both, and losing the first is unrecoverable from here.
    vi.mocked(extractNote).mockResolvedValue("Discharge summary text.");
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);

    const box = screen.getByPlaceholderText(/paste the patient's notes/i);
    await user.type(box, "Pasted consultation.");
    await user.upload(screen.getByLabelText(/attach the notes as a pdf/i), pdf("note.pdf"));

    await waitFor(() =>
      expect((box as HTMLTextAreaElement).value).toContain("Discharge summary"),
    );
    expect((box as HTMLTextAreaElement).value).toContain("Pasted consultation.");
  });

  test("a scanned note is refused with the reason, and the box is untouched", async () => {
    vi.mocked(extractNote).mockRejectedValue(
      new Error("There is no readable text in that PDF."),
    );
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);

    const box = screen.getByPlaceholderText(/paste the patient's notes/i);
    await user.type(box, "Pasted consultation.");
    await user.upload(screen.getByLabelText(/attach the notes as a pdf/i), pdf("scan.pdf"));

    expect(await screen.findByText(/no readable text/i)).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("Pasted consultation.");
  });
});

describe("what still has to be true before anything is mapped", () => {
  test("an uploaded form does not skip the required patient details", async () => {
    vi.mocked(uploadForm).mockResolvedValue(uploaded() as never);
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /upload a blank form/i }));
    await user.upload(screen.getByLabelText(/blank form \(pdf\)/i), pdf());
    await user.click(screen.getByRole("button", { name: /read this form/i }));
    await screen.findByRole("radio", { name: /blank form/i });

    const submit = screen.getByRole("button", { name: /read the notes/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/still needed/i).textContent).toContain("patient name");
  });

  test("the insurer typed at upload is what reaches the claim", async () => {
    vi.mocked(uploadForm).mockResolvedValue(uploaded() as never);
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PatientForm forms={FORMS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: /upload a blank form/i }));
    await user.upload(screen.getByLabelText(/blank form \(pdf\)/i), pdf());
    await user.type(screen.getByLabelText(/insurer/i), "Prudential");
    await user.click(screen.getByRole("button", { name: /read this form/i }));
    await screen.findByRole("radio", { name: /blank form/i });

    await user.type(screen.getByLabelText(/patient name/i), "Synthetic Patient");
    await user.type(screen.getByLabelText(/nric/i), "S8012345D");
    await user.type(screen.getByLabelText(/date of birth/i), "1978-03-14");
    await user.type(
      screen.getByPlaceholderText(/paste the patient's notes/i),
      "Seen 03/07/2026, acute tonsillitis.",
    );
    await user.click(screen.getByRole("button", { name: /read the notes/i }));

    expect(onSubmit).toHaveBeenCalled();
    const [formId, patient] = onSubmit.mock.calls[0];
    expect(formId).toMatch(/^upload_/);
    expect(patient.insurer).toBe("Prudential");
  });
});
