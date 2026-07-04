/**
 * config-state.mjs
 *
 * Loading config/security-review-targets.json and reading/writing the
 * per-repo review state (last reviewed commit) persisted under
 * state/security-review-state.json.
 */

import fs from "node:fs";
import path from "node:path";

export function loadTargets(targetsPath) {
  return JSON.parse(fs.readFileSync(targetsPath, "utf8"));
}

export function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { repos: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" ? { repos: {}, ...parsed } : { repos: {} };
  } catch {
    return { repos: {} };
  }
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
