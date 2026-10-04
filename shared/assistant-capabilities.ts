export const assistantCapabilities = [
  {
    id: "explain",
    name: "Understand and explain",
    description: "Answer questions, summarize material, and plan a task.",
    prompt: "Help me understand and plan this task: ",
  },
  {
    id: "questions",
    name: "Ask for details",
    description:
      "Ask focused questions and offer choices when a preference matters.",
    prompt: "Help me clarify my requirements. Ask me focused questions about: ",
  },
  {
    id: "web",
    name: "Web search",
    description:
      "Search the web for current information and cite result links. Built-in WebSearch works across model providers when enabled.",
    prompt:
      "Search the web for the latest information about this and cite your sources: ",
  },
  {
    id: "webRead",
    name: "Web read",
    description:
      "Read a public web page from its URL as bounded Markdown, then summarize or discuss its content.",
    prompt: "Read this public web page URL and summarize its content: ",
  },
  {
    id: "webCrawl",
    name: "Web crawl",
    description:
      "Collect pages from a public website in the background. Track progress, cancel the crawl, and read or download its saved Markdown.",
    prompt:
      "Crawl this public website and collect its pages in the background: ",
  },
  {
    id: "documents",
    name: "Documents",
    description:
      "Read and create PDF, Word, Excel, and PowerPoint files. Revise content as a new downloadable version.",
    prompt: "Create a downloadable document about: ",
  },
  {
    id: "visualize",
    name: "Visualize",
    description:
      "Explore interactive charts, diagrams, simulations, and visual explanations inside the conversation.",
    prompt: "Create an interactive visualization to help me explore: ",
  },
  {
    id: "goals",
    name: "Goal tracking",
    description: "Set an explicit goal and view its progress with /goal.",
    prompt: "/goal ",
  },
  {
    id: "collaboration",
    name: "Collaboration",
    description:
      "Delegate independent tasks to helper agents and combine their findings.",
    prompt: "Use helper agents to work on independent parts of this task: ",
  },
] as const;

export function webReadAvailabilityMessage(
  available: boolean | null,
): string | null {
  if (available === null) return null;
  return available
    ? "Built-in WebRead is available in this conversation."
    : "Built-in WebRead is unavailable in this conversation. Start a new conversation after WebRead is enabled.";
}

export function webCrawlAvailabilityMessage(
  available: boolean | null,
): string | null {
  if (available === null) return null;
  return available
    ? "Built-in WebCrawl is available in this conversation."
    : "Built-in WebCrawl is unavailable in this conversation. Start a new conversation after WebCrawl is enabled.";
}

export interface ConversationFile {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  mediaType: string;
  sourceId?: string;
  kind?: "visualization";
  title?: string;
  description?: string;
  mode?: "inline" | "wide";
}
