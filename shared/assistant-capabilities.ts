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
    name: "Web research",
    description:
      "Research current information and cite sources. Requires provider web support or a connected web tool.",
    prompt:
      "Research the latest information about this and cite your sources: ",
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
  heights?: Array<[number, number]>;
  height?: number;
}
