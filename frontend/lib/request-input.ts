export interface InputOption {
  label: string;
  description?: string;
}
export interface InputQuestion {
  id: string;
  kind?: "toolApproval";
  header?: string;
  question: string;
  action?: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: InputOption[] | null;
}

// Codex matches tool approvals on the option label, so the submitted value
// always stays the original label; this only changes what the user reads.
const approvalLabels: Record<string, string> = {
  Allow: "Allow once",
  "Allow for this session": "Allow for this chat",
  "Allow and don't ask me again": "Always allow",
  Cancel: "Don't allow",
};
export function optionLabel(q: InputQuestion, option: InputOption): string {
  return q.kind === "toolApproval"
    ? approvalLabels[option.label] || option.label
    : option.label;
}
export function isDecline(q: InputQuestion, option: InputOption): boolean {
  return q.kind === "toolApproval" && option.label === "Cancel";
}

// A lone multiple-choice question is answered by its click; anything else
// needs the user to review their answers and submit them together.
export function answersOnClick(questions: InputQuestion[]): boolean {
  return questions.length === 1 && !!questions[0].options?.length;
}
// Free text is shown when there is nothing to pick from, or the user chose
// to write their own answer.
export function needsText(q: InputQuestion, other: boolean): boolean {
  return !q.options?.length || (other && q.isOther === true);
}
export function complete(
  questions: InputQuestion[],
  answers: Record<string, string>,
): boolean {
  return questions.every((q) => (answers[q.id] || "").trim() !== "");
}
// Questions are asked one at a time. Picking an option moves to the next
// question; on the last one it sends, provided every question is answered.
export function afterPick(
  questions: InputQuestion[],
  step: number,
  answers: Record<string, string>,
): "next" | "send" | "wait" {
  if (step < questions.length - 1) return "next";
  return complete(questions, answers) ? "send" : "wait";
}
export function answerPayload(
  questions: InputQuestion[],
  answers: Record<string, string>,
) {
  return {
    answers: Object.fromEntries(
      questions.map((q) => [q.id, { answers: [(answers[q.id] || "").trim()] }]),
    ),
  };
}
export function timeLeft(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return "";
  const min = Math.ceil(ms / 60000);
  return min <= 1 ? "Expires in under a minute" : `Expires in ${min} min`;
}
