/**
 * pr-verification.mjs
 *
 * Independent claim-vs-reality review for open PRs across every repo in
 * config/security-review-targets.json: does this PR's own description
 * (what it says is "wired in," "automatic," "resolved," "verified,"
 * "done") actually match its diff, or does it ship a real mechanism with
 * no real caller -- a route/field nothing invokes, a backend capability
 * with no UI path, a doc edited to assert a gap doesn't exist rather than
 * the gap being closed.
 *
 * This exists because that exact pattern was found repeatedly, by hand,
 * across this org's PR history in a single session (2026-07-13) -- see
 * GOVERNANCE.md and the incident this file's commit message links to.
 * The check that caught it every time was structural, not clever: a
 * reviewer with no memory of the authoring session, given only the claim
 * and the diff, forced to independently re-derive an answer. This
 * automates exactly that, on a schedule, so it doesn't depend on a human
 * or an authoring session remembering to ask for it.
 *
 * Scope, stated plainly rather than left to be discovered: this is a
 * single structured LLM pass over the diff and PR description, plus a
 * few deterministic pre-checks the script can verify itself (referenced
 * PR states, UI-directory presence). It is NOT a full agentic reviewer
 * with repo tool access -- it can't dynamically grep the rest of a repo,
 * run a test suite, or verify a claim that depends on cross-file state
 * the diff alone doesn't show. That's a real capability gap, not this
 * file's job to close today; it's the natural next extension if this
 * proves out.
 */

import { execFileSync } from "node:child_process";

import { callChatModel, extractJsonObject, DEFAULT_BASE_URL, DEFAULT_MODEL } from "./llm-client.mjs";
import { chunkDiffText } from "./git-repo.mjs";
import { ensureGithubAppAuth } from "./github-app-auth.mjs";

const DEFAULT_CONFIDENCE_THRESHOLD = 7;
const DEFAULT_MAX_CHARS_PER_CALL = 60000;
// Repos with a real end-user UI, and the path prefix that UI lives under --
// used only for a deterministic pre-check (does a diff claiming end-user
// reachability touch any file under this prefix), not to gate the LLM pass.
const UI_REPO_PATHS = {
  "commons-board": "apps/web/"
};
const REACHABILITY_CLAIM_WORDS = /\b(wired in|wired into|automatic(?:ally)?|now reachable|verified live|resolved|no longer a gap|not a gap|done|closes the gap)\b/i;

const SYSTEM_PROMPT = `You are independently verifying a single open pull request against its own description. You were not involved in writing it and have no other context about this project beyond what's given to you here -- that is deliberate, don't try to infer intent beyond what's stated.

Your only job: for every claim in the PR description of the form "X is wired in / automatic / resolved / done / verified / no longer a gap / closes issue Y" -- check whether the diff actually, concretely delivers that. Concretely:

- A new API route, field, or script with zero callers anywhere in the diff is NOT "wired in," even if the route/field/script itself is implemented correctly.
- A backend capability with no corresponding change to a UI directory, when the repo has a real end-user UI, is NOT reachable by an end user, even if an admin could technically call the API directly.
- A doc file edited to assert a gap is "resolved" or "not a gap" is only true if the SAME diff (or a cited, already-merged dependency) actually contains the mechanism -- citing an unmerged, still-open PR as done is a false claim, not a forward-looking note.
- "Tests pass" or "verified" is only credible if the diff actually includes or references real test changes/output -- a bare assertion with no test diff is a claim to flag, not confirm.
- An opt-in flag/field that nothing in the diff ever sets to true (no UI control, no default, no caller) is inert regardless of how correct the backend logic behind it is.

Do NOT flag: honest disclosures ("not built yet," "API only, no UI," "still open," "deferred") -- those are the opposite of the pattern you're checking for. Do NOT flag stylistic or minor wording choices. Do NOT invent problems if the diff genuinely delivers what's claimed -- most PRs are fine; only real mismatches matter here.

Respond with ONLY a JSON object (no prose, no markdown fences):
{"findings": [{"claim": "the specific claim text or paraphrase", "issue": "what's actually true instead", "confidence": 0-10, "evidence": "specific file/line or diff detail supporting this"}]}
If every claim holds up, respond with exactly: {"findings": []}`;

