#!/usr/bin/env node
// Ownership check: every changed file must belong to the track named by the
// branch prefix (a/ -> A, b/ -> B, infra/ -> infra), according to OWNERS.json.
//
// Usage:
//   node scripts/check-ownership.mjs                 # owner from the current branch, diff against main
//   node scripts/check-ownership.mjs --base origin/main
//   node scripts/check-ownership.mjs --owner B       # force the owner (CI, detached HEAD)
//   node scripts/check-ownership.mjs --strict        # fail instead of skipping when no owner can be inferred
//
// Exit code 1 lists the offending files. No dependencies.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const strict = args.includes("--strict");

const git = (...gitArgs) => {
  try {
    return execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const ownership = JSON.parse(readFileSync(resolve(root, "OWNERS.json"), "utf8"));
const { owners } = ownership;
const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git("rev-parse", "--abbrev-ref", "HEAD");
const exceptions = new Set(ownership.branchExceptions?.[branch] ?? []);

function inferOwner() {
  const forced = flag("--owner");
  if (forced) return forced;
  const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch.startsWith("a/")) return "A";
  if (branch.startsWith("b/")) return "B";
  if (branch.startsWith("infra/")) return "infra";
  return null;
}

function changedFiles() {
  const files = new Set();
  const add = (out) =>
    out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => files.add(f));
  let base = flag("--base");
  if (!base) {
    if (git("rev-parse", "--verify", "--quiet", "main")) base = "main";
    else if (git("rev-parse", "--verify", "--quiet", "origin/main")) base = "origin/main";
  }
  if (base) {
    const mergeBase = git("merge-base", base, "HEAD");
    if (mergeBase) add(git("diff", "--name-only", mergeBase, "HEAD"));
  }
  add(git("diff", "--name-only", "HEAD"));
  add(git("diff", "--name-only", "--cached"));
  add(git("ls-files", "--others", "--exclude-standard"));
  return [...files];
}

function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return pattern.endsWith("/") ? new RegExp(`^${escaped}`) : new RegExp(`^${escaped}$`);
}

const rules = Object.entries(owners).flatMap(([owner, patterns]) =>
  patterns.map((pattern) => ({ owner, pattern, regex: patternToRegex(pattern) })),
);

function ownerOf(file) {
  let best = null;
  for (const rule of rules) {
    if (rule.regex.test(file) && (!best || rule.pattern.length > best.pattern.length)) best = rule;
  }
  return best ? best.owner : null;
}

const owner = inferOwner();
if (!owner) {
  const msg = "check-ownership: no owner prefix on this branch (expected a/, b/ or infra/)";
  if (strict) {
    console.error(`${msg}; failing because --strict was given.`);
    process.exit(1);
  }
  console.log(`${msg}; nothing to check.`);
  process.exit(0);
}
if (!owners[owner]) {
  console.error(`check-ownership: unknown owner "${owner}" (known: ${Object.keys(owners).join(", ")})`);
  process.exit(1);
}

const files = changedFiles();
const offending = files.filter((f) => ownerOf(f) !== owner && !exceptions.has(f)).map((f) => `${f}  (owner: ${ownerOf(f) ?? "none"})`);

if (offending.length) {
  console.error(`check-ownership: branch owner is ${owner}, but these files belong to someone else:\n  ${offending.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-ownership: ${files.length} changed file(s), owned by ${owner} or explicitly allowed for ${branch}.`);
