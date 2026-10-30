# Sources the answer was built from

Status: open · Backend · Added 2026-10-28 · Spec 14.5 §5

## Spec shows

"Answer built from" (meta "6 sources" / "so far"). Each row has a mark, a name, a kind and "Step ‹n›" (clicking it jumps to the step). The first 4 show, then "Show ‹n› more". When stopped: "Read before you stopped it" and "The web pages it had opened weren't kept."

## Exists today

No sources or citation model was found in `platform-next` or `runtime-adapter`. Web search, tool calls and file reads appear as stream items only.

## Do

- Define a source: a web page opened, a connector record read, or a workspace file or upload read. Each has a name, a kind and the step that read it.
- Build the list from the turn's items when it settles, and store it with the run.
- Decide whether only sources the answer actually used count, which needs model citations, or every source read. Start with every source read and label it that way.

## Done when

A finished turn lists its sources with working step links, and the stopped-turn copy appears when it applies.
