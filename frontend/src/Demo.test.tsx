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
const panel = () => screen.getByLabelText("BreezeFill side panel");

/** Walk to a step by clicking, confirming on the way if the demo asks. */
async function advanceTo(stepNumber: number) {
  const user = userEvent.setup();
  while (!screen.queryByText(`Step ${stepNumber} of 6`)) {
    if (next().hasAttribute("disabled")) {
      // More than one row can be waiting — an inference and a date are held
      // for different reasons — so clear whatever is outstanding.
      for (const button of screen.getAllByRole("button", { name: /^Confirm / })) {
        await user.click(button);
      }
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
    expect(within(panel()).getByText(/click the breezefill icon/i)).toBeDefined();
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
    expect(rows.getByText(/CT abdomen 03\/07\/2026: acute appendicitis/)).toBeDefined();
    expect(rows.getAllByText(/quoted from your note/i).length).toBeGreaterThan(0);
  });
});

describe("what the demo refuses to skip", () => {
  test("you cannot reach the fill step without confirming what is held", async () => {
    const user = userEvent.setup();
    // Steps 1-4 advance freely.
    for (let i = 0; i < 4; i += 1) await user.click(next());
    expect(screen.getByText(/Step 5 of 6/)).toBeDefined();

    // Step 5 is the review, and it is a wall until both held rows are taken.
    expect(next()).toHaveProperty("disabled", true);
    expect(screen.getByText(/Confirm all 2 answers/i)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Confirm ICD-10 code" }));
    expect(next()).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "Confirm Date of admission" }));
    expect(next()).toHaveProperty("disabled", false);
  });

  test("the inference and the date are the rows asking to be confirmed", async () => {
    await advanceTo(5);
    // A quoted value needs no click; a missing one has nothing to accept.
    // A date does, however cleanly the note stated it — 03/07 is 3 July here
    // and 7 March in half the world's software, and the note cannot say which.
    expect(within(panel()).getAllByRole("button", { name: /^Confirm / })).toHaveLength(2);
    expect(within(panel()).getByText(/inferred — confirm this/i)).toBeDefined();
    expect(within(panel()).getByText(/day and month are the right way round/i)).toBeDefined();
  });

  test("the held date is green and quoted, and still not written", async () => {
    // The row exists to show that "the note said so" is not the end of the
    // question. If it ever renders as amber, the demo has quietly turned it
    // into an ordinary inference and stopped making that point.
    await advanceTo(5);
    const row = within(panel()).getByText("Date of admission").closest(".demo-row");
    expect(row?.querySelector(".pill")?.className).toContain("green");
    expect(row?.querySelector("button")).not.toBeNull();
  });

  test("the demo's date is one the product would actually stop on", async () => {
    // The rule only holds a date whose day could also be a month, so a
    // walkthrough dated 14/03 would illustrate a stop that never happens.
    // Guarding the day rather than the literal date, so the note can be
    // rewritten without quietly losing the demonstration.
    await advanceTo(5);
    const row = within(panel()).getByText("Date of admission").closest(".demo-row");
    const shown = row?.querySelector(".demo-row-value")?.textContent ?? "";
    const day = Number(shown.split("/")[0]);

    expect(day).toBeGreaterThan(0);
    expect(day).toBeLessThanOrEqual(12);
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
    expect(submit.textContent).toMatch(/you do this, not breezefill/i);
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
    expect(links).toContain("/download/breezefill-extension.zip");
    expect(links).toContain("#/");
  });
});
