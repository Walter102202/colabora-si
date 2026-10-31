import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Supabase CLI applies migrations by the full numeric prefix (20261030000200_...);
// OWNERS.json maps them by the _00NN_ sequence. Both orders must agree, every migration
// must have an owner, and the sequence must be contiguous on main. A branch may skip the
// numbers OWNERS.json reserves for a part that is not merged yet.
const root = resolve(__dirname, "../..");
const files = readdirSync(resolve(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const parsed = files.map((name) => {
  const m = /^(\d{14})_(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
  if (!m) throw new Error(`migration name does not match <14 digits>_<4 digits>_<snake_case>.sql: ${name}`);
  return { name, prefix: m[1], seq: Number(m[2]) };
});
const owners = JSON.parse(readFileSync(resolve(root, "OWNERS.json"), "utf8")) as { owners: Record<string, string[]> };
const patterns = Object.values(owners.owners).flat();
const reserved = new Set(patterns.flatMap((p) => {
  const m = /^supabase\/migrations\/\*_(\d{4})_\*$/.exec(p);
  return m ? [Number(m[1])] : [];
}));
// A pull request is judged by where it lands, a push by its own branch.
const target = process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME
  || execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();

function openGaps(seqs: number[], reservedSeqs: Set<number>, strict: boolean) {
  const missing = Array.from({ length: Math.max(0, ...seqs) }, (_, i) => i + 1).filter((n) => !seqs.includes(n));
  return strict ? missing : missing.filter((n) => !reservedSeqs.has(n));
}

describe("migration order", () => {
  it("has at least the twelve deployed migrations", () => {
    expect(parsed.length).toBeGreaterThanOrEqual(12);
  });

  it("orders by full prefix exactly as by _00NN_ sequence", () => {
    const byPrefix = [...parsed].sort((a, b) => a.prefix.localeCompare(b.prefix)).map((m) => m.name);
    const bySeq = [...parsed].sort((a, b) => a.seq - b.seq).map((m) => m.name);
    expect(byPrefix).toEqual(bySeq);
  });

  it("numbers migrations without duplicates", () => {
    const seqs = parsed.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("numbers migrations from 0001, with only reserved gaps off main", () => {
    expect(openGaps(parsed.map((m) => m.seq), reserved, target === "main")).toEqual([]);
  });

  it("maps every migration to an owner in OWNERS.json", () => {
    const missing = parsed.filter((m) => !patterns.includes(`supabase/migrations/*_${String(m.seq).padStart(4, "0")}_*`)).map((m) => m.name);
    expect(missing).toEqual([]);
  });
});

describe("gaps in the migration sequence", () => {
  it("finds none in a contiguous sequence", () => {
    expect(openGaps([1, 2, 3], new Set(), false)).toEqual([]);
  });

  it("accepts on a branch a gap reserved for another part", () => {
    expect(openGaps([1, 2, 5], new Set([3, 4]), false)).toEqual([]);
  });

  it("rejects on a branch a gap nobody reserved", () => {
    expect(openGaps([1, 2, 5], new Set([3]), false)).toEqual([4]);
  });

  it("rejects on main even a reserved gap", () => {
    expect(openGaps([1, 2, 5], new Set([3, 4]), true)).toEqual([3, 4]);
  });
});
