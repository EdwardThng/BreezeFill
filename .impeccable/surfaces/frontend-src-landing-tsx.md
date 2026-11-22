---
version: 1
slug: "frontend-src-landing-tsx"
primary_target: "frontend/src/Landing.tsx"
related_targets: ["frontend/src/landing.css"]
---

# Landing page (breezefill.com `#/`)

Mode: Persuade. Visitor: a Singapore private GP (sometimes their clinic staff) deciding whether to trust a tool with claim forms. Action: Get BreezeFill → `#/get`. Proof: the product itself, demonstrated on a synthetic claim. No testimonials, numbers or video exist; none may be invented. Constraints: static page, no network calls, no remote assets; copy claims are pinned by `frontend/src/Landing.test.tsx`; pricing says one user per subscription.

Inspiration (craft bar, not world): bubblelab.ai — drenched rounded inset panels, an oversized brand mark, a dark band of stacked sticky feature cards, an expanding accordion.

## Direction contract

THESIS: The page is cut from the logo tile. The wind strokes are the product's source links made visible: a white curling line carries each answer from the sentence in the note to the box on the form. It refuses the pale-blue SaaS page of centred headline, screenshot and card row.

OWN-WORLD: Saturated sky-blue gradient tiles (#4aaee3 → #1b84d4) with large rounded corners, inset from the viewport edge on a near-white blue-tinted ground (#f3f8fc). White wind strokes with round caps and curled terminals as the only line ornament. Deep night navy (#0a2238) for the stacked-feature band and the closing. Bricolage Grotesque display, Figtree text, JetBrains Mono only for the pasted note (it is data). Proposed answers sit in dashed outlines; confirmed ones go solid white.

STORY: Within one viewport the visitor sees a note become a form: some answers quoted, one inferred, one refused, one choice handed back. They understand it proposes and they confirm. Lower down they learn the three steps, the privacy model and the price, and press Get BreezeFill.

FIRST VIEWPORT: The nav floats as a navy pill at top centre. Below it, one sky tile fills ~92vw × ~86vh with 32px radius. A giant wind mark drifts at its right, ~70% of tile height, white at 14%. Top-left inside the tile: the h1 "You already wrote this. Once." (~5.5rem), the lede, the white Get BreezeFill button and a ghost "Watch it fill a form" link. Lower half: the live sample claim, a note card left and a form card right, with a Fill button. Wind strokes draw from the note sentences to the fields.

FORM: Breeze, my grounded list #3 (assigned by the roll); seed:846cc6164f0b3991. Raises: dashed-until-confirmed (pattern envelope); one headline, nothing labelled twice (catalog sleeve); hovering a field lights its source sentence (understory); one patient threads the page (minihompy). Signature interaction: Fill draws wind strokes from source sentence to field, with hover-to-light-source. Motion grammar: stroke-dashoffset line draws with exponential ease-out, a slow drift of the giant mark, sticky stacked cards. All of it settles to a finished state under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Demo video slot: no recording exists; the section is hidden until `DEMO_VIDEO` is set.
