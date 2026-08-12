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
import Landing, {
  DEMO_VIDEO,
  DEMO_VIDEO_POSTER,
  DOWNLOAD_URL,
  HERO_SHOT,
  subscribeUrl,
} from "./Landing";

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
      screen.getByRole("heading", { level: 1, name: /you already wrote this/i }),
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
    // Said twice on purpose since the redesign: once in the hero trust line,
    // once in the privacy section. getAllByText, because getByText throws on
    // more than one match and the duplication is the point.
    expect(screen.getAllByText(/never reach the model/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/pulled out by pattern matching — no AI involved/i),
    ).toBeDefined();
  });

  test("the hero does not claim the data stays on the doctor's machine", () => {
    // The redesign's own line was "Nothing leaves your browser". It is false:
    // the paste goes to the backend, which is where the identifiers are found
    // and the note is scrubbed. Claiming otherwise on a page a Chrome Web
    // Store reviewer reads would contradict the listing's own disclosures.
    const { container } = render(<Landing />);
    expect(container.textContent).not.toMatch(
      /nothing leaves your browser|everything stays (inside|in) your browser|stays on your (machine|computer)/i,
    );
  });

  test("it does not claim to be free or open source", () => {
    const { container } = render(<Landing />);
    expect(container.textContent).not.toMatch(/open source/i);
  });

  test("it does not promise features the extension does not have", () => {
    // All three came from the redesign template: a save/remember prompt that
    // would need chrome.storage, and iframe and shadow-DOM support that are
    // open questions rather than shipped behaviour.
    const { container } = render(<Landing />);
    expect(container.textContent).not.toMatch(
      /remember this answer|saved responses|browser storage|iframes|shadow dom/i,
    );
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

  test("it does not tell doctors to withhold real notes", () => {
    // Superseded by the owner's call on 2026-08-06: real consultation notes
    // are in scope, and the privacy policy discloses the transfer instead of
    // forbidding the data. Copy still telling a doctor to anonymise first
    // would describe a product that no longer exists — and would be
    // incoherent beside a page asking them to pay for it.
    render(<Landing />);
    const body = document.body.textContent!;
    expect(body).not.toMatch(/synthetic or anonymised|anonymise (the note|it) first/i);
  });

  test("the free download says what it will cost, where the download is", () => {
    // The contradiction this closes: a free download sitting beside a
    // 200/month price, with nothing saying how the two relate. A doctor
    // should not have to work out whether they are about to be charged.
    //
    // Scoped to the section holding the download button on purpose. Asserting
    // "the page mentions 200 somewhere" would pass on the pricing section
    // alone and prove nothing about the offer next to the button.
    const { container } = render(<Landing />);
    const cta = container.querySelector(".final-cta")!;
    expect(cta).not.toBeNull();
    expect(cta.textContent).toMatch(/pilot/i);
    expect(cta.textContent).toMatch(/200/);
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

  test("with no payment link configured there is no button to press", () => {
    // A control that looks live and does nothing is worse than no control, and
    // worst of all on the one that takes money. This is the state today.
    expect(subscribeUrl()).toBe("");
    render(<Landing />);
    expect(screen.queryByRole("link", { name: /^subscribe$/i })).toBeNull();
    expect(screen.getByText(/subscriptions open when/i)).toBeDefined();
  });

  test("once configured, Subscribe points at the payment link", () => {
    vi.stubEnv("VITE_STRIPE_PAYMENT_LINK", "https://buy.stripe.com/test_123");
    try {
      expect(subscribeUrl()).toBe("https://buy.stripe.com/test_123");
      render(<Landing />);
      const subscribe = screen.getByRole("link", { name: /^subscribe$/i });
      expect(subscribe.getAttribute("href")).toBe("https://buy.stripe.com/test_123");
    } finally {
      vi.unstubAllEnvs();
    }
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

// ---------------------------------------------------------------------------
// The three pieces from the design that carry assets or motion
// ---------------------------------------------------------------------------

describe("hero shot, scroll demo and video", () => {
  test("the hero falls back to the built mock rather than an empty box", () => {
    // HERO_SHOT is unset until the owner drops a screenshot in, and a landing
    // page whose main visual is a grey rectangle is worse than one whose
    // visual is drawn from markup.
    const { container } = render(<Landing />);
    expect(HERO_SHOT).toBe("");
    expect(container.querySelector(".shot-frame")).not.toBeNull();
    expect(container.querySelector(".mock")).not.toBeNull();
    // ...and exactly one address bar. The frame draws its own chrome only
    // around a real screenshot; the mock already has one, and rendering both
    // stacked two URL bars on top of each other.
    expect(container.querySelector(".shot-chrome")).toBeNull();
    expect(container.querySelectorAll(".shot-frame .url")).toHaveLength(1);
  });

  test("the video area says where to put the file", () => {
    render(<Landing />);
    expect(screen.getByText(/demo video goes here/i)).toBeDefined();
    expect(document.querySelector(".video-frame video")).toBeNull();
  });

  test("no asset is loaded from another origin", () => {
    // Both slots take a path under frontend/public. A YouTube embed or a CDN
    // image would break the privacy argument the page makes two sections up.
    for (const url of [HERO_SHOT, DEMO_VIDEO, DEMO_VIDEO_POSTER]) {
      expect(url.startsWith("http")).toBe(false);
    }
  });

  test("the scroll demo renders its finished state when it cannot measure", () => {
    // jsdom has no layout, so progress stays 0 and the section shows its
    // first stage. What must not happen is a crash or an empty panel: the
    // rows and the stage copy are present either way.
    const { container } = render(<Landing />);
    const demo = container.querySelector("#demo");
    expect(demo).not.toBeNull();
    expect(demo!.querySelectorAll(".scroll-demo-rows li")).toHaveLength(5);
    expect(demo!.textContent).toMatch(/of 5 answered/);
  });

  test("the scroll demo never claims a form was submitted", () => {
    const { container } = render(<Landing />);
    expect(container.querySelector("#demo")!.textContent).toMatch(/nothing submitted/i);
  });
});

describe("the closing region", () => {
  test("the call to action and the footer share one dark band", () => {
    const { container } = render(<Landing />);
    const closing = container.querySelector(".closing")!;
    expect(closing).not.toBeNull();
    expect(closing.querySelector(".final-cta")).not.toBeNull();
    expect(closing.querySelector(".footer")).not.toBeNull();
  });

  test("the wordmark is decoration and is hidden from assistive tech", () => {
    const { container } = render(<Landing />);
    const mark = container.querySelector(".closing-wordmark")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
  });

  test("the footer links to the privacy policy and invents nothing else", () => {
    // The reference had "Terms" beside Privacy. There is no terms page, and a
    // link to one that does not exist is worse on this page than one fewer
    // link — the Web Store listing points a reviewer straight at this footer.
    const { container } = render(<Landing />);
    const links = [...container.querySelectorAll(".footer-links a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/privacy"]);
    expect(container.querySelector(".footer")!.textContent).not.toMatch(/terms/i);
  });
});
