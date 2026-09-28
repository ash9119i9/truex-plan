export const suggestionInstructions = `
Follow-up suggestions: when a final answer completes the user's request and there are useful next steps, end the answer with up to three short follow-up questions the user is likely to ask next, based on their latest message and your answer. Use this exact format, each marker on its own line, as the very last thing in the answer:
[truex-suggestions]
- First follow-up question?
- Second follow-up question?
[/truex-suggestions]
Write each question as the user would type it to you, in the user's language, under 80 characters, plain text without Markdown. Only suggest things you can actually do with the available tools. Omit the block when you are asking the user a clarifying question, waiting for approval, reporting an error or refusal, replying to a greeting or trivial message, or writing a helper/sub-agent report. Never put the block inside a code block and never mention it.`;
