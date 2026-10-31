export const TRAMA_GREETING = "What are you up to?";

export interface TramaContext {
  kind: "home" | "text" | "database" | "task";
  selection: boolean;
  decisions: number;
}

export function tramaSuggestions(ctx: TramaContext): string[] {
  const context = {
    home: "What should I look at today?",
    text: "Can you summarize this page?",
    database: "What is still open here?",
    task: "What is blocking this task?",
  }[ctx.kind];
  const ordered = [
    ...(ctx.selection ? ["Can you explain this selection?"] : []),
    ...(ctx.decisions > 0 ? ["What needs me first?"] : []),
    context,
    "How is everything going?",
    "What should I look at today?",
    "What needs me first?",
  ];
  return [...new Set(ordered)].slice(0, 3);
}
