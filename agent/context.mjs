// Prune old tool results in batches, keeping the protected prompt and recent turns intact.
export const ELIDED_NOTE = "Older tool result removed to fit the context budget. Read it again if you need it.";

/** @param {object[]} messages */
export function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * Mutates only old tool contents; elisions are permanent to keep the prompt cache stable between batches.
 * @param {Array<{role?: string, content?: unknown}>} messages
 * @param {{budgetTokens: number, keepTurns: number}} opts
 * @returns {{elided: number, tokens: number}}
 */
export function trimMessages(messages, { budgetTokens, keepTurns }) {
  const tokens = estimateTokens(messages);
  if (tokens <= budgetTokens) return { elided: 0, tokens };

  // With fewer than keepTurns, every turn is recent and must remain intact.
  let cut = keepTurns > 0 ? 2 : messages.length;
  let turns = 0;
  for (let i = messages.length - 1; i >= 2 && keepTurns > 0; i--) {
    if (messages[i].role === "assistant" && ++turns >= keepTurns) {
      cut = i;
      break;
    }
  }
  let elided = 0;
  for (let i = 2; i < cut; i++) {
    const message = messages[i];
    if (message.role !== "tool" || (typeof message.content === "string" && message.content.startsWith('{"elided":true'))) continue;
    message.content = JSON.stringify({ elided: true, note: ELIDED_NOTE });
    elided++;
  }
  return { elided, tokens: estimateTokens(messages) };
}
