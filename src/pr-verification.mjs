#!/usr/bin/env node
/**
 * pr-verification.mjs
 *
 * Runs the independent claim-vs-diff PR review across every repo listed in
 * config/security-review-targets.json: for each open PR not yet reviewed at
 * its current head commit, checks whether the PR's own description ("wired
 * in," "automatic," "resolved," "verified") actually matches its diff, and
 * comments on the PR when it doesn't. See src/lib/pr-verification.mjs for
 * why this exists and what it deliberately does and doesn't check.
 *
 * Usage:
 *   node src/pr-verification.mjs [--dry-run] [--repo <name>]
 *     [--targets <path>] [--state <path>] [--confidence-threshold <0-10>]
 *
 * Needs GH_TOKEN (PR read + comment on each target repo) and
 * FEATHERLESS_API_KEY (or another OpenAI-compatible provider via
 * PR_VERIFICATION_BASE_URL / PR_VERIFICATION_MODEL) for the LLM pass --
 * without a key, only the deterministic pre-checks run (logged, not fatal).
 */

import path from "node:path";
import process from "node:process";

import { runPrVerification, formatPrVerificationSummary } from "./lib/pr-verification.mjs";
import { loadTargets, loadState, saveState } from "./lib/config-state.mjs";

function usage() {
  process.stdout.write(`Usage:
  node src/pr-verification.mjs [--dry-run] [--repo <name>] [--targets <path>]
    [--state <path>] [--confidence-threshold <0-10>]
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
const statePath = getArg("--state", path.join(repoRoot, "state", "pr-verification-state.json"));
const confidenceThreshold = Number(getArg("--confidence-threshold", "7"));

const apiKey = process.env.FEATHERLESS_API_KEY ?? process.env.PR_VERIFICATION_API_KEY;
if (!apiKey) {
  console.error("Warning: no FEATHERLESS_API_KEY / PR_VERIFICATION_API_KEY configured — only deterministic pre-checks will run, the LLM claim-vs-diff pass will be skipped.");
}

const summary = await runPrVerification({
  targetsPath,
  statePath,
  apiKey,
  baseUrl: process.env.PR_VERIFICATION_BASE_URL,
  model: process.env.PR_VERIFICATION_MODEL,
  confidenceThreshold,
  dryRun,
  repoFilter,
  loadTargets,
  loadState,
  saveState
});

process.stdout.write(formatPrVerificationSummary(summary));
