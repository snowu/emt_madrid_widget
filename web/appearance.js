// Runs at the start of <body> so a saved style is applied before rendering.
(() => {
  const key = "emt:interface-style";
  const signalClasses = ["ui-signal", "ui-signal-v2", "ui-signal-compact", "ui-signal-system"];
  let choice = "signal";
  try {
    if (localStorage.getItem(key) === "classic") choice = "classic";
  } catch { /* Keep the default when storage is unavailable. */ }

  function applyStyle() {
    for (const name of signalClasses) document.body.classList.toggle(name, choice === "signal");
    for (const button of document.querySelectorAll("[data-style-choice]")) {
      button.setAttribute("aria-pressed", String(button.dataset.styleChoice === choice));
    }
  }
  applyStyle();

  document.addEventListener("DOMContentLoaded", () => {
    applyStyle();
    for (const button of document.querySelectorAll("[data-style-choice]")) {
      button.addEventListener("click", () => {
        choice = button.dataset.styleChoice === "classic" ? "classic" : "signal";
        applyStyle();
        try { localStorage.setItem(key, choice); } catch { /* The current selection still works. */ }
        // MapLibre tracks window resizing; switching styles can change its container size.
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      });
    }
  }, { once: true });
})();
