# Agent: behaviors of a sharp assistant

Status: open · Added 2026-10-19

## Goal

Things the agent does without being asked, like a good human assistant would. This builds on three items already planned: give fuller, better-quality answers; suggest follow-up questions after the reply streams; break complex tasks into todo lists. UI basics are in [01-chat-ux-basics.md](01-chat-ux-basics.md).

About half of these need only the system prompt. The cheapest first step is a prompt section for the General Agent (code-owned, so it ships with the platform).

## Before starting work

- [ ] 1. Restate the goal in one line ("You want a Q3 competitor pricing comparison for your board deck").
- [ ] 2. List assumptions ("Assuming USD, enterprise tiers only, public pricing pages. Tell me if any is wrong").
- [ ] 3. Clarifying questions as one-tap chips: [Executive summary] [Detailed analysis] [Both].
- [ ] 4. For big tasks, show the plan before running it: [Start] [Edit plan].
- [ ] 5. Time and effort estimate ("About 8 searches and 2 documents, roughly 2 minutes").

## While working

- [ ] 6. Quick answer first, then go deep ("Refining with sources…").
- [ ] 7. Report findings, not just steps ("Found 3 competitors; Acme raised prices 12% in August").
- [ ] 8. Say why a tool was chosen ("Checking Jira because you mentioned the sprint").

## In the answer

- [ ] 9. Pick the format for the content: comparisons as a table, steps as a checklist, trends as a chart (Visualize).
- [ ] 10. Bold the one line the user came for.
- [ ] 11. Flag confidence ("Confident on pricing (official pages). Unsure on discounts (one forum post)").
- [ ] 12. Point out a wrong premise politely ("Acme discontinued that plan in July, so I compared its replacement").
- [ ] 13. End complex tasks with "Decided: … Still open: …".
- [ ] 14. Say what wasn't done ("Couldn't access the paywalled Gartner report, so market size is an estimate").

## After the answer

- [ ] 15. Offer the next action, not only a question ("Want this as a PowerPoint for the board?", "Draft the email to the team?"), using existing document tools.
- [ ] 16. Depth controls on short answers: [More detail] [Simpler] [Shorter].
- [ ] 17. Offer to save a good prompt as a reusable template ("Save as 'Weekly competitor check'?").
- [ ] 18. Offer to schedule recurring tasks ("Run this every Monday?").

## Across conversations

- [ ] 19. Remember preferences once ("You prefer tables and INR, so I've used both").
- [ ] 20. Resume naturally ("Last time we were halfway through the Q3 analysis. Continue?").
- [ ] 21. "Catch me up": one-tap summary of a long thread.
- [ ] 22. Suggest a better agent ("This is a legal question. @legalagent has the contract tools. Switch?").

## Self-quality

- [ ] 23. Hidden self-check before the final answer: every part answered, numbers add up, sources real.
- [ ] 24. Track multi-part questions: if the user asked four things, answer all four in order.

## Effort

| Items | Needs |
|---|---|
| 1, 2, 6, 7, 9–14, 23, 24 | System prompt only |
| 15 | Prompt plus existing document tools |
| 3 | Small UI on the existing clarification flow |
| 4, 5 | Small UI on the existing plans and todos |
| 8 | Prompt, plus showing the reason in tool activity |
| 16, 21 | Small UI that sends a canned follow-up |
| 22 | Agent catalog lookup plus a switch action |
| 17 | Template store |
| 18 | Scheduler (none today) |
| 19, 20 | Memory store per user, a bigger lift |

## Open decisions

1. Which items go into the General Agent prompt first (recommended: 1, 2, 12, 14, 23, 24).
2. Whether these rules apply to user-created agents too, as a platform prompt layer, or only to the General Agent.
3. Where per-user memory lives, and how the user sees and deletes it (needed before 19, 20).

## Done when

- The chosen prompt rules are in the General Agent, and a small set of fixed test prompts shows the behavior (goal restated, assumptions listed, gaps stated, all parts answered).
- Prompt changes don't break prompt caching (stable prefix; see [model-provider/01-prompt-caching.md](../model-provider/01-prompt-caching.md)).
- Each UI item is checked in a real browser.
