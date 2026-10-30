# Footprint: read vs changed, file counts

Status: open · Backend · Added 2026-10-28 · Spec 14.5 §3, 14.6, 14.7

## Spec shows

- Activity **Footprint**: "Read-only unless listed under Changed". A **Read** row lists each system read, with "Reading now". A **Changed** row lists each change with a before → after diff ("FIN tickets 41 → 42").
- Agent tab, "Allowed, and used this turn": each server, skill and knowledge source with the steps that used it, or "Planned" / "Not used".
- Files tab: **Made / Read / Edited** counted apart. Also "Read, not changed" knowledge documents and "Also available, not opened".

## Exists today

- Connectors list their `writeTools` (`platform-next/src/modules/connectors/connector.ts:109`), so a tool call can be classed as read or write.
- Saved files have versions, so "edited" can be derived as a new version of an existing file.
- There are no before/after values for a write, no stored read/changed summary per run, and no record of which uploads a turn opened.

## Do

- Per run, store the tool calls grouped by connector and classed read/write from `writeTools`.
- Decide whether a write's before/after can be shown at all. MCP results are free-form, so this probably needs an optional structured result convention; otherwise show the action sentence only.
- Record which workspace files and uploads each turn read, made and edited.

## Done when

A finished turn's Footprint and Files tab reload with the same counts they showed live. A write with no structured result shows its action, not a made-up diff.
