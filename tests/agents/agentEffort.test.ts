import { describe, expect, it } from "vitest";
import { effortFor } from "../../agent/effort.mjs";

describe("effort per turn", () => {
  it.each([
    [{ turn: 0 }, "plan"],
    [{ turn: 3 }, "step"],
    [{ turn: 3, afterToolError: true }, "plan"],
    [{ turn: 3, blockConflict: true }, "plan"],
    [{ turn: 3, briefStale: true }, "plan"],
    [{ turn: 3, afterHuman: true }, "plan"],
    [{ turn: 1, afterToolError: false, afterHuman: false, briefStale: false, blockConflict: false }, "step"],
  ])("decides %j as %s", (ctx, expected) => {
    expect(effortFor(ctx)).toBe(expected);
  });
});
