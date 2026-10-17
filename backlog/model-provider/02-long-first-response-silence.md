# Long silence before the first text, and the gateway first-byte timeout

Status: open · re-check on the production provider · Added 2026-10-17

## Observed

On the dev Claude profile (`thinking: true`), "Write 800 words…" took 9–20 s before the first text. The gateway sent nothing during that time, not even response headers, and no thinking events. It is unclear whether the model was thinking and the proxy hid it, or the proxy was slow.

## Why it matters

- The UI's "Still working…" state after 15 s is needed in v1.
- Chat v1 allows 180 s for the first response, but the profile's `firstByteTimeoutMs` is 60 s, so the gateway can cut off a long think first.

## Do when the real provider is configured

- Measure time to first byte and first text on the production Claude and Gemini providers, with thinking on.
- Set `firstByteTimeoutMs` on each profile to match the 180 s first-response limit, or record why not.
- Re-check together with `backlog/features/01-live-thinking.md`, which streams thinking and would fill this silence.

## Done when

Numbers are recorded here, and no normal long reply is cut off by the gateway before the adapter's own limit.
