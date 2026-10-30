# Comparison with the agent's usual turn

Status: open · Backend · Added 2026-10-28 · Spec 14.8 §5 · Needs [01](01-turn-cost-and-budget.md), [02](02-time-breakdown-and-step-timings.md)

## Spec shows

"Against its usual turn" (last 30 turns): two strips, **Working time** (waiting left out) and **Cost**. Each strip shows the middle-half band, a median tick and a dot for this turn, with "About / Longer / Shorter than usual" (for cost: "More / Less").

## Exists today

Nothing. There's no per-agent history query, and no stored working time or cost to aggregate.

## Do

- Endpoint: the agent's last 30 finished turns for this member. Return p25, median and p75 of working time and cost.
- Decide the scope: this member's turns, or the whole workspace's. Workspace-wide reveals other members' usage, so privacy needs review.
- Index the query (agent + owner + completedAt) so it stays cheap.
- Below a minimum sample (e.g. fewer than 5 turns), say "Not enough turns yet" instead of drawing a band.

## Done when

The strip shows real percentiles from stored runs, the query is indexed, and the low-sample case is handled.
