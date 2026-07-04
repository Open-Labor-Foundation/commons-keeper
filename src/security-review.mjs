#!/usr/bin/env node
/**
 * security-review.mjs
 *
 * Runs the full-org security review across every repo listed in
 * config/security-review-targets.json: an LLM code-logic pass over code
 * changed since the last run (or a bounded first-run baseline), an
 * `npm audit` dependency pass sourced from the GitHub Advisory Database,
 * and — for direct-dependency findings with no upstream fix — a proposed
 * in-repo mitigation PR (never merged automatically, never touches a
 * third-party repo). Files GitHub issues for findings that clear their
 * respective thresholds.
 *
 * Usage:
 *   node src/security-review.mjs [--dry-run] [--repo <name>]
 *     [--targets <path>] [--state <path>] [--work-dir <path>]
 *     [--confidence-threshold <1-10>] [--dependency-severity-threshold <level>]
 *     [--no-mitigations]
 *
 * The dependency-audit pass needs no LLM key and always runs. The code-logic
 * pass and the mitigation-proposal pass both need GH_TOKEN (issues/PR write
 * on each target repo) and FEATHERLESS_API_KEY (or another OpenAI-compatible
 * provider via SECURITY_REVIEW_BASE_URL / SECURITY_REVIEW_MODEL) — without a
 * key, both are skipped (logged, not fatal) and the dependency audit still
 * runs.
 */

import path from "node:path";
import process from "node:process";

import { runSecurityReview, formatSecurityReviewSummary } from "./lib/security-review.mjs";

function usage() {
  process.stdout.write(`Usage:
  node src/security-review.mjs [--dry-run] [--repo <name>] [--targets <path>]
    [--state <path>] [--work-dir <path>] [--confidence-threshold <1-10>]
    [--dependency-severity-threshold <info|low|moderate|high|critical>]
    [--no-mitigations]
`);
}

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = process.cwd();
const dryRun = rawArgs.includes("--dry-run");
const repoFilter = getArg("--repo");
const targetsPath = getArg("--targets", path.join(repoRoot, "config", "security-review-targets.json"));
const statePath = getArg("--state", path.join(repoRoot, "state", "security-review-state.json"));
const workRoot = getArg("--work-dir", path.join(repoRoot, "state", "security-review-checkouts"));
const confidenceThreshold = Number(getArg("--confidence-threshold", "8"));
const dependencySeverityThreshold = getArg(
  "--dependency-severity-threshold",
  process.env.SECURITY_REVIEW_DEPENDENCY_SEVERITY ?? "high"
);
const proposeMitigations = !rawArgs.includes("--no-mitigations") && process.env.SECURITY_REVIEW_PROPOSE_MITIGATIONS !== "false";

const apiKey = process.env.FEATHERLESS_API_KEY ?? process.env.SECURITY_REVIEW_API_KEY;
if (!apiKey) {
  console.error("Warning: no FEATHERLESS_API_KEY / SECURITY_REVIEW_API_KEY configured — code-logic review and mitigation proposals will be skipped, dependency audit still runs.");
}

const summary = await runSecurityReview({
  targetsPath,
  statePath,
  workRoot,
  apiKey,
  baseUrl: process.env.SECURITY_REVIEW_BASE_URL,
  model: process.env.SECURITY_REVIEW_MODEL,
  confidenceThreshold,
  dependencySeverityThreshold,
  proposeMitigations,
  dryRun,
  repoFilter
});

process.stdout.write(formatSecurityReviewSummary(summary));
