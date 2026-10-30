# Full icon set

Status: open · Design · Added 2026-10-28 · Spec 7, 0.1, 19.5 M8

## Gap

- The rev-02 continuous hand is the approved drawing, but only 5 of the 34 planned glyphs are drawn (`n-run n-agent n-trace n-tool n-search` in `system/icon-foundations.html`).
- The chat sprite's five glyphs (`i-run i-agent i-trace i-tool i-search`) are pre-rev-02 geometry and must be redrawn before shipping (M8).
- The screens use 56 sprite ids (7.3), beyond the planned 34. Duplicate aliases (`chevd`/`chev-down`, `chevl`/`chev-l`, `chevr`/`chev`, `warn`/`alert`) collapse to one id each.

## Do

- Draw the remaining 29 glyphs in rev 02 (Execution, Agents, Tools, Data, Files, System, as listed in 7.4) and get sign-off on the set.
- Map every sprite id the screens use to one of the 34, or raise it as a system request for a new glyph.
- Ship one sprite file, so swapping in the drawn set is a sprite change only.

## Done when

All 34 are drawn and signed off, every id the screens use resolves to the set, and `lucide-react` can be removed from the frontend.
