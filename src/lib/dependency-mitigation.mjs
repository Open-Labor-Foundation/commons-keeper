/**
 * dependency-mitigation.mjs
 *
 * For dependency-audit findings with no upstream fix available, checks
 * whether the vulnerable package is actually exercised by this repo's own
 * code and, only when there's concrete evidence it is, proposes an in-repo
 * mitigation as a pull request — never a direct commit to main, never
 * auto-merged, and never a patch to the third-party package's own repo.
 * commons-keeper only ever acts inside repos the Open Labor Foundation owns.
 *
 * Two mitigation shapes:
 *   - code_guard: a defensive check around the vulnerable call site.
 *   - remove_dependency: the package isn't actually imported anywhere in
 *     source — proposes dropping the unused dependency entirely, which
 *     removes the CVE exposure outright.
 *
 * Every proposal requires the LLM to (a) find reachability evidence in the
 * exact code given, not assume it, and (b) meet a high confidence bar, and
 * every code_guard patch must match its target text exactly once before
 * it's applied — no fuzzy or partial replacement.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { runGit, listAllTrackedFiles, isCodeFile } from "./git-repo.mjs";
import { callChatModel, extractJsonObject } from "./llm-client.mjs";

const MITIGATION_CONFIDENCE_THRESHOLD = 8;
const MAX_USAGE_SITES = 3;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDirectUsageSites(workDir, target, packageName) {
  const escaped = escapeRegExp(packageName);
  const patterns = [
    new RegExp(`require\\(['"]${escaped}(['"/])`),
    new RegExp(`from\\s+['"]${escaped}(['"/])`),
    new RegExp(`import\\(['"]${escaped}(['"/])`)
  ];

  const files = listAllTrackedFiles(workDir).filter((f) => isCodeFile(f, target));
  const sites = [];
  for (const file of files) {
    if (sites.length >= MAX_USAGE_SITES) break;
    let content;
    try {
      content = fs.readFileSync(path.join(workDir, file), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (patterns.some((p) => p.test(lines[i]))) {
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 6);
        sites.push({ file, line: i + 1, snippet: lines.slice(start, end).join("\n") });
        break;
      }
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// LLM reachability + mitigation proposal
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior security engineer assessing a dependency vulnerability that
has NO upstream fix available (no patched version to bump to).

You'll be given the vulnerable package, its severity, the advisory description, the vulnerable
version range, the currently pinned version, and either (a) up to a few sites in this repo's own
source where the package is directly imported, with surrounding context, or (b) a note that no
import site was found by a source scan.

Decide reachability and, if warranted, a mitigation:

1. If no usage sites were provided: the package may be an unused direct dependency. Respond with
   {"reachable": false, "mitigation_type": "remove_dependency", "reasoning": "...", "confidence": 0-10}
   only if you're confident based on the package's stated purpose that it's plausible it's unused;
   otherwise use "mitigation_type": "none".

2. If usage sites were provided: judge ONLY from that code whether the vulnerable behavior
   described in the advisory is actually reachable — many CVEs live in code paths (a specific flag,
   a rarely used parser mode) a given caller never exercises. Do not assume reachability you can't
   see evidence for in the given snippets.
   - Not reachable: {"reachable": false, "mitigation_type": "none", "reasoning": "...", "confidence": 0-10}
   - Reachable, with a concrete guard you can express as an exact literal patch:
     {"reachable": true, "mitigation_type": "code_guard", "file": "path/from/site", "old_string":
     "exact existing code copied verbatim from the snippet, including whitespace", "new_string":
     "replacement with a defensive check before the vulnerable call", "reasoning": "...",
     "confidence": 0-10}
   - Reachable, but you don't have enough evidence to safely write a patch:
     {"reachable": true, "mitigation_type": "none", "reasoning": "...", "confidence": 0-10}

old_string MUST be an exact substring of the snippet you were given — if you can't quote it exactly,
use mitigation_type "none" rather than guessing at code you weren't shown in full.

Respond with ONLY the JSON object, no prose, no markdown fences.`;

function buildUserPrompt(finding, usageSites) {
  const advisoryText = (finding.advisories ?? [])
    .map((a) => `- ${a.title ?? "advisory"} (${a.url ?? "no url"}): CWE ${JSON.stringify(a.cwe ?? [])}`)
    .join("\n");

  const usageText = usageSites.length
    ? usageSites.map((s) => `--- ${s.file}:${s.line} ---\n${s.snippet}`).join("\n\n")
    : "(no direct import of this package was found by a source scan)";

  return [
    `Package: ${finding.package}`,
    `Severity: ${finding.severity}`,
    `Vulnerable range: ${finding.range}`,
    "",
    "Advisories:",
    advisoryText || "(none provided)",
    "",
    "Usage in this repo:",
    usageText
  ].join("\n");
}

async function proposeMitigation({ finding, usageSites, apiKey, baseUrl, model }) {
  const content = await callChatModel({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(finding, usageSites),
    apiKey,
    baseUrl,
    model
  });
  return extractJsonObject(content);
}

// ---------------------------------------------------------------------------
// Patch application — exact, unique match only, never a guess
// ---------------------------------------------------------------------------

function applyCodeGuard(workDir, proposal) {
  const filePath = path.join(workDir, proposal.file);
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { applied: false, reason: `could not read ${proposal.file}` };
  }
  const occurrences = content.split(proposal.old_string).length - 1;
  if (occurrences !== 1) {
    return { applied: false, reason: `old_string matched ${occurrences} time(s) in ${proposal.file}, expected exactly 1` };
  }
  const updated = content.replace(proposal.old_string, proposal.new_string);
  fs.writeFileSync(filePath, updated, "utf8");
  return { applied: true, files: [proposal.file] };
}

function applyRemoveDependency(workDir, packageName) {
  const pkgPath = path.join(workDir, "package.json");
  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return { applied: false, reason: "could not read/parse package.json" };
  }
  let removedFrom = null;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (pkgJson[field] && Object.prototype.hasOwnProperty.call(pkgJson[field], packageName)) {
      delete pkgJson[field][packageName];
      removedFrom = field;
      break;
    }
  }
  if (!removedFrom) {
    return { applied: false, reason: `${packageName} not found as a direct dependency in package.json` };
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`, "utf8");
  try {
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: workDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    return { applied: false, reason: `removed from package.json but lockfile regeneration failed: ${error.message}` };
  }
  return { applied: true, files: ["package.json", "package-lock.json"] };
}

// ---------------------------------------------------------------------------
// Branch + PR — idempotent, PR-only, never auto-merged
// ---------------------------------------------------------------------------

function branchNameFor(packageName) {
  const safe = packageName.replace(/[@/]/g, "-").replace(/^-+/, "");
  return `commons-keeper/dep-mitigation/${safe}`;
}

function findExistingOpenPr(targetRepo, branch) {
  try {
    const out = execFileSync("gh", [
      "pr", "list",
      "--repo", targetRepo,
      "--head", branch,
      "--state", "open",
      "--json", "url"
    ], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed[0].url : null;
  } catch {
    return null;
  }
}

function buildPrBody(finding, proposal, appliedFiles) {
  return [
    `**Package:** \`${finding.package}\` (${finding.severity}, no upstream fix available)`,
    `**Mitigation type:** ${proposal.mitigation_type}`,
    `**Files changed:** ${appliedFiles.join(", ")}`,
    "",
    "### Reasoning (from the LLM proposal)",
    proposal.reasoning ?? "(none provided)",
    "",
    `**Confidence:** ${proposal.confidence ?? "?"}/10`,
    "",
    "---",
    "*Opened by commons-keeper's dependency-mitigation pass. This is an LLM-proposed patch —",
    "it has not been tested. Review carefully before merging; do not merge automatically.*",
    `*${new Date().toISOString().slice(0, 10)}*`
  ].join("\n");
}

/**
 * findings: dependency-audit findings already filtered to isDirect && !fixAvailable.
 * Returns one result per finding: { package, prOpened, url?, reason? }.
 */
