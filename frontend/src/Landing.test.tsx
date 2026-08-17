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

import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import App, { routeOf } from "./App";
import Landing, {
  DEMO_VIDEO,
  DEMO_VIDEO_POSTER,
  DOWNLOAD_URL,
  GET_ROUTE,
  HERO_SHOT,
  STORE_URL,
  subscribeUrl,
} from "./Landing";
import Subscribe, { sessionOf } from "./Subscribe";

describe("routing", () => {
  test.each([
    ["", "landing"],
    ["#/", "landing"],
    ["#", "landing"],
    ["#/demo", "demo"],
    ["#demo", "demo"],
    ["#/app", "app"],
    ["#/get", "get"],
    // Stripe returns with a query on the hash; the route must survive it.
    ["#/get?paid=1", "get"],
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

  test("it no longer says the listing is pending", () => {
    // It was published on 2026-08-17. The page carried "Not on the Chrome Web
    // Store yet" and "listing coming soon" for a while afterwards, which is
    // the kind of staleness a marketing page hides well: nothing breaks, it
    // just tells every visitor something false about how to install.
    render(<Landing />);
    const body = document.body.textContent!;
    expect(body).not.toMatch(/not on the Chrome Web Store yet/i);
    expect(body).not.toMatch(/listing coming soon/i);
    expect(body).not.toMatch(/installs by hand/i);
  });

  test("the price is not triggered by an event that has already happened", () => {
    // The trap this closes. The copy said the price starts "when it reaches
    // the Chrome Web Store" — true while that was in the future, and on the
    // day it shipped it started reading as "you are being charged from
    // today", beside a pricing card with no Subscribe button on it.
    render(<Landing />);
    const body = document.body.textContent!;
    expect(body).not.toMatch(/when it reaches the Chrome Web Store/i);
  });
});

describe("the ways out of the page", () => {
  test("every way in goes through the subscribe page, not straight to the store", () => {
    // One funnel. These used to point at the zip with a `download` attribute;
    // now they point at #/get, so the price is read before the install rather
    // than discovered after it. A link straight to STORE_URL anywhere on the
    // landing page would route around the one page that states the price.
    render(<Landing />);
    const gets = screen.getAllByRole("link", { name: /get breezefill|subscribe/i });
    expect(gets.length).toBeGreaterThan(0);
    for (const link of gets) {
      expect(link.getAttribute("href")).toBe(GET_ROUTE);
      // A hash route is navigated to, never saved.
      expect(link.hasAttribute("download")).toBe(false);
    }
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain(STORE_URL);
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
    expect(screen.getByText(/subscriptions are not open yet/i)).toBeDefined();
  });

  test("once configured, Subscribe goes to the funnel rather than to Stripe", () => {
    // Deliberately NOT straight to checkout. #/get is where the price, the
    // install step and the paragraph about what a subscription does not do all
    // live, and a card that jumped past it would take a doctor to a payment
    // form having told them none of it. The Stripe link is reached from there
    // — see the #/get tests.
    vi.stubEnv("VITE_STRIPE_PAYMENT_LINK", "https://buy.stripe.com/test_123");
    try {
      expect(subscribeUrl()).toBe("https://buy.stripe.com/test_123");
      render(<Landing />);
      const subscribe = screen.getByRole("link", { name: /^subscribe$/i });
      expect(subscribe.getAttribute("href")).toBe(GET_ROUTE);
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
    const mark = container.querySelector(".closing-mark")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    // The logo sits with the word rather than being a second thing to read.
    const img = mark.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/website-logo-128.png");
    expect(mark.textContent).toBe("breezefill");
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

/**
 * The subscribe-then-install funnel.
 *
 * The tests that matter here are not about layout. They are about what the
 * page CLAIMS, on the one screen where a doctor is deciding whether to hand
 * over a card — and about the honesty of the arrangement, because the gate
 * this page implies does not exist yet.
 */
// Only the two subscription calls are replaced. Mocking the whole module
// would take getForms with it, and ClaimApp — rendered by the routing tests
// above — imports that.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openCheckout: vi.fn(async () => "https://checkout.stripe.com/c/pay/cs_live_x"),
  claimLicence: vi.fn(async () => "eyJzdWIiOiJzdWJfMSJ9.sig"),
}));
// eslint-disable-next-line import/first
import { claimLicence, openCheckout } from "./api";

/**
 * The subscribe-then-install funnel.
 *
 * What matters here is not layout. It is where the gate actually sits — on a
 * licence the SERVER signed, never on anything the URL claims — and what the
 * page says to a doctor who is about to hand over a card.
 */
describe("#/get", () => {
  const at = async (hash: string) => {
    window.location.hash = hash;
    const result = render(<Subscribe />);
    // Let the claim promise settle before anything is asserted.
    await act(async () => {});
    return result;
  };

  beforeEach(() => {
    vi.mocked(openCheckout).mockClear();
    vi.mocked(claimLicence).mockClear();
    vi.mocked(claimLicence).mockResolvedValue("eyJzdWIiOiJzdWJfMSJ9.sig");
  });

  test("reads a Stripe session id off the hash, and only a real one", () => {
    // A `cs_…` is minted by Stripe and cannot be guessed. The old `?paid=1`
    // was a string anyone could type, which was tolerable while this page was
    // a funnel and is not now that it hands out a credential.
    expect(sessionOf("#/get?session_id=cs_live_abc123")).toBe("cs_live_abc123");
    expect(sessionOf("#/get?session_id=cs_test_9")).toBe("cs_test_9");
    expect(sessionOf("#/get")).toBe("");
    expect(sessionOf("#/get?paid=1")).toBe("");
    expect(sessionOf("#/get?session_id=nonsense")).toBe("");
  });

  test("Subscribe opens a checkout the server created", async () => {
    // Never a client-built Stripe URL: the price, the quantity and the return
    // address are all decided server-side where a caller cannot reach them.
    await at("#/get");
    screen.getByRole("button", { name: /subscribe/i }).click();
    await act(async () => {});
    expect(openCheckout).toHaveBeenCalled();
  });

  test("the install step is shut until a payment is confirmed", async () => {
    await at("#/get");
    expect(screen.queryByRole("link", { name: /download breezefill/i })).toBeNull();
    expect(screen.getByText(/available once your subscription is confirmed/i)).toBeDefined();
  });

  test("a session id alone does not open it — the server has to sign", async () => {
    // THE GATE, in one test. If this ever passes with a rejected claim, the
    // page is handing out the product to anyone who can type a URL.
    vi.mocked(claimLicence).mockRejectedValue(new Error("That checkout has not been paid."));
    await at("#/get?session_id=cs_live_forged");

    expect(screen.queryByRole("link", { name: /download breezefill/i })).toBeNull();
    expect(screen.getByText(/has not been paid/i)).toBeDefined();
  });

  test("a confirmed payment shows the licence and opens the install", async () => {
    await at("#/get?session_id=cs_live_ok");

    expect(claimLicence).toHaveBeenCalledWith("cs_live_ok");
    expect(screen.getByText("eyJzdWIiOiJzdWJfMSJ9.sig")).toBeDefined();
    expect(
      screen.getByRole("link", { name: /download breezefill/i }).getAttribute("href"),
    ).toBe(DOWNLOAD_URL);
  });

  test("the licence is called a credential where it is handed over", async () => {
    // It is pasted into panels and quoted in support email. The one moment a
    // doctor is looking at it is the only chance to say what it is.
    await at("#/get?session_id=cs_live_ok");
    expect(document.body.textContent).toMatch(/credential/i);
  });

  test("a failed claim is never a dead end", async () => {
    vi.mocked(claimLicence).mockRejectedValue(new Error("That checkout was not found."));
    await at("#/get?session_id=cs_live_missing");
    expect(screen.getByRole("button", { name: /try again/i })).toBeDefined();
  });

  test("it does not claim the extension is already locked", async () => {
    // THE HONESTY TEST. FORMFILL_REQUIRE_LICENCE is off, so a copy obtained
    // another way still works, and a page that implied otherwise would be
    // selling something the reader could have had free. When the flag goes on,
    // this is the test that should be revisited deliberately.
    await at("#/get?session_id=cs_live_ok");
    const body = document.body.textContent!;
    expect(body).toMatch(/enforcement is being switched on/i);
    expect(body).toMatch(/will still work/i);
    expect(body).toMatch(/not going to backdate/i);
  });

  test("there is a way back to the page that explains the product", async () => {
    await at("#/get");
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("#/");
  });
});
