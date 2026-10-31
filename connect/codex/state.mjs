import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomic local delivery state, shared by the watcher, Stop hook and reference agent. */
export function fileState(path) {
  return {
    load() {
      try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(state));
      renameSync(`${path}.tmp`, path);
    },
  };
}
