# Signal system studies

Serve the repository with `python3 -m http.server 4174` and open
`http://localhost:4174/design/system-hubs.html`. The other studies are
`system-stops.html`, `system-bikes.html`, `system-map.html`, and `system-sheet.html`.
These are static fixtures using the app stylesheet; they do not request live data.
To inspect light mode, change the root `data-theme` attribute to `light` in DevTools.

## September refinement

Departures now carry the strongest emphasis. Status and navigation have quieter
borders, hub titles share a compact row with their actions, and arrival times use a consistent green.
Route numbers retain their offset shadow. Bike counts use simple dividers, with
neutral colors for dock and disabled counts. Freshness retains its state colors.

The CSS-generated “SYNCED” label has been removed so that status copy remains
controlled by the app. Fixtures no longer duplicate CSS-generated freshness text,
and hub rows now include the boarding-stop link, connection detail, walking action,
and ETA used by the application.

Screenshots in `screenshots/system-*.png` cover five surfaces in dark and light mode.
Chromium checked all five fixtures at 320, 390, 430, and 768px in both themes:
40 combinations, no document-level horizontal overflow. Screenshots use 430 × 932px.
These checks cover static layout, not live map or account interactions.

Validation: 148 API tests, 19 web tests, 120-element DOM smoke check, and
`git diff --check` passed. The installed Workers test runtime reports an older
compatibility date than configured; the tests still pass.

## Single-row toolbar iteration

The account, location, nearby, refresh, and List/Map controls now share one 52px
toolbar at every checked width. Removed study-only headings and tightened status,
card headers, and route spacing. All ten screenshots were regenerated.

## Interface style preference

Account → Interface style offers Classic and Signal board independently of the
color theme. Signal board remains the default; the selection is stored on this
browser and restored before the page renders. Browser checks exercised both
buttons, reload persistence, color-theme preservation, unrelated body classes,
and fallback from an invalid saved value. The account panel captures are
`options-classic.png` and `options-signal.png`.

## Hex board (October 2026)

The default style now borrows hex-lab's look: violet phosphor chrome on a
near-black grid, JetBrains Mono throughout, square frames, `// section`
labels and `./tab` navigation. It is a layer at the end of `web/style.css`
scoped to `body.ui-hex`, which `appearance.js` toggles together with the
Signal classes, so **Classic** still switches all of it off. The account
menu labels it **Hex board**; the stored value is still `signal`.

Clarity rules the layer keeps:

- Countdowns are the one green on the screen (`--hx-good`), larger and
  brighter than anything around them, in cards, hub rows and the stop sheet.
- Line numbers keep their per-line `lineColor()` hue. On the light theme only
  the text labels are darkened with a filter, because the same colour also
  draws the map route.
- Reachability keeps a full-height bar: green comfortable, amber tight, faint
  missed. Bike counts keep green / amber / red.
- Map pins and status dots stay round; every text frame is square.
- Below 380px the mono face is tightened so a hub row stays on two lines.

Screenshots in `docs/screenshots/` come from the real page with the Worker
and Supabase mocked in Playwright (430 × 932, 2×). Checked at 320, 390 and
430px in both themes on all three tabs: no horizontal overflow.

## Three interface styles

Account → Interface style:

| button | stored value | body classes |
| --- | --- | --- |
| Classic | `classic` | none |
| Hex (default) | `signal` | Signal classes + `ui-hex` |
| Hex green | `green` | Signal classes + `ui-hex` + `ui-hex-green` |

`appearance.js` owns that table; an unknown saved value falls back to Hex.
A **Simple** style (`simple`, a softer Classic) shipped briefly and was
dropped as redundant with Classic; a saved `simple` now opens Classic.

- **Hex green** is hex-lab's original phosphor palette. It only swaps the
  `--hx-*` tokens, so every Hex rule applies unchanged. Chrome and countdowns
  share the green, as in hex-lab; the countdown still leads on size and glow.

Screenshots are in `docs/screenshots/styles/`. All styles were checked at
320 and 430px, dark and light, on every tab: no horizontal overflow.
