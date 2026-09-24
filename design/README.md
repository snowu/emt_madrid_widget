# Signal system studies

Serve the repository with `python3 -m http.server 4174` and open
`http://localhost:4174/design/system-hubs.html`. The other studies are
`system-stops.html`, `system-bikes.html`, `system-map.html`, and `system-sheet.html`.
These are static fixtures using the app stylesheet; they do not request live data.
To inspect light mode, change the root `data-theme` attribute to `light` in DevTools.

## September refinement

Departures now carry the strongest emphasis. Status and navigation have quieter
borders, hub titles occupy their own row, and arrival times use a consistent green.
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
