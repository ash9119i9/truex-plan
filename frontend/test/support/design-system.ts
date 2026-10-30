import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Foundation and layer files copied from system/ into frontend/styles/system/.
// The Docker build only sees frontend/, so the app ships copies; the copies
// must stay byte-identical to their source (DESIGN-SPEC 0.2).
export const SYSTEM_FILES = [
  "type.css",
  "color.css",
  "space.css",
  "corner.css",
  "primitives.css",
  "patterns.css",
] as const;

// Files whose copy is missing or differs from the source.
export function driftedFiles(
  sourceDir: string,
  copyDir: string,
  files: readonly string[] = SYSTEM_FILES,
): string[] {
  return files.filter((file) => {
    const copy = join(copyDir, file);
    if (!existsSync(copy)) return true;
    return !readFileSync(join(sourceDir, file)).equals(readFileSync(copy));
  });
}

export type Violation = { selector: string; property: string; value: string };

// Sanctioned exceptions from DESIGN-SPEC 19.1 that can be told apart in CSS:
// the floating dock's px geometry (and its 92px reserve under the composer), printed-artwork custom properties and the
// mask channel's #000. Other 19.1 rows (agent card artwork, trace art, avatar
// initials) are added here when their screens are ported.
const ALLOWED_SELECTOR = /(^|[\s,>+~])\.cs-dock\b|\.cs-bottom\.is-dock-up\b/;
// --g-*: Google's sign-in button palette, fixed by Google's branding rules.
const ALLOWED_CUSTOM = /^--(pb|pr|c|g)-|^--dock-(shine|rim)$/;
const MASK = /^(-webkit-)?mask(-image)?$/;

const HEX = /#[0-9a-f]{3,8}\b/i;
// A number with a unit, ignoring zero and values inside var() fallbacks.
const LENGTH = /(^|[^\w.-])-?(\d*\.)?\d+(px|rem|em|pt)\b/;
const SPACING =
  /^(margin|padding|gap|row-gap|column-gap|inset)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const RADIUS =
  /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;

// Raw values that DESIGN-SPEC law 1 forbids in product CSS: hex colour,
// px/rem spacing, font-size, radius and box-shadow that are not tokens.
export function rawValues(css: string): Violation[] {
  const out: Violation[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Innermost rule blocks: a selector followed by declarations without braces.
  for (const rule of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    if (selector.startsWith("@")) continue;
    if (ALLOWED_SELECTOR.test(selector)) continue;
    for (const decl of rule[2].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      const property = decl.slice(0, at).trim().toLowerCase();
      const value = decl.slice(at + 1).trim();
      if (!property || !value) continue;
      const bare = value.replace(/var\([^()]*\)/g, "var()");
      const raw = property.startsWith("--")
        ? !ALLOWED_CUSTOM.test(property) && HEX.test(value)
        : MASK.test(property)
          ? HEX.test(value.replace(/#000\b/g, ""))
          : HEX.test(value) ||
            ((SPACING.test(property) ||
              RADIUS.test(property) ||
              property === "font-size" ||
              property === "font" ||
              property === "box-shadow") &&
              LENGTH.test(bare)) ||
            (property === "box-shadow" && /rgba?\(|hsla?\(/.test(bare));
      if (raw) out.push({ selector, property, value });
    }
  }
  return out;
}
