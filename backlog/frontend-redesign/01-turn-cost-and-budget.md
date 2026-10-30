# Turn cost and per-turn budget

Status: open · Backend · Added 2026-10-28 · Spec 14.8 §1, §3; 12.8

## Spec shows

- Insights tiles: **Cost (est.)**.
- "What it cost": a meter against a per-turn cap ("$1.24 estimated" / "$5.00 cap per turn"), and a per-agent split when helpers ran.
- Technical view: Input, From cache, Output, Reasoning, Model, Rates per 1M tokens.
- Check "Within budget" (see [07](07-answer-checks.md)).

## Exists today

- `RunDoc.usage` stores `input`, `cached`, `cacheWrite`, `output` and `reasoning` tokens per run, helpers included (`platform-next/src/modules/chats/chat.ts:343`).
- There's no price data on models, no cost field and no budget or cap. Usage isn't stored per helper.

## Do

- Add per-model rates (input, cached input, cache write, output, reasoning) to the model profile. Without rates, show "Cost unavailable", never $0.
- Compute the estimated cost per run, and per agent when helpers ran.
- Decide where the per-turn cap comes from (model, agent or workspace setting) and what happens at the cap: warn only, or stop.
- Send cost and cap with the run so the panel needs no second lookup.

## Done when

A completed turn shows its estimated cost, the cap and the per-helper split, computed from the stored rates. A model without rates says so instead of showing a number.

Related: `backlog.txt` "Observability: cost in dollars per turn/session".
