import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("prevents framing the OAuth consent screen on the hosted site", () => {
  const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  const headers = config.headers?.find((entry: { source: string }) => entry.source === "/oauth/consent")?.headers;
  expect(headers).toEqual(expect.arrayContaining([
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  ]));
});
