import { describe, expect, it } from "vitest";

// Two sessions of the same agent race for one queued task through PostgREST: exactly one wins.
// Runs only against a local stack. Before running, create exactly one queued task delegated to the agent
// and export: A_DB_URL (API URL), A_ANON_KEY (publishable/anon key), A_AGENT_JWT_1 and A_AGENT_JWT_2
// (two access tokens of that agent, e.g. two agent-token exchanges).
const url = process.env.A_DB_URL;
const anonKey = process.env.A_ANON_KEY ?? "";
const jwt1 = process.env.A_AGENT_JWT_1 ?? "";
const jwt2 = process.env.A_AGENT_JWT_2 ?? "";

type ClaimResult = { status: number; body: { task_id?: string | null; message?: string } };

async function claim(jwt: string, harness: string): Promise<ClaimResult> {
  const res = await fetch(`${url}/rest/v1/rpc/claim_task`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_harness: harness }),
  });
  return { status: res.status, body: (await res.json()) as ClaimResult["body"] };
}

describe.skipIf(!url)("claim_task under concurrency", () => {
  it("gives a single queued task to exactly one of two parallel claims", async () => {
    const results = await Promise.all([claim(jwt1, "claude_code"), claim(jwt2, "codex")]);
    const winners = results.filter((r) => r.status === 200 && typeof r.body.task_id === "string");
    const losers = results.filter((r) => !(r.status === 200 && typeof r.body.task_id === "string"));
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    const lostCleanly =
      (loser.status === 200 && loser.body.task_id === null) || loser.body.message === "run_active";
    expect(lostCleanly).toBe(true);
  });
});
