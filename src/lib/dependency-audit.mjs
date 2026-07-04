/**
 * dependency-audit.mjs
 *
 * Real CVE/advisory coverage, complementary to security-review.mjs's LLM
 * code-logic pass. Runs `npm audit` against a repo's package-lock.json,
 * which checks resolved dependency versions against the GitHub Advisory
 * Database (npm's registry-backed, continuously updated CVE/GHSA feed) —
 * so this is the piece that actually answers "are we exposed to a newly
 * disclosed vulnerability in a package we depend on."
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];

function hasNpmProject(workDir) {
  return fs.existsSync(path.join(workDir, "package.json"));
}

function runNpm(workDir, args) {
  return execFileSync("npm", args, { cwd: workDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function ensureLockfile(workDir) {
  if (fs.existsSync(path.join(workDir, "package-lock.json"))) return true;
  try {
    runNpm(workDir, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
    return fs.existsSync(path.join(workDir, "package-lock.json"));
  } catch (error) {
    console.error(`Warning: could not generate package-lock.json in ${workDir}: ${error.message}`);
    return false;
  }
}

function severityMeetsThreshold(severity, threshold) {
  const severityIdx = SEVERITY_ORDER.indexOf(severity);
  const thresholdIdx = SEVERITY_ORDER.indexOf(threshold);
  if (severityIdx === -1 || thresholdIdx === -1) return false;
  return severityIdx >= thresholdIdx;
}

/**
 * Returns [] if there's no npm project, the lockfile can't be resolved, or
 * nothing meets the severity threshold — never throws for an audit that
 * simply found nothing or a workspace without npm.
 */
export function runDependencyAudit(workDir, { severityThreshold = "high" } = {}) {
  if (!hasNpmProject(workDir)) return [];
  if (!ensureLockfile(workDir)) return [];

  let raw;
  try {
    raw = runNpm(workDir, ["audit", "--json"]);
  } catch (error) {
    // npm audit exits non-zero when it finds vulnerabilities — the JSON report
    // is still on stdout.
    raw = error.stdout ?? "";
  }
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const vulnerabilities = parsed.vulnerabilities ?? {};
  const findings = [];
  for (const [packageName, info] of Object.entries(vulnerabilities)) {
    if (!severityMeetsThreshold(info.severity, severityThreshold)) continue;
    const advisories = (info.via ?? []).filter((v) => typeof v === "object" && v !== null);
    findings.push({
      package: packageName,
      severity: info.severity,
      range: info.range,
      isDirect: Boolean(info.isDirect),
      fixAvailable: info.fixAvailable,
      advisories
    });
  }
  return findings;
}

// GitHub's security-advisory API only accepts a 4-level severity enum;
// npm audit reports 5 levels. "moderate" and "info" have no direct
// equivalent, so they fold into the nearest enum value.
const ADVISORY_SEVERITY = {
  critical: "critical",
  high: "high",
  moderate: "medium",
  low: "low",
  info: "low"
};

export function buildDependencyAdvisorySeverity(finding) {
  return ADVISORY_SEVERITY[finding.severity] ?? "low";
}

export function buildDependencyAdvisorySummary(finding) {
  return `security: dependency ${finding.package} (${finding.severity}) [dependency::${finding.package}]`;
}

function fixedVersion(fixAvailable) {
  return typeof fixAvailable === "object" && fixAvailable ? fixAvailable.version : null;
}

export function buildDependencyVulnerability(finding) {
  return {
    package: { ecosystem: "npm", name: finding.package },
    vulnerable_version_range: finding.range ?? null,
    patched_versions: fixedVersion(finding.fixAvailable)
  };
}

function formatFixAvailable(fixAvailable) {
  if (!fixAvailable) return "No automated fix available yet — track upstream or consider an alternative.";
  if (typeof fixAvailable === "object") {
    const bump = fixAvailable.isSemVerMajor ? " (major version bump)" : "";
    return `Run \`npm audit fix\` — resolves to \`${fixAvailable.name}@${fixAvailable.version}\`${bump}.`;
  }
  return "Run `npm audit fix` to resolve.";
}

export function buildDependencyAdvisoryDescription(finding) {
  const advisoryLines = finding.advisories.length
    ? finding.advisories.map((a) => `- [${a.title ?? "advisory"}](${a.url ?? "#"}) — severity: ${a.severity ?? finding.severity}`)
    : ["(no advisory detail provided)"];

  return [
    `**Severity:** ${finding.severity}`,
    `**Package:** \`${finding.package}\` (vulnerable range: ${finding.range})`,
    `**Direct dependency:** ${finding.isDirect ? "yes" : "no — transitive"}`,
    "",
    "### Advisories",
    ...advisoryLines,
    "",
    "### Recommendation",
    formatFixAvailable(finding.fixAvailable),
    "",
    "---",
    "*Filed by commons-keeper's dependency-audit pass — sourced from `npm audit`",
    "against this repo's package-lock.json (GitHub Advisory Database).*",
    `*${new Date().toISOString().slice(0, 10)}*`
  ].join("\n");
}
