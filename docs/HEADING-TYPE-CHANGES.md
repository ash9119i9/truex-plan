# Heading type changes

30 Oct 2026. Applies to the app screens in `system/screens/`.

## Summary

Headers were hard to read because Bricolage Grotesque was set at 80–90% of its normal width with tight letter spacing, so letters touched. Headers now use the font's normal width (`"wdth" 100`), slightly looser letter spacing and, on the big headlines, a lighter weight.

The font is unchanged: Bricolage Grotesque for headers, Instrument Serif for the italic accent phrases.

## Values

| Header | Selector | Weight | Width | Letter spacing | Optical size |
|---|---|---|---|---|---|
| Chat hero, "What should we *work on* today?" | `.cs-hero-h` | 780 → 700 | 80 → 100 | −0.045em → −0.032em | 96 → 48 |
| Agents hero, "What the *team* can help with" | `.hero h1` | 780 → 700 | 82 → 100 | −0.045em → −0.032em | 96 → 48 |
| Business activity title | `.bar-title` | 780 → 650 | 90 → 100 | −0.02em → −0.018em | 48 → 24 |
| New agent dialog title | `.nad-head h2` | 700 (same) | 90 → 100 | −0.03em → −0.025em | 48 → 32 |
| Agents page section titles | `.spec h2` | 700 (same) | 90 → 100 | −0.02em → −0.018em | 48 → 24 |
| All other screen headings | `h1, h2, h3, h4` | same | 82–90 → 100 | → −0.018em | → 24 |

Line height changed on the two heroes only: chat 1.02 → 1.08, agents 0.95 → 1.05.

## CSS to copy

### Chat hero

```css
.cs-hero-h {
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: -.032em;
  font-variation-settings: "opsz" 48, "wdth" 100;
}
```

### Agents hero

```css
.hero h1 {
  margin: 0;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -.032em;
  font-variation-settings: "opsz" 48, "wdth" 100;
}
```

### Business activity title

```css
.bar-title {
  font-weight: 650;
  letter-spacing: -.018em;
  font-variation-settings: "opsz" 24, "wdth" 100;
}
```

### New agent dialog title

```css
.nad-head h2 {
  margin: 0 0 4px;
  font: 700 var(--t-h3)/var(--lh-h3) var(--f-ui);
  letter-spacing: -.025em;
  font-variation-settings: "opsz" 32, "wdth" 100;
}
```

### Agents page section titles

```css
.spec h2 {
  letter-spacing: -.018em;
  font-variation-settings: "opsz" 24, "wdth" 100;
}
```

### All other headings

Put this after `type.css` in the app stylesheet. It replaces the narrow default cuts on every heading tag.

```css
h1, h2, h3, h4 {
  font-variation-settings: "opsz" 24, "wdth" 100;
  letter-spacing: -.018em;
}
```

Any rule with a class in its selector overrides this one. The heroes and titles above keep their own values, and existing card rules that already set their own letter spacing (for example `.attn h3` or `.dhead h3`) keep it. Only the width changes for those.

## Files changed in this repo

- `system/screens/chat.css`: `.cs-hero-h`, plus the `h1–h4` rule at the end
- `system/screens/agents.css`: `.hero h1`, `.spec h2`
- `system/screens/business-activity.css`: `.bar-title`, plus the `h1–h4` rule at the end
- `system/screens/agent-id.css`: `.nad-head h2`, plus the `h1–h4` rule at the end
- `system/screens/activity-panel.css`: the `h1–h4` rule at the end

## Not changed yet

- `system/type.css` still defines the narrow cuts (`--cut-heading`, `--cut-h2`, `--cut-display`, `--cut-hero`). The foundation pages still use them.
- `system/DESIGN-SPEC.md` sections 3.2 and 3.3 still describe the old values.
- On the Business activity screen at 1440px wide, the wider title pushes the State, Note and Crew controls onto a second row.

## Notes for the app

- The app needs the Bricolage Grotesque variable font with the width axis (75–100) loaded, as in the current Google Fonts link. Without that axis, `"wdth" 100` has no effect.
- Keep `font-optical-sizing: none` on headings so the `opsz` value set here is the one that renders.
- Don't go tighter than about −0.038em on the big headlines, or the letters start to touch again.