export async function proposeDependencyMitigations({ workDir, target, targetRepo, findings, apiKey, baseUrl, model, dryRun }) {
  const results = [];

  for (const finding of findings) {
    const usageSites = findDirectUsageSites(workDir, target, finding.package);

    let proposal;
    try {
      proposal = await proposeMitigation({ finding, usageSites, apiKey, baseUrl, model });
    } catch (error) {
      results.push({ package: finding.package, prOpened: false, reason: `LLM call failed: ${error.message}` });
      continue;
    }

    // "reachable" is informational, not a gate on its own — remove_dependency
    // is legitimately proposed WITH reachable:false (the package being unused
    // is exactly why removing it is safe). Only mitigation_type "none" means
    // no action.
    if (!proposal || proposal.mitigation_type === "none") {
      results.push({ package: finding.package, prOpened: false, reason: proposal?.reasoning ?? "not reachable / no safe mitigation" });
      continue;
    }
    if (Number(proposal.confidence ?? 0) < MITIGATION_CONFIDENCE_THRESHOLD) {
      results.push({ package: finding.package, prOpened: false, reason: `confidence ${proposal.confidence} below threshold` });
      continue;
    }

    const branch = branchNameFor(finding.package);
    const existingUrl = findExistingOpenPr(targetRepo, branch);
    if (existingUrl) {
      results.push({ package: finding.package, prOpened: false, reason: "PR already open", url: existingUrl });
      continue;
    }

    let applyResult;
    if (proposal.mitigation_type === "code_guard") {
      applyResult = applyCodeGuard(workDir, proposal);
    } else if (proposal.mitigation_type === "remove_dependency") {
      applyResult = applyRemoveDependency(workDir, finding.package);
    } else {
      applyResult = { applied: false, reason: `unknown mitigation_type: ${proposal.mitigation_type}` };
    }

    if (!applyResult.applied) {
      results.push({ package: finding.package, prOpened: false, reason: applyResult.reason });
      continue;
    }

    if (dryRun) {
      results.push({ package: finding.package, prOpened: true, dryRun: true, branch, files: applyResult.files });
      // Restore the working tree so a dry run never leaves local changes
      // behind — checkout reverts tracked-file edits, clean removes any
      // newly created untracked file (e.g. a lockfile that didn't exist
      // before a remove_dependency preview), scoped to just the touched paths.
      runGit(workDir, ["checkout", "--", "."]);
      runGit(workDir, ["clean", "-f", "--", ...applyResult.files]);
      continue;
    }

    try {
      runGit(workDir, ["config", "user.email", "commons-keeper@openlabor.foundation"]);
      runGit(workDir, ["config", "user.name", "commons-keeper"]);
      runGit(workDir, ["checkout", "-B", branch, "main"]);
      runGit(workDir, ["add", ...applyResult.files]);
      runGit(workDir, ["commit", "-m", `security: mitigate ${finding.package} (${finding.severity}, no upstream fix)`]);
      runGit(workDir, ["push", "--force-with-lease", "origin", `${branch}:${branch}`]);

      const url = execFileSync("gh", [
        "pr", "create",
        "--repo", targetRepo,
        "--head", branch,
        "--base", "main",
        "--title", `security: mitigate ${finding.package} (${finding.severity}) — no upstream fix`,
        "--body", buildPrBody(finding, proposal, applyResult.files),
        "--label", "security",
        "--label", "human-review",
        "--label", "dependency"
      ], { encoding: "utf8" }).trim();

      results.push({ package: finding.package, prOpened: true, url });
    } catch (error) {
      results.push({ package: finding.package, prOpened: false, reason: `git/gh error: ${error.message}` });
    } finally {
      // Always return the clone to main so the next pass's cloneOrUpdate isn't
      // surprised by a leftover mitigation branch checked out.
      try {
        runGit(workDir, ["checkout", "main"]);
      } catch {
        // best-effort
      }
    }
  }

  return results;
}