function ghExec(args, options) {
  return execFileSync("gh", args, { encoding: "utf8", ...options });
}

async function ghExecAuthed(args, options) {
  await ensureGithubAppAuth(process.env);
  return ghExec(args, options);
}

function listOpenPulls(repoFullName) {
  const raw = ghExec([
    "pr", "list", "--repo", repoFullName, "--state", "open",
    "--json", "number,title,body,headRefName,updatedAt,headRepositoryOwner"
  ]);
  return JSON.parse(raw);
}

function fetchPullDiff(repoFullName, number) {
  try {
    return ghExec(["pr", "diff", String(number), "--repo", repoFullName]);
  } catch (error) {
    // gh caps diffs over 300 changed files -- a PR that large is itself
    // a strong signal (labor-commons#545 was exactly this shape), report
    // it as a finding rather than silently skipping the PR.
    return null;
  }
}

function fetchPullHeadSha(repoFullName, number) {
  const raw = ghExec(["pr", "view", String(number), "--repo", repoFullName, "--json", "headRefOid"]);
  return JSON.parse(raw).headRefOid;
}

// Deterministic pre-checks the script can verify itself, no LLM needed --
// cheap, exact, and catch two of the shapes found most often by hand.
function runDeterministicChecks(repoFullName, pr, diffText) {
  const findings = [];

  const referencedPrNumbers = [...new Set(
    [...(pr.body ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
  )].filter((n) => n !== pr.number);
  for (const refNum of referencedPrNumbers) {
    try {
      const refRaw = ghExec(["pr", "view", String(refNum), "--repo", repoFullName, "--json", "state,title"]);
      const ref = JSON.parse(refRaw);
      if (ref.state === "OPEN" && REACHABILITY_CLAIM_WORDS.test(pr.body ?? "")) {
        findings.push({
          claim: `References #${refNum} ("${ref.title}")`,
          issue: `#${refNum} is still OPEN, not merged -- if this PR's description treats it as done/resolved, that's premature`,
          confidence: 5,
          evidence: `gh pr view ${refNum} --repo ${repoFullName}: state=OPEN`
        });
      }
    } catch {
      // #N might be an issue, not a PR, or in a different repo -- not
      // resolvable generically, skip rather than guess.
    }
  }

  const uiPrefix = UI_REPO_PATHS[repoFullName.split("/").pop()];
  if (uiPrefix && REACHABILITY_CLAIM_WORDS.test(pr.body ?? "")) {
    const touchesUi = diffText.split("\n").some((line) => line.startsWith("+++ ") && line.includes(uiPrefix));
    const touchesBackend = diffText.split("\n").some((line) => line.startsWith("+++ ") && !line.includes(uiPrefix) && !line.includes("README") && !line.includes(".test.") && !line.includes(".spec."));
    if (touchesBackend && !touchesUi) {
      findings.push({
        claim: "PR description uses reachability language (wired in / automatic / resolved / done)",
        issue: `diff touches backend files but nothing under ${uiPrefix} -- likely no UI path for an end user, even if the backend mechanism is real`,
        confidence: 6,
        evidence: `no "+++ .../${uiPrefix}..." line in the diff`
      });
    }
  }

  return findings;
}

export async function runPrVerification({
  targetsPath,
  statePath,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
  dryRun = false,
  repoFilter = null,
  loadTargets,
  loadState,
  saveState
}) {
  const targets = loadTargets(targetsPath).filter((t) => !t.skip && (!repoFilter || t.name === repoFilter));
  const state = loadState(statePath);
  const summary = { reposChecked: 0, pullsChecked: 0, pullsFlagged: 0, pullsSkippedUnchanged: 0, errors: [] };

  for (const target of targets) {
    const repoFullName = target.cloneUrl.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    summary.reposChecked++;
    state.repos ??= {};
    state.repos[target.name] ??= { pulls: {} };

    let pulls;
    try {
      pulls = listOpenPulls(repoFullName);
    } catch (error) {
      summary.errors.push({ repo: target.name, error: `could not list PRs: ${error.message}` });
      continue;
    }

    for (const pr of pulls) {
      let headSha;
      try {
        headSha = fetchPullHeadSha(repoFullName, pr.number);
      } catch {
        headSha = pr.updatedAt; // fallback fingerprint if the extra call fails
      }
      const priorReview = state.repos[target.name].pulls[String(pr.number)];
      if (priorReview?.headSha === headSha) {
        summary.pullsSkippedUnchanged++;
        continue;
      }

      const diffText = fetchPullDiff(repoFullName, pr.number);
      summary.pullsChecked++;

      let findings = [];
      if (diffText === null) {
        findings.push({
          claim: `PR #${pr.number} ("${pr.title}")`,
          issue: "diff too large to review (over gh's 300-file cap) -- a PR this size touching this many files is itself worth a human look, same shape as a prior 3,000-file incident",
          confidence: 8,
          evidence: "gh pr diff failed with a file-count-exceeded error"
        });
      } else {
        findings.push(...runDeterministicChecks(repoFullName, pr, diffText));

        if (apiKey) {
          try {
            const chunks = chunkDiffText(diffText, DEFAULT_MAX_CHARS_PER_CALL);
            const userPrompt = `PR title: ${pr.title}\n\nPR description:\n${pr.body ?? "(no description)"}\n\nDiff${chunks.length > 1 ? ` (part 1 of ${chunks.length}, truncated -- review what's shown)` : ""}:\n${chunks[0] ?? diffText}`;
            const content = await callChatModel({ systemPrompt: SYSTEM_PROMPT, userPrompt, apiKey, baseUrl, model });
            const parsed = extractJsonObject(content);
            if (parsed?.findings?.length) {
              findings.push(...parsed.findings);
            }
          } catch (error) {
            summary.errors.push({ repo: target.name, pr: pr.number, error: `LLM review failed: ${error.message}` });
          }
        }
      }

      findings = findings.filter((f) => (f.confidence ?? 10) >= confidenceThreshold);

      if (findings.length > 0) {
        summary.pullsFlagged++;
        if (!dryRun) {
          try {
            await postFindingsComment(repoFullName, pr.number, findings);
          } catch (error) {
            summary.errors.push({ repo: target.name, pr: pr.number, error: `could not post comment: ${error.message}` });
          }
        }
      }

      state.repos[target.name].pulls[String(pr.number)] = { headSha, reviewedAt: new Date().toISOString(), findingsCount: findings.length };
    }
  }

  if (!dryRun) {
    saveState(statePath, state);
  }
  return summary;
}

async function postFindingsComment(repoFullName, number, findings) {
  const body = [
    "**Independent PR verification** (automated -- see [commons-keeper](https://github.com/Open-Labor-Foundation/commons-keeper))",
    "",
    "This PR's description makes claims the diff doesn't fully back up:",
    "",
    ...findings.map((f, i) => [
      `${i + 1}. **Claim:** ${f.claim}`,
      `   **Actually:** ${f.issue}`,
      f.evidence ? `   **Evidence:** ${f.evidence}` : null,
      `   **Confidence:** ${f.confidence ?? "?"}/10`
    ].filter(Boolean).join("\n")),
    "",
    "This is an automated first pass, not a final verdict -- a human should confirm before merging. See GOVERNANCE.md for why this check exists independent of the authoring session."
  ].join("\n");

  await ghExecAuthed(["pr", "comment", String(number), "--repo", repoFullName, "--body", body]);
}

export function formatPrVerificationSummary(summary) {
  const lines = [
    `PR verification: ${summary.reposChecked} repo(s), ${summary.pullsChecked} PR(s) checked, ${summary.pullsSkippedUnchanged} unchanged (skipped), ${summary.pullsFlagged} flagged.`
  ];
  if (summary.errors.length > 0) {
    lines.push(`${summary.errors.length} error(s):`);
    for (const e of summary.errors) {
      lines.push(`  - ${e.repo}${e.pr ? ` #${e.pr}` : ""}: ${e.error}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
