export interface TurnContext {
  turn: number;
  afterToolError?: boolean;
  afterHuman?: boolean;
  briefStale?: boolean;
  blockConflict?: boolean;
}
/** "plan" for the first turn and after an error, a conflict, a changed brief or a person's answer; "step" otherwise. */
export function effortFor(ctx: TurnContext): "plan" | "step";
