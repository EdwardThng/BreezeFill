/**
 * The landing page.
 *
 * Most of this page is copy, and copy does not need tests. What is tested is
 * the part that would be quietly wrong: the claims it makes. This product's
 * pitch is that it *refuses* things — it never submits, it leaves fields blank
 * rather than guess, identifiers never reach the model — and a marketing page
 * is exactly where those get softened into something more impressive and less
 * true. These tests fail if that happens.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import App, { routeOf } from "./App";
import Landing, { DOWNLOAD_URL, SUBSCRIBE_URL } from "./Landing";

describe("routing", () => {
  test.each([
    ["", "landing"],
    ["#/", "landing"],
    ["#", "landing"],
    ["#/demo", "demo"],
    ["#demo", "demo"],
    ["#/app", "app"],
    ["#/nonsense", "landing"],
  ])("%s -> %s", (hash, expected) => {
    expect(routeOf(hash)).toBe(expected);
  });

  test("the front door is the landing page, not the claim form", () => {
    window.location.hash = "";
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: /insurance forms, filled/i }),
    ).toBeDefined();
  });

  test("the claim form is still reachable, just not advertised", () => {
    // Deleting it would have taken the five PDF forms with it.
    window.location.hash = "#/app";
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: /breezefill/i })).toBeDefined();
    window.location.hash = "";
  });
});

describe("what the page promises", () => {
  test("it says it never submits", () => {
    render(<Landing />);
    const matches = screen.getAllByText(/never (submits|press(es)? submit)|you submit/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  test("it says identifiers do not reach the model", () => {
    render(<Landing />);
    expect(screen.getByText(/never reach the model/i)).toBeDefined();
    expect(
      screen.getByText(/pulled out by pattern matching — no AI involved/i),
    ).toBeDefined();
  });

  test("it promises blanks rather than guesses", () => {
    render(<Landing />);
    expect(screen.getByRole("heading", { name: /blanks over guesses/i })).toBeDefined();
  });

  test("it does not claim to fill forms automatically end to end", () => {
    // The failure mode this guards is a rewrite that promises what the
    // software deliberately will not do. "Fully automatic" is a claim a
    // doctor would test on their first claim and find false.
    const { container } = render(<Landing />);
    expect(container.textContent).not.toMatch(/fully automatic|zero effort|no review needed/i);
  });

  test("it is honest that the model is not yet in Singapore", () => {
    render(<Landing />);
    expect(screen.getByText(/runs outside Singapore/i)).toBeDefined();
  });

  test("it is honest that this is not a Web Store install", () => {
    render(<Landing />);
    expect(screen.getByText(/not on the Chrome Web Store yet/i)).toBeDefined();
  });
});

describe("the ways out of the page", () => {
  test("download links point at the extension bundle", () => {
    render(<Landing />);
    const downloads = screen.getAllByRole("link", { name: /download for chrome/i });
    expect(downloads.length).toBeGreaterThan(0);
    for (const link of downloads) {
      expect(link.getAttribute("href")).toBe(DOWNLOAD_URL);
      // Without this the browser navigates to the zip instead of saving it.
      expect(link.hasAttribute("download")).toBe(true);
    }
  });

  test("there is a route into the demo", () => {
    render(<Landing />);
    const toDemo = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "#/demo");
    expect(toDemo.length).toBeGreaterThan(0);
  });

  test("no image or script is loaded from anywhere else", () => {
    // A page about not leaking patient data should not be phoning a CDN or an
    // analytics host on the doctor's machine.
    const { container } = render(<Landing />);
    for (const el of container.querySelectorAll("img, script, iframe")) {
      const src = el.getAttribute("src") || "";
      expect(src.startsWith("http")).toBe(false);
    }
  });

  test("the page needs no backend to render", () => {
    // It is served from an app that now sleeps when idle. A hero that waits
    // on /forms would show a doctor an error before it showed them anything.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    render(<Landing />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("structure", () => {
  test("one h1, and the sections a visitor navigates by", () => {
    const { container } = render(<Landing />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    for (const id of ["how", "privacy", "faq"]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  test("the nav links resolve to sections that exist", () => {
    const { container } = render(<Landing />);
    const nav = container.querySelector("nav")!;
    const anchors = within(nav)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href") || "")
      .filter((href) => href.startsWith("#") && !href.startsWith("#/"));
    expect(anchors.length).toBeGreaterThan(0);
    for (const href of anchors) {
      expect(container.querySelector(href)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
//
// The page now asks for money, which raises the bar on every claim it makes.
// These pin the parts that would be dishonest to get wrong: what it costs, and
// that subscribing does not quietly become a promise the product does not keep.

describe("pricing", () => {
  test("the price and the period are both stated", () => {
    render(<Landing />);
    const pricing = document.querySelector("#pricing")!;
    expect(pricing).not.toBeNull();
    expect(pricing.textContent).toMatch(/200/);
    expect(pricing.textContent).toMatch(/SGD/i);
    expect(pricing.textContent).toMatch(/month/i);
  });

  test("the subscribe button is a real link when Stripe is configured", () => {
    render(<Landing />);
    const subscribe = screen.getByRole("link", { name: /subscribe/i });
    expect(subscribe.getAttribute("href")).toBe(SUBSCRIBE_URL);
  });

  test("pricing is reachable from the nav", () => {
    const { container } = render(<Landing />);
    const nav = container.querySelector("nav")!;
    const hrefs = within(nav)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("#pricing");
  });

  test("it does not claim the subscription buys a different product", () => {
    // The refusals are the product, and they do not change with money. Copy
    // implying a paid tier fills more fields, or reviews less, would be
    // selling exactly what the software declines to do.
    render(<Landing />);
    const pricing = document.querySelector("#pricing")!.textContent!;
    expect(pricing).not.toMatch(/unlimited fields|fills everything|no review|fully automatic/i);
  });
});
