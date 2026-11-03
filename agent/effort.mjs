// Reasoning effort per turn: think more when the turn decides something, less when it only executes.

/**
 * A planning turn is the first one of a run, and any turn right after the model learned something that changes the plan:
 * a tool refused or failed, a block conflicted, the brief changed, or a person answered.
 * @param {{turn: number, afterToolError?: boolean, afterHuman?: boolean, briefStale?: boolean, blockConflict?: boolean}} ctx
 * @returns {"plan" | "step"}
 */
export function effortFor({ turn, afterToolError = false, afterHuman = false, briefStale = false, blockConflict = false }) {
  return turn === 0 || afterToolError || afterHuman || briefStale || blockConflict ? "plan" : "step";
}
