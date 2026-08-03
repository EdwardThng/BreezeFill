/**
 * The interactive demo.
 *
 * A demo is a promise about the product, so these tests are mostly about it
 * not promising more than the software does. The two that matter:
 *
 *   - it cannot be advanced past the review step without confirming the
 *     inferred value, because the real panel cannot either;
 *   - the field the note does not answer stays empty in the filled form.
 *
 * A demo that quietly skipped either would teach a doctor the wrong thing
 * about what they are signing, which is worse than having no demo.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import Demo from "./Demo";

const next = () => screen.getByRole("button", { name: "Next" });
const stage = () => screen.getByLabelText("The insurer's form");
const panel = () => screen.getByLabelText("ClaimFill side panel");

/** Walk to a step by clicking, confirming on the way if the demo asks. */
async function advanceTo(stepNumber: number) {
  const user = userEvent.setup();
  while (!screen.queryByText(`Step ${stepNumber} of 6`)) {
    if (next().hasAttribute("disabled")) {
      await user.click(screen.getByRole("button", { name: "Confirm" }));
    }
    await user.click(next());
  }
  return user;
}

beforeEach(() => {
  render(<Demo />);
});

describe("it is obviously a demo", () => {
  test("the patient is declared invented, up front", () => {
    expect(screen.getByText(/does not exist/i)).toBeDefined();
    expect(screen.getByRole("note")).toBeDefined();
  });

  test("it contacts nothing", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await advanceTo(6);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the walkthrough", () => {
  test("starts with a panel that has no access to anything", () => {
    expect(screen.getByText(/Step 1 of 6/)).toBeDefined();
    expect(within(panel()).getByText(/click the claimfill icon/i)).toBeDefined();
    // Nothing pasted, nothing proposed, nothing filled.
    expect(within(panel()).queryByText(/patient details/i)).toBeNull();
  });

  test("the demographics appear before any mapping happens", async () => {
    await advanceTo(3);
    expect(within(panel()).getByText("S7211043C")).toBeDefined();
    // The ordering IS the privacy argument: identifiers are known first,
    // because they are what the note is scrubbed against.
    expect(within(panel()).getByText(/never sent to the model/i)).toBeDefined();
    expect(within(panel()).queryByText(/quoted from your note/i)).toBeNull();
  });

  test("the bank is consulted, and says which form it recognised", async () => {
    await advanceTo(4);
    expect(within(panel()).getByText(/group hospital & surgical/i)).toBeDefined();
  });

  test("proposed values carry their source", async () => {
    await advanceTo(5);
    // Scoped to the review list, because the same sentence is also sitting in
    // the paste box above it — which is the point: the quote is lifted out of
    // the note the doctor pasted, not composed.
    const rows = within(panel().querySelector(".demo-rows") as HTMLElement);
    expect(rows.getByText(/CT abdomen 14\/03\/2026: acute appendicitis/)).toBeDefined();
    expect(rows.getAllByText(/quoted from your note/i).length).toBeGreaterThan(0);
  });
});

describe("what the demo refuses to skip", () => {
  test("you cannot reach the fill step without confirming the inferred value", async () => {
    const user = userEvent.setup();
    // Steps 1-4 advance freely.
    for (let i = 0; i < 4; i += 1) await user.click(next());
    expect(screen.getByText(/Step 5 of 6/)).toBeDefined();

    // Step 5 is the review, and it is a wall until the amber row is accepted.
    expect(next()).toHaveProperty("disabled", true);
    expect(screen.getByText(/confirm the amber value/i)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(next()).toHaveProperty("disabled", false);
  });

  test("the inferred row is the only one asking to be confirmed", async () => {
    await advanceTo(5);
    // Quoted values do not need a click; a missing one has nothing to accept.
    expect(within(panel()).getAllByRole("button", { name: "Confirm" })).toHaveLength(1);
    expect(within(panel()).getByText(/inferred — confirm this/i)).toBeDefined();
  });

  test("the field the note does not answer is left empty in the form", async () => {
    await advanceTo(6);
    const form = stage();
    expect(within(form).getByText("Acute appendicitis")).toBeDefined();
    expect(within(form).getByText("Laparoscopic appendicectomy")).toBeDefined();

    // "Referring doctor" is unanswerable from this note, and the demo shows
    // it staying blank rather than being invented.
    const referring = within(form).getByText("Referring doctor").parentElement!;
    expect(referring.querySelector("output")!.textContent).toBe("");
    expect(referring.querySelector("output")!.className).not.toContain("written");
  });

  test("the submit button is present, disabled, and says why", async () => {
    await advanceTo(6);
    const submit = within(stage()).getByRole("button", { name: /submit claim/i });
    expect(submit).toHaveProperty("disabled", true);
    expect(submit.textContent).toMatch(/you do this, not claimfill/i);
  });
});

describe("getting around", () => {
  test("Back returns to the previous step", async () => {
    const user = userEvent.setup();
    await user.click(next());
    expect(screen.getByText(/Step 2 of 6/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(/Step 1 of 6/)).toBeDefined();
  });

  test("Back is disabled on the first step", () => {
    expect(screen.getByRole("button", { name: "Back" })).toHaveProperty("disabled", true);
  });

  test("the last step offers a restart, which also clears the confirmation", async () => {
    const user = await advanceTo(6);
    await user.click(screen.getByRole("button", { name: /start again/i }));
    expect(screen.getByText(/Step 1 of 6/)).toBeDefined();

    // If the confirmation survived a restart, a second run through would sail
    // past the one step the demo exists to make you notice.
    for (let i = 0; i < 4; i += 1) await user.click(next());
    expect(next()).toHaveProperty("disabled", true);
  });

  test("there is a way to the download and back to the landing page", () => {
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("/download/claimfill-extension.zip");
    expect(links).toContain("#/");
  });
});
