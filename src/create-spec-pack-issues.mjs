#!/usr/bin/env node
/**
 * create-spec-pack-issues.mjs
 *
 * Reads the improvement report produced by improve-catalog.mjs and files
 * GitHub issues for specialists that need attention. Issue titles follow the
 * spec-pack: {domain}::{slug} convention so autonomous-engine can pick them up.
 *
 * Usage:
 *   node src/create-spec-pack-issues.mjs [--dry-run] [--report <path>]
 *     [--repo <owner/repo>] [--priority-threshold <P0|P1|P2>]
 *     [--limit <n>] [--agent <slug>]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const dryRun = process.argv.includes("--dry-run");

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const reportPath = getArg("--report", path.join(repoRoot, "reports", "latest-improvement-report.json"));
const targetRepo = getArg("--repo", process.env.TARGET_REPO ?? "Open-Labor-Foundation/labor-commons");
const priorityThreshold = getArg("--priority-threshold", "P2"); // P0, P1, or P2 (P2 = all)
const limitArg = getArg("--limit");
const limit = limitArg ? parseInt(limitArg, 10) : Infinity;
const filterAgent = getArg("--agent");

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 };
const thresholdLevel = PRIORITY_ORDER[priorityThreshold] ?? 2;

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function getExistingIssueTitles() {
  try {
    const out = execFileSync("gh", [
      "issue", "list",
      "--repo", targetRepo,
      "--state", "all",
      "--limit", "2000",
      "--json", "title",
    ]);
    return new Set(JSON.parse(out).map((i) => i.title));
  } catch {
    console.error("Warning: could not fetch existing issues — deduplication disabled");
    return new Set();
  }
}

function createIssue(title, body, labels = []) {
  const args = ["issue", "create", "--repo", targetRepo, "--title", title, "--body", body];
  for (const label of labels) {
    args.push("--label", label);
  }
  if (dryRun) {
    console.log(`[dry-run] Would create: ${title}`);
    if (labels.length) console.log(`  labels: ${labels.join(", ")}`);
    return null;
  }
  try {
    const out = execFileSync("gh", args, { encoding: "utf8" });
    return out.trim();
  } catch (err) {
    console.error(`Failed to create issue "${title}":`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Priority assignment
// ---------------------------------------------------------------------------

function assignPriority(agentResult) {
  const { regressions = [], issues = [] } = agentResult;
  const hasBlocking = issues.some((i) => i.severity === "blocking") ||
    regressions.some((r) => r.severity === "high");
  const hasCritical = issues.some((i) => i.severity === "critical") ||
    regressions.some((r) => r.severity === "medium");
  if (hasBlocking) return "P0";
  if (hasCritical) return "P1";
  return "P2";
}

// ---------------------------------------------------------------------------
// Issue body builder
// ---------------------------------------------------------------------------

function formatSourceFreshness(agentResult) {
  const sf = agentResult.metadata?.source_freshness;
  if (!sf) return "";
  const lines = ["### Source Freshness\n"];
  if (sf.next_review_due_at) {
    const due = new Date(sf.next_review_due_at);
    const now = new Date();
    const overdueDays = Math.floor((now - due) / 86400000);
    lines.push(`- **Next review due:** ${sf.next_review_due_at}`);
    if (overdueDays > 0) lines.push(`- **Overdue by:** ${overdueDays} days`);
  }
  if (sf.last_reviewed_at) lines.push(`- **Last reviewed:** ${sf.last_reviewed_at}`);
  if (sf.decay_policy) lines.push(`- **Decay policy:** ${sf.decay_policy}`);
  return lines.join("\n") + "\n";
}

function formatRegressions(regressions = []) {
  if (!regressions.length) return "";
  const lines = ["### Regressions Detected\n"];
  for (const r of regressions) {
    lines.push(`- **${r.type}** (${r.severity}): ${r.message ?? JSON.stringify(r)}`);
  }
  return lines.join("\n") + "\n";
}

function formatIssues(issues = []) {
  const blocking = issues.filter((i) => i.severity === "blocking");
  const critical = issues.filter((i) => i.severity === "critical");
  const advisory = issues.filter((i) => i.severity === "advisory");
  const lines = [];
  if (blocking.length) {
    lines.push("### Blocking Issues\n");
    blocking.forEach((i) => lines.push(`- [blocking] ${i.message}`));
    lines.push("");
  }
  if (critical.length) {
    lines.push("### Critical Issues\n");
    critical.forEach((i) => lines.push(`- [critical] ${i.message}`));
    lines.push("");
  }
  if (advisory.length) {
    lines.push("### Advisory\n");
    advisory.forEach((i) => lines.push(`- ${i.message}`));
    lines.push("");
  }
  return lines.join("\n");
}

function formatRefinementTargets(targets = []) {
  if (!targets.length) return "";
  const lines = ["### Refinement Targets\n"];
  for (const t of targets) {
    lines.push(`- **${t.section}** → ${t.target}: ${t.reason}`);
  }
  return lines.join("\n") + "\n";
}

function buildIssueBody(agentResult, priority) {
  const { agent_slug, domain, validation_score, evaluation_score, readiness_score, overall_score, status } = agentResult;
  const scoreBar = (score) => {
    const pct = Math.round((score ?? 0) * 100);
    return `${pct}%`;
  };

  return [
    `## Spec Pack: ${agent_slug}`,
    "",
    `**Domain:** ${domain ?? "unknown"}`,
    `**Status:** ${status ?? "unknown"}`,
    `**Priority:** ${priority}`,
    "",
    "### Health Scores",
    "",
    `| Dimension | Score |`,
    `|-----------|-------|`,
    `| Validation | ${scoreBar(validation_score)} |`,
    `| Evaluation | ${scoreBar(evaluation_score)} |`,
    `| Readiness  | ${scoreBar(readiness_score)} |`,
    `| **Overall** | **${scoreBar(overall_score)}** |`,
    "",
    formatSourceFreshness(agentResult),
    formatRegressions(agentResult.regressions),
    formatIssues(agentResult.issues),
    formatRefinementTargets(agentResult.refinement_targets),
    "### Action Required",
    "",
    "Review the specialist spec pack and address the issues above. Update `readiness/evidence.json` to reflect current source freshness, re-run evaluation scenarios if needed, and ensure all required files are present.",
    "",
    "---",
    `*Filed by commons-keeper — ${new Date().toISOString().slice(0, 10)}*`,
  ].filter((l) => l !== undefined).join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!fs.existsSync(reportPath)) {
  console.error(`Report not found: ${reportPath}`);
  console.error("Run improve-catalog.mjs first to generate a report.");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const agentResults = report.agent_results ?? [];

const existingTitles = getExistingIssueTitles();

let candidates = agentResults.filter((r) => r.status === "needs_refinement" || (r.regressions ?? []).length > 0);

if (filterAgent) {
  candidates = candidates.filter((r) => r.agent_slug === filterAgent);
}

// Assign priorities and filter by threshold
candidates = candidates.map((r) => ({ ...r, _priority: assignPriority(r) }))
  .filter((r) => PRIORITY_ORDER[r._priority] <= thresholdLevel)
  .sort((a, b) => PRIORITY_ORDER[a._priority] - PRIORITY_ORDER[b._priority]);

if (Number.isFinite(limit)) {
  candidates = candidates.slice(0, limit);
}

console.log(`Candidates: ${candidates.length} specialists need attention (threshold: ${priorityThreshold})`);
console.log(`Target repo: ${targetRepo}`);
if (dryRun) console.log("DRY RUN — no issues will be created\n");

let created = 0;
let skipped = 0;

for (const agentResult of candidates) {
  const domain = agentResult.domain ?? agentResult.catalog_family_slug ?? "unknown";
  const slug = agentResult.agent_slug;
  const priority = agentResult._priority;
  const title = `spec-pack: ${domain}::${slug}`;

  if (existingTitles.has(title)) {
    console.log(`  SKIP (exists) ${title}`);
    skipped++;
    continue;
  }

  const body = buildIssueBody(agentResult, priority);
  const labels = ["spec-pack", priority.toLowerCase(), "waiting-for-contributor"];

  const url = createIssue(title, body, labels);
  if (url) {
    console.log(`  CREATED ${title} → ${url}`);
    created++;
  } else if (!dryRun) {
    skipped++;
  } else {
    created++;
  }
}

console.log(`\nDone. Created: ${created}, Skipped (duplicate): ${skipped}`);
