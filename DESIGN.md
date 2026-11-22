---
name: BreezeFill
description: A consultation note becomes a filled claim form; the doctor confirms every answer.
colors:
  sky-hi: "#74c6f1"
  sky: "#3aa0dc"
  sky-lo: "#2b92da"
  sky-tint: "#e3f2fc"
  sky-wash: "#f2f9fe"
  mist: "#d6ebfa"
  navy: "#0a2238"
  navy-2: "#12304d"
  ink: "#0a2238"
  ink-2: "#3a5570"
  ink-on-sky: "#0b2a47"
  on-navy: "#eaf4fc"
  on-navy-2: "#a9c8e2"
  line: "#d7e6f2"
  ground: "#f3f8fc"
  paper: "#ffffff"
  amber: "#8a5a00"
  amber-line: "#c98a1a"
  amber-wash: "#fff6e3"
  link-blue: "#1a6fb8"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3rem, 6vw, 5rem)"
    fontWeight: 800
    lineHeight: 0.94
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Bricolage Grotesque, Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.3rem, 4.8vw, 4.1rem)"
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Bricolage Grotesque, Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.6rem, 2.4vw, 2.1rem)"
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Figtree, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  lede:
    fontFamily: "Figtree, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(1.05rem, 1.3vw, 1.2rem)"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Figtree, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 650
    lineHeight: 1.35
  data:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "clamp(0.76rem, 0.95vw, 0.86rem)"
    fontWeight: 400
    lineHeight: 1.8
rounded:
  chip: "4px"
  field: "10px"
  row: "12px"
  card: "22px"
  panel: "26px"
  stack: "28px"
  tile: "32px"
  pill: "999px"
spacing:
  inset: "12px"
  gutter: "clamp(20px, 5vw, 56px)"
  section: "clamp(88px, 11vw, 152px)"
  content-max: "1240px"
  stack-gap: "16px"
components:
  button-navy:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "0 24px"
    height: "52px"
  button-navy-hover:
    backgroundColor: "{colors.navy-2}"
  button-white:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.navy}"
    rounded: "{rounded.pill}"
    padding: "0 24px"
    height: "52px"
  button-white-hover:
    backgroundColor: "{colors.sky-wash}"
  button-sky:
    backgroundColor: "{colors.sky}"
    textColor: "{colors.navy}"
    rounded: "{rounded.pill}"
    padding: "0 24px"
    height: "52px"
  button-sky-hover:
    backgroundColor: "{colors.sky-hi}"
  button-quiet:
    textColor: "{colors.ink-on-sky}"
    padding: "0 6px"
    height: "44px"
  nav-pill:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.on-navy}"
    rounded: "{rounded.pill}"
    padding: "6px 6px 6px 14px"
  proposal:
    backgroundColor: "{colors.sky-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "4px 6px 4px 11px"
    height: "34px"
  proposal-inferred:
    backgroundColor: "{colors.amber-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
  proposal-confirmed:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.paper}"
    rounded: "{rounded.field}"
  sky-tile:
    textColor: "{colors.ink-on-sky}"
    rounded: "{rounded.tile}"
  paper-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  navy-band:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.on-navy}"
    rounded: "{rounded.tile}"
---

# Design System: BreezeFill

## Overview

**Creative North Star: "Cut From the Logo Tile"**

The homepage is built out of the logo: saturated sky-blue gradient tiles with big rounded corners, inset a few pixels from the viewport on a pale blue-tinted ground, and the logo's white wind strokes, a straight run ending in a curl, as the only line ornament. The strokes carry meaning: in the sample claim and the step art, a white stroke runs from the sentence in the note to the box on the form, so the ornament is the product's source links made visible. Deep night navy takes the parts that scroll (the walkthrough and stacked steps) and the closing.

The page is drenched rather than tinted. Colour comes in whole panels, not accents scattered on white, and the panels are few and large. White cards sit on the sky for anything a doctor reads at length. The look is confident and warm-weather, not clinical, but every readable word sits at a contrast a tired GP can read.

