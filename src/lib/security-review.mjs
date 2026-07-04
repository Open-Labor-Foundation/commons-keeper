/**
 * security-review.mjs
 *
 * Full-org security review loop: clones/updates every repo listed in
 * config/security-review-targets.json, and for each runs three checks:
 *
 * 1. An LLM code-logic pass over code changed since the last run (or, on a
 *    repo's first run, its current code files in bounded batches), using
 *    the same category/exclusion rules as an interactive `/security-review`.
 * 2. An `npm audit` dependency pass — real CVE/GHSA data, runs every pass
 *    regardless of code changes, needs no LLM key.
 * 3. For dependency findings with no upstream fix, an LLM reachability
 *    check and — only when the vulnerable code path is actually exercised
 *    by this repo's own code — a proposed in-repo mitigation PR.
 *
 * Findings that clear their thresholds get filed as GitHub issues on the
 * repo they were found in.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  cloneOrUpdate,
  listAllTrackedFiles,
  listChangedFiles,
  buildDiffText,
  isCodeFile,
  chunkFilesByContent,
  renderFileChunkText,
  chunkDiffText
} from "./git-repo.mjs";
import { callChatModel, extractJsonArray, DEFAULT_BASE_URL, DEFAULT_MODEL } from "./llm-client.mjs";
import { runDependencyAudit, buildDependencyIssueTitle, buildDependencyIssueBody } from "./dependency-audit.mjs";
import { proposeDependencyMitigations } from "./dependency-mitigation.mjs";
import { loadTargets, loadState, saveState } from "./config-state.mjs";

export { loadTargets, loadState, saveState };

const DEFAULT_CONFIDENCE_THRESHOLD = 8;
const DEFAULT_MAX_CHARS_PER_CALL = 60000;
const QUALIFYING_SEVERITIES = new Set(["High", "Medium"]);

// ---------------------------------------------------------------------------
// LLM code-logic review
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior security engineer conducting a security-focused code review.
Only flag HIGH-CONFIDENCE, concretely exploitable vulnerabilities — not style, hardening, or theoretical issues.

Categories: SQL/NoSQL injection, command injection, path traversal, template/XXE injection,
authentication bypass, authorization/privilege escalation, session/JWT flaws, hardcoded secrets,
weak crypto, insecure deserialization (pickle/YAML/eval), XSS (only via dangerouslySetInnerHTML or
equivalent unsafe escape hatches — React/Next auto-escaping is assumed safe otherwise), sensitive
data exposure in logs/API responses/debug output.

Do NOT report: denial of service / resource exhaustion / rate limiting; secrets stored on disk if
otherwise access-controlled; lack of input validation without proven impact; missing hardening or
best-practice suggestions that aren't concretely exploitable; race conditions unless concretely
problematic; outdated third-party library versions; memory safety in memory-safe languages;
findings only in test files; log spoofing; SSRF where only the path (not host/protocol) is
attacker-controlled; regex injection/DoS; findings in markdown/documentation files; missing
auth/permission checks in client-side JS/TS (server must validate, that's not a client bug);
env vars / CLI flags — these are trusted values.

Respond with ONLY a JSON array (no prose, no markdown fences). Each element:
{"file": "path", "line": 0, "severity": "High"|"Medium", "confidence": 0-10, "category": "short_slug",
"description": "what's wrong", "exploit_scenario": "concrete attacker steps", "recommendation": "concrete fix"}
If there are no qualifying findings, respond with exactly: []`;

async function callSecurityReviewModel({ repoName, label, bodyText, apiKey, baseUrl, model }) {
  if (!bodyText.trim()) return [];
  const content = await callChatModel({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Repository: ${repoName}\nContent type: ${label}\n\n${bodyText}`,
    apiKey,
    baseUrl,
    model
  });
  return extractJsonArray(content);
}

// ---------------------------------------------------------------------------
// GitHub issue filing — same execFileSync array-arg pattern as
// create-spec-pack-issues.mjs
// ---------------------------------------------------------------------------

function findingFingerprint(finding) {
  return `${finding.category ?? "finding"}::${finding.file ?? "unknown"}:${finding.line ?? 0}`;
}

export function getExistingSecurityIssueTitles(targetRepo) {
  try {
    const out = execFileSync("gh", [
      "issue", "list",
      "--repo", targetRepo,
      "--label", "security",
      "--state", "all",
      "--limit", "500",
      "--json", "title"
    ], { encoding: "utf8" });
    return new Set(JSON.parse(out).map((i) => i.title));
  } catch {
    console.error(`Warning: could not fetch existing security issues for ${targetRepo} — deduplication disabled`);
    return new Set();
  }
}

function buildIssueTitle(finding) {
  const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file ?? "unknown";
  return `security: ${finding.category ?? "finding"} in ${loc} [${findingFingerprint(finding)}]`;
}

function buildIssueBody(finding) {
  return [
    `**Severity:** ${finding.severity ?? "Medium"}`,
    `**Confidence:** ${finding.confidence ?? "?"}/10`,
    `**Category:** ${finding.category ?? "unknown"}`,
    `**Location:** \`${finding.file ?? "unknown"}${finding.line ? `:${finding.line}` : ""}\``,
    "",
    "### Description",
    finding.description ?? "(none provided)",
    "",
    "### Exploit scenario",
    finding.exploit_scenario ?? "(none provided)",
    "",
    "### Recommendation",
    finding.recommendation ?? "(none provided)",
    "",
    "---",
    "*Filed by commons-keeper's automated security-review loop — this is an LLM-driven code-logic",
    "review, not a CVE/dependency-database lookup. Verify before treating as confirmed.*",
    `*${new Date().toISOString().slice(0, 10)}*`
  ].join("\n");
}

export function createOrPreviewIssue(targetRepo, title, body, existingTitles, dryRun) {
  if (existingTitles.has(title)) {
    return { created: false, reason: "duplicate" };
  }
  if (dryRun) {
    return { created: true, dryRun: true, title };
  }
  try {
    const url = execFileSync("gh", [
      "issue", "create",
      "--repo", targetRepo,
      "--title", title,
      "--body", body,
      "--label", "security",
      "--label", "human-review"
    ], { encoding: "utf8" }).trim();
    return { created: true, url, title };
  } catch (error) {
    console.error(`Failed to create issue "${title}" in ${targetRepo}:`, error.message);
    return { created: false, reason: "gh_error" };
  }
}

function fileSecurityIssue(targetRepo, finding, existingTitles, dryRun) {
  return createOrPreviewIssue(targetRepo, buildIssueTitle(finding), buildIssueBody(finding), existingTitles, dryRun);
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export async function runSecurityReview(options) {
  const {
    targetsPath,
    statePath,
    workRoot,
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
    maxCharsPerCall = DEFAULT_MAX_CHARS_PER_CALL,
    dependencySeverityThreshold = "high",
    proposeMitigations = true,
    dryRun = false,
    repoFilter = null
  } = options;

  const targets = loadTargets(targetsPath).filter((t) => !repoFilter || t.name === repoFilter);
  const state = loadState(statePath);
  state.repos = state.repos ?? {};

  const summary = { reviewed: [], skipped: [], baselined: [], findingsFiled: 0, mitigationPrsOpened: 0 };

  for (const target of targets) {
    if (target.skip) {
      summary.skipped.push({ repo: target.name, reason: target.skipReason ?? "skipped" });
      continue;
    }

    const workDir = path.join(workRoot, target.name);
    const headSha = cloneOrUpdate(target.cloneUrl, workDir);
    const priorSha = state.repos[target.name]?.lastReviewedSha ?? null;

    let chunks = [];
    let mode;
    let noCodeChangeReason = null;

    if (!priorSha) {
      mode = "baseline";
      const allFiles = listAllTrackedFiles(workDir).filter((f) => isCodeFile(f, target));
      chunks = chunkFilesByContent(workDir, allFiles, maxCharsPerCall).map((chunk) => ({
        label: "full file contents (first-run baseline)",
        text: renderFileChunkText(chunk)
      }));
    } else {
      const changed = listChangedFiles(workDir, priorSha, headSha);
      if (changed === null) {
        mode = "baseline";
        const allFiles = listAllTrackedFiles(workDir).filter((f) => isCodeFile(f, target));
        chunks = chunkFilesByContent(workDir, allFiles, maxCharsPerCall).map((chunk) => ({
          label: "full file contents (history rewrite, re-baselined)",
          text: renderFileChunkText(chunk)
        }));
      } else {
        mode = "diff";
        const codeChanged = changed.filter((f) => isCodeFile(f, target));
        if (codeChanged.length === 0) {
          noCodeChangeReason = "no code changes since last review";
        } else {
          const diffText = buildDiffText(workDir, priorSha, headSha, codeChanged);
          chunks = chunkDiffText(diffText, maxCharsPerCall).map((text) => ({ label: "unified diff", text }));
        }
      }
    }

    // The LLM code-logic pass only has something to do when code changed —
    // but the dependency audit checks currently-pinned versions against a
    // continuously updated advisory database, so it must run every pass
    // regardless of whether any code changed since last time.
    const targetRepo = `Open-Labor-Foundation/${target.name}`;
    const existingTitles = getExistingSecurityIssueTitles(targetRepo);
    let filedCount = 0;
    let findingCount = 0;

    if (chunks.length > 0 && !apiKey) {
      console.error(`Warning: no LLM API key configured — skipping code review for ${target.name} (dependency audit still runs)`);
    } else {
      for (const chunk of chunks) {
        const findings = await callSecurityReviewModel({
          repoName: target.name,
          label: chunk.label,
          bodyText: chunk.text,
          apiKey,
          baseUrl,
          model
        });
        const qualifying = findings.filter(
          (f) => Number(f.confidence ?? 0) >= confidenceThreshold && QUALIFYING_SEVERITIES.has(f.severity)
        );
        findingCount += qualifying.length;
        for (const finding of qualifying) {
          const result = fileSecurityIssue(targetRepo, finding, existingTitles, dryRun);
          if (result.created) {
            filedCount += 1;
            existingTitles.add(result.title);
          }
        }
      }
    }

    let dependencyFindingCount = 0;
    let dependencyFiledCount = 0;
    let mitigationPrsOpened = 0;
    try {
      const dependencyFindings = runDependencyAudit(workDir, { severityThreshold: dependencySeverityThreshold });
      dependencyFindingCount = dependencyFindings.length;
      for (const finding of dependencyFindings) {
        const title = buildDependencyIssueTitle(finding);
        const result = createOrPreviewIssue(targetRepo, title, buildDependencyIssueBody(finding), existingTitles, dryRun);
        if (result.created) {
          dependencyFiledCount += 1;
          existingTitles.add(title);
        }
      }

      if (apiKey && proposeMitigations) {
        const noFixFindings = dependencyFindings.filter((f) => !f.fixAvailable && f.isDirect);
        if (noFixFindings.length > 0) {
          const mitigationResults = await proposeDependencyMitigations({
            workDir,
            target,
            targetRepo,
            findings: noFixFindings,
            apiKey,
            baseUrl,
            model,
            dryRun
          });
          mitigationPrsOpened = mitigationResults.filter((r) => r.prOpened).length;
        }
      }
    } catch (error) {
      console.error(`Warning: dependency audit failed for ${target.name}: ${error.message}`);
    }

    summary.findingsFiled += filedCount + dependencyFiledCount;
    summary.mitigationPrsOpened += mitigationPrsOpened;

    if (chunks.length === 0 && dependencyFindingCount === 0) {
      summary.skipped.push({ repo: target.name, reason: noCodeChangeReason ?? "no code files matched review scope" });
    } else {
      (mode === "baseline" ? summary.baselined : summary.reviewed).push({
        repo: target.name,
        mode,
        chunksReviewed: chunks.length,
        qualifyingFindings: findingCount,
        issuesFiled: filedCount,
        dependencyFindings: dependencyFindingCount,
        dependencyIssuesFiled: dependencyFiledCount,
        mitigationPrsOpened
      });
    }

    // Only advance the reviewed-commit marker if the code diff actually got an
    // LLM pass (or there was nothing to review). If it was skipped for lack of
    // an API key, leave the marker where it is so the real diff gets reviewed
    // once a key is configured, instead of silently reviewing.
    if (chunks.length === 0 || apiKey) {
      state.repos[target.name] = { lastReviewedSha: headSha, lastReviewedAt: new Date().toISOString() };
    }
  }

  if (!dryRun) saveState(statePath, state);
  return summary;
}

function formatEntry(tag, entry) {
  const mitigationSuffix = entry.mitigationPrsOpened ? `; ${entry.mitigationPrsOpened} mitigation PR(s) opened` : "";
  return `[${tag}] ${entry.repo}: ${entry.chunksReviewed} code chunk(s), ${entry.qualifyingFindings} code finding(s)/${entry.issuesFiled} filed; ${entry.dependencyFindings} dependency finding(s)/${entry.dependencyIssuesFiled} filed${mitigationSuffix}`;
}

export function formatSecurityReviewSummary(summary) {
  const lines = ["Security review summary", "========================", ""];
  for (const entry of summary.baselined) {
    lines.push(formatEntry("baseline", entry));
  }
  for (const entry of summary.reviewed) {
    lines.push(formatEntry("diff    ", entry));
  }
  for (const entry of summary.skipped) {
    lines.push(`[skip]     ${entry.repo}: ${entry.reason}`);
  }
  lines.push("", `Total issues filed: ${summary.findingsFiled}`, `Total mitigation PRs opened: ${summary.mitigationPrsOpened}`);
  return `${lines.join("\n")}\n`;
}
