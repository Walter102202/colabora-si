import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Supabase CLI applies migrations by the full numeric prefix (20261030000200_...);
// OWNERS.json maps them by the _00NN_ sequence. Both orders must agree, the sequence
// must be contiguous, and every migration must have an owner.
const root = resolve(__dirname, "../..");
const files = readdirSync(resolve(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const parsed = files.map((name) => {
  const m = /^(\d{14})_(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
  if (!m) throw new Error(`migration name does not match <14 digits>_<4 digits>_<snake_case>.sql: ${name}`);
  return { name, prefix: m[1], seq: Number(m[2]) };
});
const owners = JSON.parse(readFileSync(resolve(root, "OWNERS.json"), "utf8")) as { owners: Record<string, string[]> };
const patterns = Object.values(owners.owners).flat();

describe("migration order", () => {
  it("has at least the twelve deployed migrations", () => {
    expect(parsed.length).toBeGreaterThanOrEqual(12);
  });

  it("orders by full prefix exactly as by _00NN_ sequence", () => {
    const byPrefix = [...parsed].sort((a, b) => a.prefix.localeCompare(b.prefix)).map((m) => m.name);
    const bySeq = [...parsed].sort((a, b) => a.seq - b.seq).map((m) => m.name);
    expect(byPrefix).toEqual(bySeq);
  });

  it("numbers migrations contiguously from 0001 without gaps or duplicates", () => {
    const seqs = parsed.map((m) => m.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("maps every migration to an owner in OWNERS.json", () => {
    const missing = parsed.filter((m) => !patterns.includes(`supabase/migrations/*_${String(m.seq).padStart(4, "0")}_*`)).map((m) => m.name);
    expect(missing).toEqual([]);
  });
});
