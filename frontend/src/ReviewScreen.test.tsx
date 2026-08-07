/**
 * The review screen, and specifically the rows it refuses to let through.
 *
 * The screen's whole job is to be the thing a doctor reads before they sign
 * something. Two properties are worth pinning:
 *
 *   - a date is checked one at a time, whatever status it carries, because
 *     "the notes said 03/07" does not say whether that was 3 July or 7 March;
 *   - "Confirm all" cannot reach one, because a bulk button confirms a
 *     swapped date exactly as fast as a correct one.
 *
 * Everything else here is the existing behaviour those two had to not break.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ReviewScreen, { readableDate } from "./ReviewScreen";
import type { ClaimResponse, MappedField } from "./types";

const row = (over: Partial<MappedField>): MappedField => ({
  field_id: "f",
  pdf_field_name: "F",
  field_type: "text",
  label: "A field",
  help: null,
  value: "something",
  status: "extracted",
  source: null,
  needs_review: false,
  recheck: null,
  // The server always sends this (it defaults to [] on MappedField), so the
  // type requires it and the default here matches a free-text row.
  options: [],
  ...over,
});

const ADMISSION = row({
  field_id: "date_of_admission",
  field_type: "date",
  label: "Date of admission",
  value: "03/07/2026",
  status: "extracted",
  needs_review: true,
  recheck: "Check the day and month are the right way round.",
});

const INFERRED = row({
  field_id: "icd_code",
  label: "ICD-10 code",
  value: "K35.80",
  status: "inferred",
  needs_review: true,
});

function show(fields: MappedField[]) {
  const onApprove = vi.fn();
  const claim: ClaimResponse = { form_id: "aia_ghs_claim", fields };
  render(
    <ReviewScreen
      claim={claim}
      busy={false}
      error={null}
      onApprove={onApprove}
      onDiscard={vi.fn()}
    />,
  );
  return { onApprove, user: userEvent.setup() };
}

const generate = () => screen.getByRole("button", { name: /Generate the filled form/ });

describe("a date answer", () => {
  test("is held for checking even when it came straight from the notes", () => {
    show([ADMISSION]);

    expect(screen.getByText("From your notes")).toBeDefined();
    expect(generate().hasAttribute("disabled")).toBe(true);
  });

  test("says what to check, not that there is nothing to check", () => {
    show([ADMISSION]);

    expect(screen.getByText(/day and month are the right way round/)).toBeDefined();
    // The status note it replaced. Showing it here would be worse than showing
    // nothing: it tells the doctor the value is already trustworthy.
    expect(screen.queryByText("Copied from what you wrote.")).toBeNull();
  });

  test("spells itself out, and names the date it might have been instead", () => {
    show([ADMISSION]);

    expect(screen.getByText(/3 July 2026 — or 7 March 2026/)).toBeDefined();
  });

  test("releases the form once the doctor confirms it", async () => {
    const { user } = show([ADMISSION]);

    await user.click(screen.getByRole("checkbox", { name: /Confirm this answer/ }));
    expect(generate().hasAttribute("disabled")).toBe(false);
  });
});

describe("Confirm all", () => {
  test("does not reach a date", async () => {
    const { user } = show([ADMISSION, INFERRED]);

    await user.click(screen.getByRole("button", { name: /confirm all 1/i }));

    // The inferred row went; the date did not, so the form is still held.
    expect(generate().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/1 answer still needs your check/)).toBeDefined();
  });

  test("counts only what it will actually confirm", () => {
    show([ADMISSION, INFERRED]);

    // Two rows need checking, one of them by hand. A button offering to clear
    // "all 2" and clearing one is worse than a smaller number.
    expect(screen.getByText(/2 answers still need your check/)).toBeDefined();
    expect(screen.getByRole("button", { name: /confirm all 1/i })).toBeDefined();
  });

  test("is not offered when every remaining row must be read one at a time", () => {
    show([ADMISSION]);

    expect(screen.queryByRole("button", { name: /confirm all/i })).toBeNull();
  });
});

describe("readableDate", () => {
  test("offers the rival reading only when the day could be a month", () => {
    expect(readableDate("03/07/2026")).toContain("7 March 2026");
    expect(readableDate("25/07/2026")).toBe("25 July 2026");
  });

  test("never invents a century", () => {
    expect(readableDate("03/07/26")).toContain("3 July 26");
    expect(readableDate("03/07/26")).not.toContain("2026");
  });

  test("says nothing about anything that is not a date", () => {
    for (const value of ["", "next Tuesday", "2026-07-03", "32/07/2026", "03/13/2026"]) {
      expect(readableDate(value)).toBe("");
    }
    expect(readableDate(null)).toBe("");
    expect(readableDate(true)).toBe("");
  });
});
