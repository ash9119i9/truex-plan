# Chart layer

Status: open · Design · Added 2026-10-28 · Spec 16, 0.1, 19.4

## Gap

Chart colour and type are locked, but the chart forms are "on trial" (`system/chart-studies.html`). The panel already relies on them: the Insights bars, meters and comparison strips, the trace waterfall and context jar, and the Files tab preview chart.

## Do

- Lock the chart forms the screens use.
- Specify the accessible twin for each form: a `role="img"` label listing the values, or a table.
- Decide whether in-reply Visualize charts (`docs/VISUALIZE.md`) follow this layer or stay separate.

## Done when

Chapter 16 marks the forms Locked, and every chart in the screens maps to one of them.
