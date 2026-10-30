// The Agent ID desk (DESIGN-SPEC 15.3): pure helpers for its form.

// Only a name and a purpose are required; the desk names the first missing.
export function deskProblem(form: {
  name: string;
  description: string;
}): string | null {
  if (!form.name.trim()) return "Give it a name";
  if (!form.description.trim()) return "Say what it's for";
  return null;
}

// The model cards shown before "All models": the catalogue's first three, with
// the selected model swapped in when it isn't among them.
export function featuredModels<T extends { id: string }>(
  models: readonly T[],
  selectedId: string,
): T[] {
  const first = models.slice(0, 3);
  if (!selectedId || first.some((m) => m.id === selectedId)) return first;
  const selected = models.find((m) => m.id === selectedId);
  return selected ? [...first.slice(0, 2), selected] : first;
}

export const DESK_STEPS = [
  {
    id: "identity",
    label: "Identity",
    sub: "Who it is and what it’s for. This prints on the front of its ID.",
  },
  {
    id: "access",
    label: "Access",
    sub: "What it can open and what it’s good at. This prints on the back.",
  },
  {
    id: "rules",
    label: "Rules",
    sub: "What it answers, the rules it follows, and how it comes across.",
  },
  {
    id: "sign",
    label: "Sign & issue",
    sub: "Who can use it, and your signature.",
  },
] as const;

export type DeskStep = (typeof DESK_STEPS)[number]["id"];

// ---- Rules step and signature (DESIGN-SPEC 15.1 `instructions`, `sig`) ----

/** How a rules or behaviour list is written: one bullet per line, or prose. */
export type GuideAs = "list" | "text";
/** "focused" answers only within its purpose; "open" takes general questions too. */
export type Topics = "focused" | "open";

export interface DeskGuide {
  topics: Topics;
  rules: string;
  rulesAs: GuideAs;
  behaviour: string;
  behaviourAs: GuideAs;
  /** An SVG path in a 240×60 box, or empty when unsigned. */
  sig: string;
}

export const BLANK_GUIDE: DeskGuide = {
  topics: "focused",
  rules: "",
  rulesAs: "list",
  behaviour: "",
  behaviourAs: "list",
  sig: "",
};

export const GUIDE_ITEMS = 12;
export const GUIDE_ITEM_MAX = 160;
export const GUIDE_TEXT_MAX = 1200;

// Ready-made lines to start from; each disappears once it's been added.
export const RULE_IDEAS = [
  "Never share customer data outside the workspace",
  "Cite the source for every claim",
  "Escalate to a human when unsure",
  "Stay out of production on Fridays",
];
export const BEHAVIOUR_IDEAS = [
  "Be concise",
  "Lead with the answer",
  "Ask before assuming",
  "Friendly, not chatty",
];

/** The non-empty, trimmed lines of a rules or behaviour string. */
export const linesOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export const plural = (n: number, one: string, many = one + "s") =>
  `${n} ${n === 1 ? one : many}`;

// Cuts at a word boundary when one is near the end, and adds an ellipsis.
export function clip(text: string, n: number): string {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  const space = cut.lastIndexOf(" ");
  return (
    (space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "") +
    "…"
  );
}

export const TOPIC_OPTIONS: {
  id: Topics;
  label: string;
  hint: (purpose: string) => string;
}[] = [
  {
    id: "focused",
    label: "Only its purpose",
    hint: (purpose) =>
      purpose
        ? `Sticks to “${clip(purpose, 70)}” and politely declines anything else.`
        : "Sticks to the purpose you gave it and politely declines anything else.",
  },
  {
    id: "open",
    label: "General questions too",
    hint: () => "Answers anything it’s asked, then gets back to its job.",
  },
];

// An idea added in Text mode joins the prose as its own sentence.
export function withIdea(text: string, idea: string): string {
  const prose = text.trim();
  return (
    prose ? prose.replace(/[.!]?$/, ". ") + idea + "." : idea + "."
  ).slice(0, GUIDE_TEXT_MAX);
}

// The card's Guide line: "on-purpose only · 3 rules · behaviour written".
export function guideSummary(guide: DeskGuide): string {
  const count = (text: string, as: GuideAs, one: string, written: string) => {
    const n = linesOf(text).length;
    return !n ? "" : as === "text" ? written : plural(n, one);
  };
  return [
    guide.topics === "open" ? "any topic" : "on-purpose only",
    count(guide.rules, guide.rulesAs, "rule", "rules written"),
    count(guide.behaviour, guide.behaviourAs, "behaviour", "behaviour written"),
  ]
    .filter(Boolean)
    .join(" · ");
}

// A pre-drawn squiggle for "Sign for me" (and keyboard users), in the pad's
// 240×60 box.
export const AUTO_SIG =
  "M10 42c6-20 14-30 16-22s-6 24-2 24 10-26 16-24-4 20 2 20 8-14 12-14 2 12 6 12 6-16 12-16 0 14 6 14 10-8 14-12M86 30c6-8 10-10 10-4s-4 14 2 12 8-14 14-12 2 10 8 8 14-12 22-12M20 50c40-4 100-8 170-12";
