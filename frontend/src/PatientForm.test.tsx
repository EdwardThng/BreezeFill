/**
 * The PDF claim flow: the blank form in, the notes in, then who it is for.
 *
 * The properties worth pinning are the ones that would be invisible if they
 * broke — a wrong turn a doctor cannot back out of, an attached document that
 * silently replaced a pasted note, one unreadable scan costing the other three,
 * or an insurer quietly inferred from a filename and copied onto a claim
 * without review.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./api", () => ({
  uploadForm: vi.fn(),
  extractNote: vi.fn(),
  formProof: vi.fn(),
}));

import { extractNote, formProof, uploadForm } from "./api";
import PatientForm from "./PatientForm";

const pdf = (name = "blank_form.pdf") =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: "application/pdf",
  });

function uploaded(over = {}) {
  return {
    form_id: `upload_${"a".repeat(32)}`,
    display_name: "GHS claim form",
    known: false,
    fill_mode: "acroform",
    fields: [
      {
        id: "diagnosis",
        label: "Diagnosis",
        description: null,
        type: "text",
        options: [],
        source: "llm",
      },
    ],
    ...over,
  };
}

const formInput = () => screen.getByLabelText(/blank form \(pdf\)/i);
const notesBox = () =>
  screen.getByRole("textbox", { name: /clinical notes|what was read/i });

beforeEach(() => {
  vi.mocked(uploadForm).mockReset();
  vi.mocked(extractNote).mockReset();
  vi.mocked(formProof).mockReset();
});

async function sendForm(user: ReturnType<typeof userEvent.setup>, over = {}) {
  vi.mocked(uploadForm).mockResolvedValue(uploaded(over) as never);
  await user.upload(formInput(), pdf());
  return screen.findByText(/questions found/i);
}

describe("section 1 — the blank insurance form", () => {
  test("the form is uploaded, not picked from a list", () => {
    // The picker is gone on purpose. A doctor holding a claim form does not
    // know whether this repo has a schema for it, and the file answers the
    // question they would otherwise have been asked.
    render(<PatientForm onSubmit={vi.fn()} />);
    expect(formInput()).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  test("what came back is reported, with how many questions", async () => {
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);
    await sendForm(user);
    expect(screen.getByText(/GHS claim form/)).toBeTruthy();
    expect(screen.getByText(/1 questions found/)).toBeTruthy();
  });

  test("a form the server already knew says so", async () => {
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);
    await sendForm(user, { known: true });
    expect(screen.getByText(/already known/i)).toBeTruthy();
  });

  test("the wrong form can be backed out of", async () => {
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);
    await sendForm(user);

    await user.click(screen.getByRole("button", { name: /use a different form/i }));
    expect(formInput()).toBeTruthy();
    expect(screen.queryByText(/questions found/i)).toBeNull();
  });

  test("the insurer is asked for, never taken from the filename", async () => {
    // It goes onto the claim as a demographic — copied deterministically,
    // skipping the model AND the review confirm — so it must be typed by the
    // person who knows, not guessed from what the file happened to be called.
    vi.mocked(uploadForm).mockResolvedValue(uploaded() as never);
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText(/insurer/i), "AIA");
    await user.upload(formInput(), pdf("great_eastern_claim.pdf"));

    await waitFor(() => expect(uploadForm).toHaveBeenCalled());
    expect(vi.mocked(uploadForm).mock.calls[0][1]).toBe("AIA");
  });

  test("the doctor is told not to send a form they already filled in", () => {
    render(<PatientForm onSubmit={vi.fn()} />);
    expect(screen.getByText(/already filled in/i)).toBeTruthy();
  });

  test("a refusal from the server is shown rather than swallowed", async () => {
    vi.mocked(uploadForm).mockRejectedValue(
      new Error("That PDF is password-protected."),
    );
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.upload(formInput(), pdf());
    expect(await screen.findByText(/password-protected/i)).toBeTruthy();
  });
});

describe("section 2 — how the doctor has the notes", () => {
  test("the choice is asked before either input appears", () => {
    render(<PatientForm onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /type or paste/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /upload documents/i })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /clinical notes/i })).toBeNull();
  });

  test("choosing paste gives a box to paste into", async () => {
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /type or paste/i }));
    expect(notesBox()).toBeTruthy();
  });

  test("choosing upload gives a file picker that takes several", async () => {
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /upload documents/i }));
    const input = screen.getByLabelText(/documents \(pdf\)/i) as HTMLInputElement;
    expect(input.multiple).toBe(true);
  });

  test("a wrong choice can be backed out of", async () => {
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /upload documents/i }));
    await user.click(screen.getByRole("button", { name: /a different way/i }));

    expect(screen.getByRole("button", { name: /type or paste/i })).toBeTruthy();
    expect(screen.queryByLabelText(/documents \(pdf\)/i)).toBeNull();
  });

  test("going back keeps what was already entered", async () => {
    // Nothing is discarded by changing the answer — it is the same box either
    // way — so the back button needs no warning and must not act like one.
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /type or paste/i }));
    await user.type(notesBox(), "Seen 03/07/2026, acute tonsillitis.");
    await user.click(screen.getByRole("button", { name: /a different way/i }));
    await user.click(screen.getByRole("button", { name: /upload documents/i }));

    expect((notesBox() as HTMLTextAreaElement).value).toContain("acute tonsillitis");
  });
});

describe("attaching documents", () => {
  async function chooseUpload(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /upload documents/i }));
    return screen.getByLabelText(/documents \(pdf\)/i);
  }

  test("the extracted text lands in the box for checking", async () => {
    // Shown, not sent onward. A PDF's text layer is not always what the page
    // looks like, and this box is what redaction searches through.
    vi.mocked(extractNote).mockResolvedValue("Dx acute tonsillitis. MC 2 days.");
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.upload(await chooseUpload(user), pdf("discharge.pdf"));
    await waitFor(() =>
      expect((notesBox() as HTMLTextAreaElement).value).toContain("acute tonsillitis"),
    );
  });

  test("several documents are read, and all of them are kept", async () => {
    // A discharge summary, an operation record and a referral are one
    // consultation's worth of evidence. Making the doctor choose between them
    // means the mapper answering from a fraction of what they have.
    vi.mocked(extractNote)
      .mockResolvedValueOnce("Discharge summary text.")
      .mockResolvedValueOnce("Operation record text.");
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.upload(await chooseUpload(user), [
      pdf("discharge.pdf"),
      pdf("operation.pdf"),
    ]);

    await waitFor(() => expect(extractNote).toHaveBeenCalledTimes(2));
    const value = (notesBox() as HTMLTextAreaElement).value;
    expect(value).toContain("Discharge summary text.");
    expect(value).toContain("Operation record text.");
  });

  test("each attachment is listed by name", async () => {
    vi.mocked(extractNote).mockResolvedValue("text");
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.upload(await chooseUpload(user), [
      pdf("discharge.pdf"),
      pdf("referral.pdf"),
    ]);
    expect(await screen.findByText("discharge.pdf")).toBeTruthy();
    expect(screen.getByText("referral.pdf")).toBeTruthy();
  });

  test("one unreadable document does not cost the others", async () => {
    vi.mocked(extractNote)
      .mockRejectedValueOnce(new Error("There is no readable text in that PDF."))
      .mockResolvedValueOnce("Operation record text.");
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.upload(await chooseUpload(user), [pdf("scan.pdf"), pdf("operation.pdf")]);

    expect(await screen.findByText(/scan\.pdf: .*no readable text/i)).toBeTruthy();
    await waitFor(() =>
      expect((notesBox() as HTMLTextAreaElement).value).toContain(
        "Operation record text.",
      ),
    );
  });

  test("an attachment is added to what was typed, never over it", async () => {
    vi.mocked(extractNote).mockResolvedValue("Discharge summary text.");
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /type or paste/i }));
    await user.type(notesBox(), "Typed consultation.");
    await user.click(screen.getByRole("button", { name: /a different way/i }));
    await user.upload(await chooseUpload(user), pdf("discharge.pdf"));

    await waitFor(() =>
      expect((notesBox() as HTMLTextAreaElement).value).toContain("Discharge summary"),
    );
    expect((notesBox() as HTMLTextAreaElement).value).toContain("Typed consultation.");
  });
});

describe("checking where the boxes are, on a form read from a scan", () => {
  test("a scanned form offers the check, and says why", async () => {
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);
    await sendForm(user, { fill_mode: "overlay" });

    expect(screen.getByText(/that form is a scan/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /where the answers will go/i }),
    ).toBeTruthy();
  });

  test("a fillable form does not offer it", async () => {
    // Its PDF stated where its own boxes are. An offer to check something that
    // cannot be wrong teaches the doctor to click past the one that can.
    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);
    await sendForm(user, { fill_mode: "acroform" });
    expect(screen.queryByText(/that form is a scan/i)).toBeNull();
  });

  test("the proof sheet is fetched for the form that was uploaded", async () => {
    vi.mocked(formProof).mockResolvedValue(
      new Blob(["%PDF-"], { type: "application/pdf" }),
    );
    globalThis.URL.createObjectURL = vi.fn(() => "blob:proof");
    globalThis.URL.revokeObjectURL = vi.fn();
    const open = vi.fn();
    vi.stubGlobal("open", open);

    const user = userEvent.setup();
    render(<PatientForm onSubmit={vi.fn()} />);
    await sendForm(user, { fill_mode: "overlay" });
    await user.click(screen.getByRole("button", { name: /where the answers will go/i }));

    await waitFor(() => expect(formProof).toHaveBeenCalledWith(uploaded().form_id));
    // A tab, not a download: putting it in Downloads beside the real filled
    // forms invites printing and signing the wrong one.
    expect(open).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("what still has to be true before anything is mapped", () => {
  test("the form is named among what is still missing", () => {
    render(<PatientForm onSubmit={vi.fn()} />);
    const submit = screen.getByRole("button", { name: /read the notes/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/still needed/i).textContent).toContain(
      "the blank insurance form",
    );
  });

  test("a complete claim reaches onSubmit with the uploaded form and typed insurer", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PatientForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/insurer/i), "Prudential");
    await sendForm(user);

    await user.click(screen.getByRole("button", { name: /type or paste/i }));
    await user.type(notesBox(), "Seen 03/07/2026, acute tonsillitis.");

    await user.type(screen.getByLabelText(/patient name/i), "Synthetic Patient");
    await user.type(screen.getByLabelText(/nric/i), "S8012345D");
    await user.type(screen.getByLabelText(/date of birth/i), "1978-03-14");
    await user.click(screen.getByRole("button", { name: /read the notes/i }));

    expect(onSubmit).toHaveBeenCalled();
    const [formId, patient] = onSubmit.mock.calls[0];
    expect(formId).toBe(uploaded().form_id);
    expect(patient.insurer).toBe("Prudential");
    expect(patient.clinical_text).toContain("acute tonsillitis");
  });
});
