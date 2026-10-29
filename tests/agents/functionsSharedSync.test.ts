// The Edge Functions deploy only supabase/functions/, so pure modules of lib/ are copied into
// supabase/functions/_shared/lib/. This test fails when a copy drifts from its source.
// The copies use relative imports ("./types.ts") where the app uses the "@/lib/..." alias.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const SHARED = ["agentInput", "types", "dbCompute", "dbFilter", "routes", "agentApprovalText", "agentLinks"];

function asCopied(source: string): string {
  return source.replace(/from "@\/lib\/([A-Za-z]+)"/g, 'from "./$1.ts"');
}

describe("supabase/functions/_shared/lib mirrors lib/", () => {
  for (const name of SHARED) {
    const source = `${root}lib/${name}.ts`;
    const copy = `${root}supabase/functions/_shared/lib/${name}.ts`;
    // lib/agentInput.ts arrives with another branch; until then there is nothing to compare.
    it.skipIf(!existsSync(source))(`${name}.ts matches its source`, () => {
      expect(existsSync(copy)).toBe(true);
      expect(readFileSync(copy, "utf8")).toBe(asCopied(readFileSync(source, "utf8")));
    });
  }
});
