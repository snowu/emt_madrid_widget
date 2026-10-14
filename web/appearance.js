// Runs at the start of <body> so a saved style is applied before rendering.
(() => {
  const key = "emt:interface-style";
  // "signal" is the stored name of the Hex board; it predates the hex look,
  // and renaming it would reset everyone's saved choice.
  const styles = {
    signal: ["ui-signal", "ui-signal-v2", "ui-signal-compact", "ui-signal-system", "ui-hex"],
    green: ["ui-signal", "ui-signal-v2", "ui-signal-compact", "ui-signal-system", "ui-hex", "ui-hex-green"],
    classic: [],
  };
  const allClasses = [...new Set(Object.values(styles).flat())];
  let choice = "signal";
  try {
    // "simple" was a short-lived style built on Classic; keep its users there.
    const raw = localStorage.getItem(key);
    const saved = raw === "simple" ? "classic" : raw;
    if (saved && Object.hasOwn(styles, saved)) choice = saved;
  } catch { /* Keep the default when storage is unavailable. */ }

  function applyStyle() {
    for (const name of allClasses) document.body.classList.toggle(name, styles[choice].includes(name));
    for (const button of document.querySelectorAll("[data-style-choice]")) {
      button.setAttribute("aria-pressed", String(button.dataset.styleChoice === choice));
    }
  }
  applyStyle();

  document.addEventListener("DOMContentLoaded", () => {
    applyStyle();
    for (const button of document.querySelectorAll("[data-style-choice]")) {
      button.addEventListener("click", () => {
        const picked = button.dataset.styleChoice;
        choice = Object.hasOwn(styles, picked) ? picked : "signal";
        applyStyle();
        try { localStorage.setItem(key, choice); } catch { /* The current selection still works. */ }
        // MapLibre tracks window resizing; switching styles can change its container size.
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      });
    }
  }, { once: true });
})();
