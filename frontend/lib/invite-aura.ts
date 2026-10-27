// Profile aura for the join page (join-tenant-v3-dev-spec.html, "Profile specimen aura hash").
// Returns CSS custom property names: [--a1 dot, --a2 dot, --a3 soft fill].
// Uses the spec's fix, (h >>> 4) % 4, so the second colour is always in range and differs from the first.

export const AURA_DOTS = [
  "--ice-dot",
  "--mint-dot",
  "--butter-dot",
  "--peach-dot",
  "--lilac-dot",
] as const;
export const AURA_SOFT = [
  "--ice",
  "--mint",
  "--butter",
  "--peach",
  "--lilac",
] as const;

export function auraFor(name: string): [string, string, string] {
  const h = [...name].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7);
  const a = h % 5;
  const b = (a + 1 + ((h >>> 4) % 4)) % 5;
  return [AURA_DOTS[a], AURA_DOTS[b], AURA_SOFT[a]];
}
