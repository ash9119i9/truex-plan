// Theme, contrast, text size and motion from the design spec (system/DESIGN-SPEC.md 2.2–2.3).
// The user's choices live on <html> as data-theme, data-contrast and data-textsize; the
// resolved values that the CSS reads are data-eff-theme, data-eff-contrast and data-eff-motion.
//
// Both functions are serialized into the inline <head> script with toString(), so each must be
// self-contained: no imports, no module constants, nothing from outside its own body.

// Recomputes the data-eff-* attributes from the choices on <html> and the OS settings.
// The hook calls it after a choice; the boot script calls it on every OS change.
export function resolveTheme(): void {
  var r = document.documentElement.dataset;
  var os = function (query: string) {
    return matchMedia(query).matches;
  };
  r.effTheme =
    r.theme === "dark" ||
    (r.theme !== "light" && os("(prefers-color-scheme: dark)"))
      ? "dark"
      : "light";
  r.effContrast =
    r.contrast === "more" ||
    (r.contrast !== "normal" && os("(prefers-contrast: more)"))
      ? "more"
      : "normal";
  r.effMotion = os("(prefers-reduced-motion: reduce)") ? "reduce" : "full";
}

// Reads the saved choices (per device), sets the attributes before first paint and keeps the
// resolved values in step with the OS. Storage can be blocked: every read falls back to auto.
function bootTheme(resolve: () => void): void {
  var r = document.documentElement.dataset;
  var read = function (key: string) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  };
  var pick = function (value: string | null, allowed: string[]) {
    return value !== null && allowed.indexOf(value) >= 0 ? value : allowed[0];
  };
  // One-time move from the pre-spec key ("" meant Auto). A value under the new key wins.
  var old = read("truex-theme");
  if (old !== null) {
    try {
      if (read("tx-sys-theme") === null)
        localStorage.setItem(
          "tx-sys-theme",
          pick(old, ["auto", "light", "dark"]),
        );
      localStorage.removeItem("truex-theme");
    } catch (e) {}
  }
  r.theme = pick(read("tx-sys-theme"), ["auto", "light", "dark"]);
  r.contrast = pick(read("tx-sys-contrast"), ["system", "normal", "more"]);
  var size = pick(read("tx-sys-size"), ["100", "150", "200"]);
  if (size === "100") delete r.textsize;
  else r.textsize = size;
  resolve();
  [
    "(prefers-color-scheme: dark)",
    "(prefers-contrast: more)",
    "(prefers-reduced-motion: reduce)",
  ].forEach(function (query) {
    matchMedia(query).addEventListener("change", resolve);
  });
}

// Inline in <head>, before any stylesheet, so the first paint is already in the right theme.
export const THEME_BOOT_SCRIPT = `(${bootTheme})(${resolveTheme})`;
