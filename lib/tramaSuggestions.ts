export interface TramaContext {
  kind: "home" | "text" | "database" | "task";
  selection: boolean;
  decisions: number;
  lang: "es" | "en";
}

export function tramaSuggestions(ctx: TramaContext): string[] {
  const es = ctx.lang === "es";
  const suggestions: string[] = [];
  if (ctx.selection) suggestions.push(es ? "Explícame lo seleccionado" : "Explain the selection");
  if (ctx.decisions > 0) suggestions.push(es ? "¿Qué necesita mi decisión primero?" : "What needs me first?");
  const labels = {
    home: es ? "¿Qué debería mirar hoy?" : "What should I look at today?",
    text: es ? "Resume esta página" : "Summarize this page",
    database: es ? "¿Qué sigue abierto aquí?" : "What is still open here?",
    task: es ? "¿Qué está frenando esta tarea?" : "What is blocking this task?",
  };
  return [...suggestions, labels[ctx.kind]].slice(0, 3);
}
