import { describe, expect, it } from "vitest";
import { formatDuration, formatTokens, formatUsd } from "@/lib/agentFormat";

describe("formatTokens", () => {
  it("formats the contract examples", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12300)).toBe("12.3k");
    expect(formatTokens(1250000)).toBe("1.25M");
  });

  it("never prints 1000k and treats invalid counts as zero", () => {
    expect(formatTokens(999950)).toBe("1M");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("formatUsd", () => {
  it("formats the contract examples", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0012)).toBe("$0.0012");
    expect(formatUsd(0.4891)).toBe("$0.49");
    expect(formatUsd(12.3)).toBe("$12.30");
  });

  it("never prints a positive amount as $0.0000", () => {
    expect(formatUsd(0.0096)).toBe("$0.0096");
    expect(formatUsd(0.00005)).toBe("<$0.0001");
    expect(formatUsd(-1)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("formatDuration", () => {
  it("formats the contract examples", () => {
    expect(formatDuration(12000)).toBe("12s");
    expect(formatDuration(185000)).toBe("3m 05s");
    expect(formatDuration(4320000)).toBe("1h 12m");
    expect(formatDuration(999)).toBe("<1s");
  });

  it("treats invalid durations as under a second", () => {
    expect(formatDuration(-1)).toBe("<1s");
    expect(formatDuration(Number.NaN)).toBe("<1s");
  });
});
