/**
 * @vitest-environment jsdom
 *
 * Does `hidden` actually hide?
 *
 * Every other test in this directory asserts on `el.hidden`, which is a
 * property assignment that always succeeds. Whether the element then leaves
 * the screen is decided by the stylesheet, and the stylesheet is not loaded by
 * any of them — so a panel with `hidden = true` set correctly everywhere and a
 * `display` rule that overrides it passes the whole suite while showing the
 * doctor something the code believes is gone.
 *
 * That is exactly what happened to the "Back to N mapped answers" button:
 * `.back-to-review { display: flex }` is author-origin and the browser's
 * `[hidden] { display: none }` is user-agent origin, so the author rule wins
 * and the attribute did nothing. Three fixes to the state that controls the
 * button all landed, all passed, and the button never moved.
 *
 * So this file loads panel.css for real and asks the only question that
 * matters: for each thing the panel hides, does the computed display go to
 * none. The list is derived from the markup and the source rather than typed
 * out, because a hand-kept list would not have contained the button either.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = readFileSync(resolve(HERE, "panel.html"), "utf8");
const PANEL_CSS = readFileSync(resolve(HERE, "panel.css"), "utf8");
const PANEL_JS = readFileSync(resolve(HERE, "panel.js"), "utf8");

/**
 * The panel, with its stylesheet actually applied.
 *
 * jsdom does not fetch the <link>, so the CSS is inlined in its place. Reading
 * the same file the extension ships means a rule added to panel.css is covered
 * the moment it is written.
 */
function panel() {
  document.documentElement.innerHTML = PANEL_HTML.replace(
    /<link[^>]*panel\.css[^>]*>/,
    `<style>${PANEL_CSS}</style>`
  );
  return document;
}

/** Ids the markup ships already hidden. */
function hiddenInMarkup() {
  return [...PANEL_HTML.matchAll(/<[^>]*\shidden[\s>]/g)]
    .map((match) => /id="([\w-]+)"/.exec(match[0]))
    .filter(Boolean)
    .map((match) => match[1]);
}

/**
 * Ids panel.js hides at runtime.
 *
 * Two shapes, because the panel writes both: `$("mapped").hidden = …` directly,
 * and `const rows = $("done-rows"); … rows.hidden = …` through a binding. The
 * second is how `done-rows` and `notepane` are toggled, and a regex that only
 * knew the first would quietly cover less than it appears to.
 */
function hiddenInSource() {
  const found = new Set();
  for (const match of PANEL_JS.matchAll(/\$\("([\w-]+)"\)\.hidden\s*=/g)) {
    found.add(match[1]);
  }
  for (const match of PANEL_JS.matchAll(/const\s+(\w+)\s*=\s*\$\("([\w-]+)"\)/g)) {
    const assigns = new RegExp(`\\b${match[1]}\\.hidden\\s*=`);
    if (assigns.test(PANEL_JS)) found.add(match[2]);
  }
  return [...found];
}

const HIDEABLE = [...new Set([...hiddenInMarkup(), ...hiddenInSource()])].sort();

describe("everything the panel hides can actually be hidden", () => {
  test("the list was derived, not left empty", () => {
    // A regex that stopped matching would turn every assertion below into a
    // loop over nothing, which reads as green.
    expect(HIDEABLE.length).toBeGreaterThan(6);
    expect(HIDEABLE).toContain("back-to-review");
    expect(HIDEABLE).toContain("mapped");
    // Reached only through a binding, so this one proves the second regex
    // above is doing something.
    expect(HIDEABLE).toContain("done-rows");
  });

  test("the stylesheet is really loaded, or nothing here means anything", () => {
    // If the <link> replacement ever stopped matching, every element would
    // compute to its default display and the whole file would pass by
    // measuring an unstyled document.
    const document = panel();
    expect(document.querySelector("style")).not.toBeNull();
    expect(getComputedStyle(document.getElementById("scroll")).display).toBe("flex");
  });

  for (const id of HIDEABLE) {
    test(`#${id} leaves the screen when hidden`, () => {
      const document = panel();
      const element = document.getElementById(id);
      expect(element, `#${id} is toggled but not in panel.html`).not.toBeNull();
      element.hidden = true;
      expect(getComputedStyle(element).display).toBe("none");
    });

    test(`#${id} comes back when it is not hidden`, () => {
      // The other half, and not a formality: `display: none` written directly
      // on the element would pass the test above and make the panel's own
      // reveal a no-op.
      const document = panel();
      const element = document.getElementById(id);
      element.hidden = false;
      expect(getComputedStyle(element).display).not.toBe("none");
    });
  }
});

describe("the button that started this", () => {
  test("hidden is enough on its own — no class, no style attribute", () => {
    // panel.js hides it by attribute alone. A fix that worked by adding a
    // class here would leave the attribute path broken for the next element.
    const document = panel();
    const button = document.getElementById("back-to-review");
    expect(button.hasAttribute("hidden")).toBe(true);
    expect(button.getAttribute("style")).toBeNull();
    expect(getComputedStyle(button).display).toBe("none");
  });
});
