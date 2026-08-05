# BreezeFill logo assets

Every sized copy of the logo the product needs, in one place. **All of it is
generated** — change the master, re-run the script, commit the result:

```bash
./.venv/Scripts/python.exe scripts/make_logo_assets.py
```

Do not edit the sized PNGs by hand. They will be overwritten, and a
hand-tweaked file that silently disagrees with the master is worse than no
file, because nothing will tell you which one is current.

## Sources

| File | What it is |
|---|---|
| `source-master.svg` | The vector original. **Use this on the website** — crisp at any size, 5.5 KB, no @2x variants needed |
| `source-master-600.png` | The raster original every PNG below is generated from |

Brand blue is `#3aa0dc`, taken from the SVG's fill.

## Sized assets, named for where they appear

| File | Size | Where it shows up |
|---|---|---|
| `chrome-toolbar-16.png` | 16 | The toolbar button, standard-DPI screen |
| `chrome-toolbar-retina-32.png` | 32 | The toolbar button, hi-DPI screen — what most modern laptops draw |
| `chrome-manage-page-48.png` | 48 | `chrome://extensions` |
| `chrome-store-listing-128.png` | 128 | Install dialog and the Chrome Web Store listing |
| `website-favicon-16.png` | 16 | Browser tab |
| `website-favicon-32.png` | 32 | Browser tab on hi-DPI, and most bookmark bars |
| `website-apple-touch-180.png` | 180 | iOS home screen |
| `linkedin-profile-300.png` | 300 | LinkedIn company/profile picture |

**Named for the use case, not the size, on purpose.** "32px" tells you nothing
about whether a file can be deleted; "chrome-toolbar-retina" tells you exactly
who breaks. Sizes also collide by coincidence — a favicon and a toolbar icon
are both 32 — and size-based names invite someone to merge two files that
answer to different platforms and would drift apart the first time one needed
a tweak.

## The toolbar icon is a control, not decoration

Worth knowing before anyone simplifies this set. BreezeFill holds no standing
access to any website. The doctor grants access by **clicking the toolbar icon
on the tab with the claim form open** — that click is the permission grant, and
the panel's own error message tells them to do it by name. If the icon is
unrecognisable among the other extensions in their toolbar, that instruction
gets harder to follow.

## Why 16px is framed differently

The mark is three wind strokes with generous air around them: on the master,
the artwork fills about 51% of the tile. That reads well large and fails at 16,
where the drawing lands in roughly nine pixels and the three strokes merge into
a single pale blob. This was verified by rendering it, not assumed.

So 16px assets use the same artwork scaled up inside the tile until it fills
~82%, which is where the strokes separate again. Nothing is redrawn, no stroke
is dropped, and the rounded-corner silhouette is re-imposed from the master's
own alpha channel afterwards — without that step the enlarged artwork bleeds
into the corners and the logo quietly becomes a square.

Everything 32 and above keeps the master's framing exactly as drawn. Tightening
only where the pixels run out is what a brand size ladder is.

If you ever want a sharper 16, the real fix is a purpose-drawn variant: two
strokes instead of three, thicker, less padding. Chrome takes a different image
per size, so it drops in as `chrome-toolbar-16.png` with no other changes.

## The copies under `extension/icons/`

Chrome reads extension icons from paths relative to the extension directory
and will not climb out of it, so the four `chrome-*` assets are copied into
`extension/icons/` by the same script. Those copies are build output. Edit the
master, re-run, commit both.