Scope: this system governs the homepage (`#/`, `frontend/src/home.css`, scoped under `.home`). `#/get` and `#/demo` still use the older pale-blue `landing.css` / `demo.css` and have not been migrated; the claim UI at `#/app` (`styles.css`) and the extension panel are separate operational surfaces with their own styles.

**Key Characteristics:**
- Inset sky tiles (32px radius, 12px from the viewport edge) on a pale ground.
- White wind strokes with round caps and a curled terminal, drawn on with stroke-dashoffset.
- Navy text on sky; white only for strokes, cards and fills.
- Proposed answers in dashed outlines; confirmed answers go solid navy.
- Bricolage Grotesque display, Figtree text, JetBrains Mono only for pasted note data.

## Colors

One saturated hue family (the logo's sky blue) against a single night navy, with a pale blue ground and one amber reserved for "inferred, check this".

### Primary
- **Logo Sky** (sky): the logo's own blue. Middle stop of every sky gradient, the arrow disc on navy buttons, the top-bar CTA, progress pips and bars, focus rings on dark panels, the `mark` in redacted text.
- **Morning Sky** (sky-hi): the light stop of the 140deg tile gradient and the hover state of sky buttons.
- **Deep Sky** (sky-lo): the dark stop of the tile gradient. Never a text colour.

### Secondary
- **Night Navy** (navy): the band, the closing, the top-bar pill, the confirmed state of a proposal, the primary button on pale ground, and all headline text on sky.
- **Lifted Navy** (navy-2): hover for navy buttons only.

### Tertiary
- **Inferred Amber** (amber, amber-line, amber-wash): text, dashed border and fill for an answer the model inferred rather than quoted. It means "read this one before confirming" and is used for nothing else.

### Neutral
- **Pale Sky Ground** (ground): the page background between tiles.
- **Paper** (paper): note and form cards, the white button, all strokes.
- **Sky Tint / Sky Wash / Mist** (sky-tint, sky-wash, mist): lit source sentences and rows, form headers, proposal fills, closed privacy panels, the mist step card.
- **Night Ink** (ink) and **Slate Ink** (ink-2): body text and secondary text on pale and white surfaces.
- **Ink on Sky** (ink-on-sky): every word set directly on a sky gradient.
- **On Navy** (on-navy, on-navy-2): primary and secondary text on navy; headings on navy go pure white.
- **Hairline** (line): dividers between form rows, card heads and feet, the FAQ list.
- **Link Blue** (link-blue): "quoted" status text and the Synthetic chip label.

### Named Rules
**The Navy-on-Sky Rule.** White text on Logo Sky measures 2.9:1 and fails even at display size; navy on it is 5.5:1. Every readable word on a sky surface is navy (ink-on-sky). White on sky is for strokes, the giant mark, cards and fills only.

**The Drench Rule.** Sky arrives as whole tiles with the 140deg gradient (sky-hi to sky to sky-lo) plus a soft white radial highlight in one corner. It is not used as a thin accent line or a coloured word on white.

**The Amber Means Inferred Rule.** Amber appears only on an answer that was inferred. It is never decoration and never a warning for anything else.

## Typography

**Display Font:** Bricolage Grotesque (with Figtree, system sans)
**Body Font:** Figtree (with system sans)
**Label/Mono Font:** JetBrains Mono, for the pasted note and form data only

**Character:** a chunky, slightly quirky grotesque set very tight for headlines, over a friendly, even humanist sans for reading. All three faces are self-hosted from `frontend/public/fonts/`.

### Hierarchy
- **Display** (800, clamp(3rem, 6vw, 5rem), 0.94): the hero h1 only, max 12ch. The closing headline (clamp(2.8rem, 6.4vw, 5.4rem), 0.96) and the price numeral (800, up to 6rem, tabular) share this weight and tracking.
- **Headline** (700, clamp(2.3rem, 4.8vw, 4.1rem), 1.04): section h2s; the walkthrough h2 steps down to clamp(2.1rem, 4vw, 3.5rem).
- **Title** (700, clamp(1.6rem, 2.4vw, 2.1rem)): card h3s; stacked step cards go up to 2.7rem.
- **Body** (400, 16px, 1.55): running text; card paragraphs 1.04 to 1.1rem at 1.6 to 1.65. Ledes cap at 52 to 56ch.
- **Label** (650, 0.72 to 0.84rem): card heads, field labels, status lines, counts (tabular numerals).
- **Data** (JetBrains Mono, 0.76 to 0.86rem, 1.8): the synthetic note, URLs, redaction lines, choice chips.

### Named Rules
**The Mono Is Data Rule.** Monospace appears only where the text is data a doctor pasted or a system produced (the note, a URL, a redacted line, a candidate value). Never for headings, labels or decoration.

**The Tight Display Rule.** Display and headline sizes track negative (-0.03em to -0.04em) with balanced wrapping; body text keeps default tracking with pretty wrapping.

## Layout

Tiles and bands sit inset 12px from the viewport (8px under 860px) with the tile radius dropping from 32px to 24px at the same breakpoint. The hero tile fills the first viewport (`100svh` minus the inset). Content sections on the pale ground run to a 1240px max with a fluid gutter of clamp(20px, 5vw, 56px) and generous vertical padding of clamp(88px, 11vw, 152px).

Section heads use an asymmetric two-column grid (1.25fr / 1fr, bottom-aligned): headline left, lede right. The walkthrough pins one viewport with a sticky grid (copy left, form right) over a 260vh scroll; the steps are sticky cards that stack with a 26px offset per card. Below 1080px the top-bar links hide and the sample claim drops its stroke layer; below 860px every two-column grid collapses to one, stickiness is released, and the privacy panels stack vertically.

## Elevation & Depth

Depth comes from colour first (pale ground, sky tile, white card, navy band) and from soft, navy-tinted drop shadows with a large negative spread second. Shadows are ambient, never hard or offset.

### Shadow Vocabulary
- **Card on sky** (`box-shadow: 0 1px 0 rgba(255,255,255,0.6) inset, 0 24px 48px -24px rgba(10,34,56,0.5)`): white note and form cards on the hero tile.
- **Button lift** (`box-shadow: 0 10px 24px -12px rgba(10,34,56,0.6)`, deepening on hover): navy and white action buttons.
- **Stacked card** (`box-shadow: 0 -18px 48px -24px rgba(0,0,0,0.55)`): sticky step cards, shadow cast upward onto the card beneath.
- **Form on navy** (`box-shadow: 0 40px 80px -40px rgba(0,0,0,0.7)`): the walkthrough form on the band.

### Named Rules
**The Soft Navy Shadow Rule.** Every shadow is tinted navy (or black on navy), blurred wide and pulled in by a negative spread. No hard offset shadows, no grey ambient glows.

## Shapes

Big, friendly radii throughout, stepping down as elements get smaller: tile 32px, step and problem cards 28px, privacy panels 26px, white cards 22 to 24px, rows 12px, fields and chips 10px, inline source highlights 4px. Every action and the nav are full pills (999px); arrow discs and ticks are circles.

The one recurring silhouette is the wind stroke: a straight run into a curl that turns 290 degrees, round caps, from `WindMark.tsx` (centre-lines of the logo master). It appears as the giant drifting hero mark (white, about 24% opacity), the price-card mark, the closing mark (`#1c4d77` on navy), the underline under "Once.", the curl on closed privacy panels, and the connectors from note to form.

Borders mean state. A 1.5px dashed border marks something proposed, unconfirmed, closed or not yet done; it becomes solid (and usually filled navy) when confirmed or opened.

## Components

### Buttons
Rounded, weighty pills with a circular arrow disc on the trailing edge.
- **Shape:** full pill (999px), 52px tall, 24px horizontal padding (8px on the right when an arrow disc is present). Label in Figtree 650 at 1rem.
- **Navy:** navy fill, white label, sky arrow disc. The primary action on pale surfaces.
- **White:** white fill, navy label, navy arrow disc. The primary action on a sky tile.
- **Sky:** sky fill, navy label, navy arrow disc. The primary action on navy.
- **Hover / Focus:** lift 1px, shadow deepens, fill steps lighter (navy-2, sky-wash, sky-hi), arrow disc slides 3px right; all on the page ease (0.25 to 0.35s). Focus is a 3px navy outline at 3px offset, sky on dark panels.
- **Quiet:** an underlined text link, 44px tall, underline thickening to 3px on hover. Navy on sky, on-navy on navy.

### Proposals (signature)
The proposed answer is the core component of the world.
- **Proposed:** 1.5px dashed sky border, sky-wash fill, ink label 650, a hollow circular tick at 55% opacity. 10px radius, 34px tall.
- **Inferred:** the same with dashed amber-line border, amber-wash fill and amber status text.
- **Confirmed:** border goes solid, fill goes navy, label white, tick fills sky with a navy check.
- **Choice chips:** the same dashed outline in mono at 0.82rem, one per candidate in note order; the chosen one goes solid navy.
- **Refused:** an empty, hatched field (135deg stripes of `#eef3f7` / `#fbfcfd`, solid pale border) with grey status text. A blank is shown as a blank.

### Cards / Containers
- **Sky tile:** 140deg sky gradient plus a white radial highlight in one corner, 32px radius, navy text, often carrying a white wind mark behind content. Used for the hero, the "with BreezeFill" problem card, the sky step card and the price card.
- **Paper card:** white, 22px radius, card-on-sky shadow, with a sky-wash head row and hairline-divided rows. Used for the note and form.
- **Navy band:** navy with a faint sky radial glow at the top right, 32px radius, inset like a tile. Hosts the walkthrough, the stacked steps and the closing.
- **Stack card:** 28px radius, two columns (copy, art), in three skins: paper (`#f7fbfe` with sky-tint art panel), sky gradient, and mist.

### Navigation
A navy pill fixed at top centre, 22px from the top (14px once scrolled, when it gains a soft shadow). Brand in Bricolage 700, links in on-navy-2 at 0.92rem becoming white on a 7% white pill on hover, and a sky CTA pill at the end. Links hide below 1080px; under 860px the pill spans the width.

### Privacy panels
An accordion of four vertical panels: closed panels are sky-tint with a dashed sky border, a vertical-rl title and a sky curl; the open panel grows (flex 3.6), goes solid navy, and reveals its body after a 0.28s delay. Under 860px the panels stack.

### Motion
One easing for everything: an exponential ease-out, `cubic-bezier(0.16, 1, 0.3, 1)`. Strokes draw with stroke-dashoffset over 1 to 1.8s, staggered by index (0.2s for the marks, 0.42s for the claim connectors); values and statuses rise 5 to 12px and fade in after their stroke lands. The hero mark drifts 22s, ease-in-out, alternating. Hovering a field lights its source sentence (sky-tint fill, navy underline) and thickens its stroke while others dim to 22%. Under reduced motion every animation and transition is off and every stroke is shown fully drawn.

## Do's and Don'ts

### Do:
- **Do** set every readable word on a sky surface in navy (ink-on-sky, `#0b2a47`); keep white on sky for strokes, marks, cards and fills.
- **Do** inset tiles and bands 12px from the viewport with the 32px tile radius (8px and 24px under 860px).
- **Do** draw any connector or ornament as the wind stroke: round caps, a straight run into a curl, animated by stroke-dashoffset on `cubic-bezier(0.16, 1, 0.3, 1)`.
- **Do** show a proposed value dashed and a confirmed value solid navy; show an inferred value in amber; show a refused value as an empty hatched field.
- **Do** use JetBrains Mono only for note text, URLs, redacted lines and candidate values.
- **Do** make every motion settle to its finished state under `prefers-reduced-motion`.

### Don't:
- **Don't** put white text on Logo Sky (2.9:1); it fails at every size.
- **Don't** use sky as a thin accent on white; it comes as whole gradient tiles.
- **Don't** use amber for anything except an inferred answer.
- **Don't** use hard offset shadows or grey glows; shadows are soft, navy-tinted and negatively spread.
- **Don't** use dashed borders for decoration; dashed means proposed, unconfirmed, closed or not yet done (the "today" problem card).
- **Don't** add a second decorative line motif (squiggles, waves, swooshes) beside the wind stroke; hairline dividers are structure, not ornament.
