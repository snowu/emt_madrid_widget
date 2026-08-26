/** Load the real page the way a browser does, and fail if it throws.
 *
 * `node --check` only parses. It cannot see a top-level `const` referenced
 * before its declaration, a listener bound to an id that is not in the HTML,
 * or anything else that only fails once the module is evaluated — all of
 * which take the whole ES module down and leave a blank page. That is exactly
 * how `ac20fe6` shipped: syntax-clean, and dead on arrival.
 *
 * So: build a real DOM from web/index.html, stub only what a browser supplies
 * that jsdom does not (Leaflet, the Supabase SDK, geolocation), and import
 * app.js. Anything that throws while it evaluates is a broken deploy.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The repo keeps its scripts in tools/ and its only package.json in api/, so
// resolution has to be pointed at api/node_modules explicitly — Node resolves
// from the importing file's directory, not the working directory.
const { JSDOM } = createRequire(join(root, "api", "package.json"))("jsdom");

const web = join(root, "web");
const failures = [];

const dom = new JSDOM(readFileSync(join(web, "index.html"), "utf8"), {
  url: "https://snowu.github.io/emt_madrid_widget/",
  pretendToBeVisual: true,
});
const { window } = dom;

// MapLibre GL and the Supabase SDK arrive from CDN <script> tags that are not
// fetched here. Only the surface app.js touches needs to exist, and it has to
// tolerate any property access or call, at any depth. MapLibre additionally
// wants a WebGL context that jsdom has no way to provide, so it is stubbed
// wholesale rather than loaded — this check is about whether the module
// evaluates, not about rendering a frame.
const chainable = () => new Proxy(function stub() {}, {
  get: (_, key) => (key === "then" ? undefined : chainable()),
  apply: () => chainable(),
  construct: () => chainable(),
});
// jsdom does not reflect `media` on <meta>, which browsers do and the theme
// code reads off <meta name="theme-color" media="...">. This is a gap in the
// environment, not in the page — shim only these, never an actual app bug.
Object.defineProperty(window.HTMLMetaElement.prototype, "media", {
  get() { return this.getAttribute("media") ?? ""; },
  set(value) { this.setAttribute("media", value); },
  configurable: true,
});

window.maplibregl = chainable();
window.supabase = { createClient: () => chainable() };
window.fetch = () => Promise.reject(new Error("offline in smoke check"));
window.navigator.geolocation = { getCurrentPosition() {}, watchPosition() {}, clearWatch() {} };
if (!window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}

for (const key of ["window", "document", "localStorage", "navigator", "location",
  "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "maplibregl", "supabase",
  "fetch", "CustomEvent", "Event", "HTMLElement", "getComputedStyle"]) {
  if (window[key] === undefined) continue;
  // Some of these (navigator, and location on newer Node) are getter-only
  // globals, so they have to be redefined rather than assigned.
  Object.defineProperty(globalThis, key, {
    value: window[key], writable: true, configurable: true,
  });
}

window.addEventListener("error", (event) => failures.push(`window error: ${event.message}`));
// The fetch stub rejects on purpose; the app is expected to handle that.
process.on("unhandledRejection", () => {});

try {
  await import(pathToFileURL(join(web, "app.js")).href);
} catch (err) {
  failures.push(`app.js failed to evaluate: ${err.message}`);
}

// Every element app.js reaches for by id must actually exist in the HTML —
// otherwise the first property access on the null it gets back throws.
const source = readFileSync(join(web, "app.js"), "utf8");
const ids = [...source.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
const missing = [...new Set(ids)].filter((id) => !window.document.getElementById(id));
if (missing.length) failures.push(`getElementById found nothing for: ${missing.join(", ")}`);

// app.js starts its 1s countdown interval on load, which would hold the event
// loop open forever. Tear the window down and exit deliberately.
window.close();

if (failures.length) {
  console.error("web smoke check FAILED");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`web smoke check passed (${new Set(ids).size} element ids resolved)`);
process.exit(0);
