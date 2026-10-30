# Privacy findings

Status: open · Backend · Added 2026-10-28 · Spec 12.8

## Spec shows

- Receipt: a "1 privacy" warn pill when a step had a privacy finding.
- Trace, Privacy: a finding card, or "Nothing personal was read on this turn."

## Exists today

`shared/privacy.ts` exists, and the old stack's trace UI used it (`frontend/components/observability/privacy-note.tsx`). Neither `platform-next` nor `runtime-adapter` emits findings.

## Do

- Decide what counts as a finding (personal data patterns in tool results or files read) and where detection runs. Run it server-side, on results before they're stored.
- Store findings per step as kind and step only, never the matched value.
- Avoid false confidence: "Nothing personal was read" is a strong claim. Word it as what was checked, or show it only when detection ran.

## Done when

Findings are stored per step without the sensitive value. The receipt pill and trace card read from them, and the empty state appears only when detection ran.
