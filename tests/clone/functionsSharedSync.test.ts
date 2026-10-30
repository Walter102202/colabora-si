import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the deployed endpoint validator is a byte-for-byte copy of lib/pushEndpoint.ts", () => {
  const root = new URL("../../", import.meta.url);
  expect(readFileSync(new URL("supabase/functions/send-reminders/endpoint.ts", root)))
    .toEqual(readFileSync(new URL("lib/pushEndpoint.ts", root)));
});
