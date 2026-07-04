import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REQUIRED_AGENT_FILES = [
  "spec.yaml",
  "evaluation/scenarios.md",
  "evaluation/results.json",
  "readiness/release.md",
  "readiness/evidence.json",
  "deployment/package.md",
  "positioning/readiness.md",
];

const ISSUE_SEVERITY_WEIGHT = {
  advisory: 1,
  critical: 2,
  blocking: 3,
};

const PRIORITY_ORDER = {
  P0: 0,
  P1: 1,
  P2: 2,
};

export const defaultPaths = {
  history: "state/improvement-history.json",
  report: "reports/latest-improvement-report.json",
  analysis: "reports/improvement-history-analysis.json",
  perAgentReports: "reports/agents",
  generatedAgents: "reports/generated",
};

export const mutationAllowedPaths = [
  "catalog/",
  "reports/generated/",
  "reports/",
  "state/",
];

const defaultPublishConfig = {
  branch: "autonomous/improvements",
  base: "autonomous/review",
  commitMessage: "autonomous: spec mutation + optimization",
  prTitle: "autonomous: spec mutation + optimization",
};

export const defaultPolicyEngine = {
  max_iterations: 3,
  max_total_iterations: 300,
  max_agents_per_run: 100,
  max_parallel_agents: 10,
  auto_run_enabled: true,
  regression_threshold: 0.05,
  health_threshold: 75,
  health_delta_trigger_threshold: -2,
  health_degradation_threshold: -5,
  auto_apply_threshold: 90,
  escalation_threshold: 60,
  optimization_enabled: true,
  optimization_target: 95,
  max_optimization_iterations: 2,
  min_improvement_threshold: 0.5,
  low_risk_optimization_enabled: true,
  low_risk_confidence_threshold: 0.85,
  full_autonomous_confidence_threshold: 0.95,
  max_expected_improvement_for_low_risk: 10,
  max_low_risk_targets_per_agent: 3,
  max_low_risk_applies_per_run: 25,
  min_projected_improvement: 1,
  regression_soft_limit: 5,
  regression_hard_limit: 10,
  base_budget: 25,
  min_budget: 5,
  max_budget: 25,
  max_optimizations_per_agent_per_run: 1,
  cooldown_runs: 2,
  min_applies_per_run: 3,
  adaptive_budget_floor: 5,
  oscillation_ttl_runs: 2,
  max_recovered_agents_per_run: 5,
  oscillation_low_gain_limit: 3,
  codegen_mode: "forced_and_ready",
  top_refinement_targets_per_iteration: 5,
  max_spec_refinement_iterations: 3,
  runtime_feedback_priority_multiplier: 2,
};

export const defaultPriorityWeights = {
  validation: 1,
  evaluation: 1,
  readiness: 1,
};

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function titleFromSlug(value) {
  return normalizeWhitespace(value)
    .split(/[_\-/]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function parseDelimitedList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, "utf8");
}

function sortByKey(values, key) {
  return [...values].sort((left, right) =>
    String(left[key] ?? "").localeCompare(String(right[key] ?? "")),
  );
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => String(left).localeCompare(String(right)));
}

function chunkValues(values, chunkSize) {
  if (chunkSize <= 0 || values.length <= chunkSize) {
    return [values];
  }

  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizeRepoPath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function listManifestPaths(rootDir) {
  const catalogRoot = path.join(rootDir, "catalog");
  if (!fs.existsSync(catalogRoot)) {
    return [];
  }

  const manifestPaths = [];
  const stack = [catalogRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === "spec.yaml") {
        manifestPaths.push(fullPath);
      }
    }
  }

  return manifestPaths.sort();
}

function extractManifestField(manifestText, fieldName) {
  const directMatch = manifestText.match(new RegExp(`^\\s*${fieldName}:\\s*"([^"]+)"`, "m"));
  if (directMatch) {
    return directMatch[1];
  }

  const bareMatch = manifestText.match(new RegExp(`^\\s*${fieldName}:\\s*([^"\\n]+)`, "m"));
  return bareMatch ? normalizeWhitespace(bareMatch[1]) : "";
}

function runGit(rootDir, args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function runCommand(rootDir, command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function listGitRefs(rootDir) {
  try {
    return runGit(rootDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getCurrentBranch(rootDir) {
  try {
    return normalizeWhitespace(runGit(rootDir, ["branch", "--show-current"]));
  } catch {
    return "";
  }
}

function normalizeFileContentForHash(filePath) {
  const contents = readTextIfExists(filePath);
  if (contents === null) {
    return null;
  }

  if (filePath.endsWith(".json")) {
    try {
      return stableStringify(JSON.parse(contents));
    } catch {
      // Fall through to line-based normalization.
    }
  }

  return contents
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function buildAgentSpecHash(agent) {
  const normalizedContent = {};
  for (const relativeFile of REQUIRED_AGENT_FILES) {
    const filePath = path.join(agent.packagePath, relativeFile);
    const normalized = normalizeFileContentForHash(filePath);
    if (normalized !== null) {
      normalizedContent[relativeFile] = normalized;
    }
  }

  return createHash("sha1").update(stableStringify(normalizedContent)).digest("hex");
}

function normalizeRuntimeFeedbackIssue(rawIssue, fallbackSource) {
  if (typeof rawIssue === "string") {
    return {
      type: fallbackSource,
      source: fallbackSource,
      message: normalizeWhitespace(rawIssue),
    };
  }

  return {
    type: String(rawIssue?.type ?? fallbackSource),
    source: String(rawIssue?.source ?? fallbackSource),
    message: normalizeWhitespace(rawIssue?.message ?? rawIssue?.summary ?? ""),
  };
}

function normalizeRuntimeFeedbackInput(input) {
  const normalized = {};
  if (!input) {
    return normalized;
  }

  const sourceValue = input.runtime_feedback ?? input.agents ?? input;
  const entries = Array.isArray(sourceValue)
    ? sourceValue.map((entry) => [entry?.agent_slug, entry])
    : Object.entries(sourceValue);

  for (const [agentSlug, entry] of entries) {
    if (!agentSlug || !entry) {
      continue;
    }

    normalized[String(agentSlug)] = {
      execution_failures: (entry.execution_failures ?? []).map((issue) =>
        normalizeRuntimeFeedbackIssue(issue, "execution"),
      ),
      latency_issues: (entry.latency_issues ?? []).map((issue) =>
        normalizeRuntimeFeedbackIssue(issue, "latency"),
      ),
      unexpected_behavior: (entry.unexpected_behavior ?? []).map((issue) =>
        normalizeRuntimeFeedbackIssue(issue, "unexpected_behavior"),
      ),
      user_feedback: (entry.user_feedback ?? []).map((issue) =>
        normalizeRuntimeFeedbackIssue(issue, "user"),
      ),
    };
  }

  return normalized;
}

function collectChangedCatalogPaths(rootDir) {
  const changedPaths = new Set();
  const commands = [
    ["status", "--short", "--untracked-files=all", "catalog"],
    ["diff", "--name-only", "HEAD", "--", "catalog"],
    ["diff", "--name-only", "HEAD^", "HEAD", "--", "catalog"],
  ];

  for (const command of commands) {
    try {
      const output = runGit(rootDir, command);
      for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }

        const candidatePath = line.includes("->")
          ? line.split("->").at(-1).trim()
          : line.replace(/^[A-Z? ]+/, "").trim();
        if (candidatePath.startsWith("catalog/")) {
          changedPaths.add(candidatePath);
        }
      }
    } catch {
      // Keep trigger detection best-effort and deterministic.
    }
  }

  return [...changedPaths].sort();
}

function createIssue(code, severity, source, message, details = {}) {
  return {
    code,
    severity,
    source,
    message,
    ...details,
  };
}

function createTarget(section, target, reason, source, details = {}) {
  return {
    section,
    target,
    reason,
    source,
    ...details,
  };
}

function issueFingerprint(issue) {
  return stableStringify({
    code: issue.code,
    severity: issue.severity,
    source: issue.source,
    message: issue.message,
    path: issue.path,
  });
}

function normalizeIssue(issue) {
  return {
    code: String(issue?.code ?? "unknown_issue"),
    severity: String(issue?.severity ?? "advisory"),
    source: String(issue?.source ?? "validation"),
    message: normalizeWhitespace(issue?.message ?? issue?.code ?? "Unknown issue"),
    ...(issue?.path ? { path: String(issue.path) } : {}),
  };
}

function normalizeTarget(target) {
  return {
    section: String(target?.section ?? "manifest"),
    target: normalizeWhitespace(target?.target ?? ""),
    reason: normalizeWhitespace(target?.reason ?? ""),
    source: String(target?.source ?? "validation"),
    ...(target?.type ? { type: String(target.type) } : {}),
    ...(target?.priority_multiplier ? { priority_multiplier: Number(target.priority_multiplier) } : {}),
    ...(target?.priority_score !== undefined ? { priority_score: Number(target.priority_score) } : {}),
    ...(target?.issue_code ? { issue_code: String(target.issue_code) } : {}),
    ...(target?.severity ? { severity: String(target.severity) } : {}),
    ...(target?.frequency ? { frequency: Number(target.frequency) } : {}),
    ...(target?.cross_section_impact ? { cross_section_impact: Number(target.cross_section_impact) } : {}),
    ...(target?.runtime_source ? { runtime_source: String(target.runtime_source) } : {}),
    ...(target?.batched ? { batched: Boolean(target.batched) } : {}),
  };
}

function normalizeCodegenCache(rawCache) {
  const normalized = {};
  for (const [agentSlug, entry] of Object.entries(rawCache ?? {})) {
    normalized[String(agentSlug)] = {
      spec_hash: String(entry?.spec_hash ?? ""),
      generated_path: String(entry?.generated_path ?? ""),
    };
  }
  return normalized;
}

function normalizeRuntimeHistory(rawHistory) {
  const normalized = {};
  for (const [agentSlug, entry] of Object.entries(rawHistory ?? {})) {
    normalized[String(agentSlug)] = {
      issues: Array.isArray(entry?.issues)
        ? entry.issues.map((issue) => ({
            type: String(issue?.type ?? "unknown"),
            source: String(issue?.source ?? "runtime"),
            message: normalizeWhitespace(issue?.message ?? ""),
          }))
        : [],
      last_seen: entry?.last_seen ?? null,
    };
  }
  return normalized;
}

function normalizeOscillationState(rawState) {
  const normalized = {};
  const entries = Array.isArray(rawState)
    ? rawState.map((entry) => [entry?.agent_slug, entry])
    : Object.entries(rawState ?? {});

  for (const [agentSlug, entry] of entries) {
    if (!agentSlug) {
      continue;
    }

    normalized[String(agentSlug)] = {
      agent_slug: String(entry?.agent_slug ?? agentSlug),
      suppressed_at_run: Number(entry?.suppressed_at_run ?? 0),
    };
  }

  return normalized;
}

function normalizeAgentHistoryRecord(record) {
  return {
    agent_slug: String(record?.agent_slug ?? ""),
    generated_at: record?.generated_at ?? record?.timestamp ?? null,
    validation_score: round(record?.validation_score ?? 0),
    evaluation_score: round(record?.evaluation_score ?? 0),
    readiness_score: round(record?.readiness_score ?? 0),
    overall_score: round(record?.overall_score ?? 0),
    status: String(record?.status ?? "unknown"),
    issue_codes: uniqueSorted(record?.issue_codes ?? []),
    unresolved_issue_codes: uniqueSorted(record?.unresolved_issue_codes ?? []),
    optimization: record?.optimization ?? null,
  };
}

function normalizeHistoryRun(run) {
  const timestamp = run?.timestamp ?? run?.generated_at ?? null;
  return {
    run_id: String(run?.run_id ?? timestamp ?? `run-${Date.now()}`),
    timestamp,
    trigger: run?.trigger ?? {},
    scope: run?.scope ?? {},
    catalog_health: round(run?.catalog_health ?? run?.health_summary?.catalog_health ?? 0),
    catalog_summary: run?.catalog_summary ?? {},
    health_summary: run?.health_summary ?? {
      catalog_health: round(run?.catalog_health ?? 0),
    },
    health_trend: run?.health_trend ?? {
      trend: run?.health_summary?.trend ?? "flat",
      delta: round(run?.health_summary?.delta ?? 0),
      history: [],
    },
    regressions: sortByKey(
      (run?.regressions ?? run?.regressions_detected ?? []).map((entry) => ({
        agent_slug: String(entry?.agent_slug ?? ""),
        type: String(entry?.type ?? entry?.regression_type ?? "unknown_regression"),
        severity: String(entry?.severity ?? "low"),
        delta: round(entry?.delta ?? 0),
      })),
      "agent_slug",
    ),
    global_issues: sortByKey(
      (run?.global_issues ?? run?.global_priorities ?? []).map((issue) => ({
        ...normalizeIssue(issue),
        priority: String(issue?.priority ?? "P2"),
        agent_slugs: uniqueSorted(issue?.agent_slugs ?? []),
      })),
      "code",
    ),
    agent_results: sortByKey(
      (run?.agent_results ?? []).map((result) => ({
        agent_slug: String(result?.agent_slug ?? ""),
        status: String(result?.status ?? "unknown"),
        overall_score: round(result?.overall_score ?? 0),
        issue_codes: uniqueSorted(result?.issue_codes ?? []),
        unresolved_issue_codes: uniqueSorted(result?.unresolved_issue_codes ?? []),
        optimization: result?.optimization ?? null,
      })),
      "agent_slug",
    ),
    refinement_targets: sortByKey(
      (run?.refinement_targets ?? []).map((target) => ({
        agent_slug: String(target?.agent_slug ?? ""),
        targets: (target?.targets ?? []).map(normalizeTarget),
      })),
      "agent_slug",
    ),
    patterns: sortByKey(
      (run?.patterns ?? []).map((pattern) => ({
        type: String(pattern?.type ?? "unknown_pattern"),
        source: String(pattern?.source ?? "validation"),
        frequency: Number(pattern?.frequency ?? 0),
        affected_agents: uniqueSorted(pattern?.affected_agents ?? []),
      })),
      "type",
    ),
    priority_weights: {
      ...defaultPriorityWeights,
      ...(run?.priority_weights ?? {}),
    },
    learning_updates: Array.isArray(run?.learning_updates) ? run.learning_updates : [],
    convergence_control: run?.convergence_control ?? null,
    runtime_feedback_applied: run?.runtime_feedback_applied ?? null,
  };
}

function normalizeHistory(rawHistory) {
  const runs = Array.isArray(rawHistory?.runs) ? rawHistory.runs.map(normalizeHistoryRun) : [];
  const latestByAgent = {};
  for (const [slug, record] of Object.entries(rawHistory?.latest_by_agent ?? {})) {
    latestByAgent[slug] = normalizeAgentHistoryRecord({ ...record, agent_slug: slug });
  }

  const latestCatalog = rawHistory?.latest_catalog
    ? {
        catalog_health: round(rawHistory.latest_catalog.catalog_health ?? 0),
        trend: String(rawHistory.latest_catalog.trend ?? "flat"),
        delta: round(rawHistory.latest_catalog.delta ?? 0),
        generated_at: rawHistory.latest_catalog.generated_at ?? null,
        priority_weights: {
          ...defaultPriorityWeights,
          ...(rawHistory.latest_catalog.priority_weights ?? {}),
        },
      }
    : null;

  const healthHistory =
    Array.isArray(rawHistory?.health_history) && rawHistory.health_history.length > 0
      ? rawHistory.health_history.map((entry) => ({
          timestamp: entry?.timestamp ?? null,
          health_score: round(entry?.health_score ?? 0),
        }))
      : runs.map((run) => ({
          timestamp: run.timestamp,
          health_score: round(run.catalog_health),
        }));

  return {
    version: Number(rawHistory?.version ?? 2),
    runs,
    latest_by_agent: latestByAgent,
    latest_catalog: latestCatalog,
    health_history: healthHistory,
    learning: {
      priority_weights: {
        ...defaultPriorityWeights,
        ...(rawHistory?.learning?.priority_weights ?? latestCatalog?.priority_weights ?? {}),
      },
      patterns: Array.isArray(rawHistory?.learning?.patterns) ? rawHistory.learning.patterns : [],
      recommended_updates: Array.isArray(rawHistory?.learning?.recommended_updates)
        ? rawHistory.learning.recommended_updates
        : [],
      deprecated_patterns: Array.isArray(rawHistory?.learning?.deprecated_patterns)
        ? rawHistory.learning.deprecated_patterns
        : [],
      oscillation_state: normalizeOscillationState(rawHistory?.learning?.oscillation_state),
      codegen_cache: normalizeCodegenCache(rawHistory?.learning?.codegen_cache),
      runtime_history: normalizeRuntimeHistory(rawHistory?.learning?.runtime_history),
    },
  };
}

export function discoverCatalogAgents(rootDir = process.cwd()) {
  return listManifestPaths(rootDir).map((manifestPath) => {
    const relativeManifestPath = path.relative(rootDir, manifestPath);
    const parts = relativeManifestPath.split(path.sep);
    const slug = parts.at(-2) ?? path.basename(path.dirname(manifestPath));
    const domain = parts.slice(1, -2).join("/");
    const packagePath = path.dirname(manifestPath);
    const manifestText = readTextIfExists(manifestPath) ?? "";

    return {
      slug,
      name: extractManifestField(manifestText, "name") || titleFromSlug(slug),
      domain,
      packagePath,
      relativePackagePath: path.relative(rootDir, packagePath),
      manifestPath,
      status: extractManifestField(manifestText, "status") || "unknown",
    };
  });
}

export function detectChangedAgentSlugs(rootDir = process.cwd()) {
  const slugs = new Set();
  for (const candidatePath of collectChangedCatalogPaths(rootDir)) {
    const parts = candidatePath.split("/");
    if (parts[0] === "catalog" && parts.length >= 3) {
      const slug = parts.at(-2) ?? "";
      if (slug) {
        slugs.add(slug);
      }
    }
  }

  return [...slugs].sort();
}

export function loadImprovementHistory(historyPath) {
  if (!fs.existsSync(historyPath)) {
    return normalizeHistory({
      version: 2,
      runs: [],
      latest_by_agent: {},
      latest_catalog: null,
      health_history: [],
      learning: {
        priority_weights: defaultPriorityWeights,
        patterns: [],
        recommended_updates: [],
        deprecated_patterns: [],
      },
    });
  }

  return normalizeHistory(readJsonIfExists(historyPath));
}

function getValidationScore(agent) {
  const issues = [];
  let presentCount = 0;

  for (const relativeFile of REQUIRED_AGENT_FILES) {
    const filePath = path.join(agent.packagePath, relativeFile);
    if (fs.existsSync(filePath)) {
      presentCount += 1;
      continue;
    }

    issues.push(
      createIssue(
        "missing_required_artifact",
        "blocking",
        "validation",
        `Missing required agent package artifact: ${relativeFile}`,
        { path: path.relative(agent.packagePath, filePath) },
      ),
    );
  }

  return {
    score: round(presentCount / REQUIRED_AGENT_FILES.length),
    issues,
  };
}

function getEvaluationScore(agent) {
  const issues = [];
  const resultsPath = path.join(agent.packagePath, "evaluation", "results.json");
  const results = readJsonIfExists(resultsPath);

  if (!results) {
    issues.push(
      createIssue(
        "missing_evaluation_results",
        "critical",
        "evaluation",
        "Missing evaluation/results.json for package.",
      ),
    );
    return { score: 0, issues, metadata: null };
  }

  const passRate = clamp(Number(results.pass_rate ?? 0), 0, 1);
  const minPassRate = clamp(Number(results.minimum_pass_rate ?? 0), 0, 1);
  if (!results.accuracy_acceptance_met || passRate < minPassRate) {
    issues.push(
      createIssue(
        "evaluation_below_threshold",
        "critical",
        "evaluation",
        `Evaluation pass rate ${passRate} is below the minimum ${minPassRate}.`,
      ),
    );
  }

  return {
    score: round(passRate),
    issues,
    metadata: {
      scenario_count: Number(results.scenario_count ?? 0),
      pass_rate: passRate,
      minimum_pass_rate: minPassRate,
    },
  };
}

function getReadinessScore(agent) {
  const issues = [];
  const evidencePath = path.join(agent.packagePath, "readiness", "evidence.json");
  const evidence = readJsonIfExists(evidencePath);

  if (!evidence) {
    issues.push(
      createIssue(
        "missing_readiness_evidence",
        "critical",
        "readiness",
        "Missing readiness/evidence.json for package.",
      ),
    );
    return { score: 0, issues, metadata: null };
  }

  const readinessChecks = [
    Boolean(evidence.human_verification?.recorded),
    Boolean(evidence.deployment_readiness?.ready),
    Boolean(evidence.deployment_readiness?.package_documented),
    Boolean(evidence.deployment_readiness?.rollback_defined),
    Boolean(evidence.deployment_readiness?.monitoring_defined),
    Boolean(evidence.deployment_readiness?.tenant_isolation_defined),
    Boolean(evidence.deployment_readiness?.cache_freshness_defined),
  ];
  const score = readinessChecks.filter(Boolean).length / readinessChecks.length;

  if (!evidence.human_verification?.recorded) {
    issues.push(
      createIssue(
        "missing_human_verification",
        "critical",
        "readiness",
        "Human verification is not recorded in readiness evidence.",
      ),
    );
  }

  if (!evidence.deployment_readiness?.ready) {
    issues.push(
      createIssue(
        "deployment_not_ready",
        "critical",
        "readiness",
        "Deployment readiness is not marked ready.",
      ),
    );
  }

  return {
    score: round(score),
    issues,
    metadata: {
      delivery_status: evidence.delivery_status ?? "unknown",
      deployment_ready: Boolean(evidence.deployment_readiness?.ready),
      completeness_ratio: round(score),
      check_count: readinessChecks.length,
      passing_checks: readinessChecks.filter(Boolean).length,
    },
  };
}

function assertAllowedPath(rootDir, filePath, allowedPaths = mutationAllowedPaths) {
  const relativePath = normalizeRepoPath(path.relative(rootDir, filePath));
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to write outside repository root: ${filePath}`);
  }

  if (!allowedPaths.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) {
    throw new Error(`Refusing to write outside mutation allowlist: ${relativePath}`);
  }

  return relativePath;
}

function parseJsonObject(contents, fallback = {}) {
  if (!contents || !String(contents).trim()) {
    return structuredClone(fallback);
  }

  try {
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function normalizeMarkdownDocument(title, bodyLines = []) {
  const trimmedLines = bodyLines
    .map((line) => String(line ?? "").replace(/\s+$/g, ""))
    .filter((line, index, values) => line.length > 0 || (index > 0 && index < values.length - 1));
  return `# ${title}\n\n${trimmedLines.join("\n")}\n`;
}

function extractManifestMetadata(manifestText, agent) {
  const agentId = extractManifestField(manifestText, "agent_id") || `${agent.slug}-v0.1.0`;
  return {
    agent_id: agentId,
    slug: extractManifestField(manifestText, "slug") || agent.slug,
    name: extractManifestField(manifestText, "name") || agent.name || titleFromSlug(agent.slug),
    domain_family: extractManifestField(manifestText, "domain_family") || agent.domain,
    status: extractManifestField(manifestText, "status") || agent.status || "deployable",
  };
}

function escapeYamlString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderDefaultManifest(agent, generatedAt, existingManifestText = "") {
  const metadata = extractManifestMetadata(existingManifestText, agent);
  const currentDate = String(generatedAt ?? new Date().toISOString()).slice(0, 10);
  return `schema_version: "1.0"
kind: "agent_definition"

metadata:
  agent_id: "${escapeYamlString(metadata.agent_id)}"
  slug: "${escapeYamlString(metadata.slug)}"
  name: "${escapeYamlString(metadata.name)}"
  domain_family: "${escapeYamlString(metadata.domain_family)}"
  status: "${escapeYamlString(metadata.status)}"
  owner: "autonomous-improvement-system"
  created_at: "${currentDate}"
  last_updated_at: "${currentDate}"
`;
}

function inferReleaseVersion(agent, manifestText = "", evaluationResults = null, readinessEvidence = null) {
  const manifestAgentId = extractManifestField(manifestText, "agent_id");
  const manifestMatch = /-(v[\d.]+(?:[-a-z0-9.]*)?)$/i.exec(manifestAgentId);
  if (manifestMatch) {
    return manifestMatch[1];
  }

  if (normalizeWhitespace(evaluationResults?.agent_release)) {
    return normalizeWhitespace(evaluationResults.agent_release);
  }

  if (normalizeWhitespace(readinessEvidence?.release_version)) {
    return normalizeWhitespace(readinessEvidence.release_version);
  }

  return "v0.1.0";
}

function createMutationSchema(rootDir, agent) {
  const files = new Map();
  for (const relativeFile of REQUIRED_AGENT_FILES) {
    const filePath = path.join(agent.packagePath, relativeFile);
    files.set(relativeFile, {
      path: filePath,
      exists: fs.existsSync(filePath),
      originalContent: readTextIfExists(filePath) ?? "",
      content: readTextIfExists(filePath) ?? "",
    });
  }

  return {
    rootDir,
    agent,
    files,
    modifiedFiles: new Set(),
  };
}

function getSchemaFile(schema, relativeFile) {
  const file = schema.files.get(relativeFile);
  if (!file) {
    throw new Error(`Unknown package artifact: ${relativeFile}`);
  }
  return file;
}

function setSchemaFile(schema, relativeFile, content) {
  const file = getSchemaFile(schema, relativeFile);
  const normalizedContent = String(content);
  file.content = normalizedContent;
  if (normalizedContent !== file.originalContent) {
    schema.modifiedFiles.add(relativeFile);
  } else {
    schema.modifiedFiles.delete(relativeFile);
  }
  return normalizedContent !== file.originalContent;
}

function setSchemaJson(schema, relativeFile, value) {
  return setSchemaFile(schema, relativeFile, `${JSON.stringify(value, null, 2)}\n`);
}

function getSchemaJson(schema, relativeFile, fallback = {}) {
  return parseJsonObject(getSchemaFile(schema, relativeFile).content, fallback);
}

function ensureRequiredMarkdownArtifact(schema, relativeFile, title, bodyLines) {
  const file = getSchemaFile(schema, relativeFile);
  if (normalizeWhitespace(file.content).length > 0) {
    return false;
  }
  return setSchemaFile(schema, relativeFile, normalizeMarkdownDocument(title, bodyLines));
}

function buildDefaultArtifactContent(schema, relativeFile, generatedAt) {
  const manifestText = getSchemaFile(schema, "spec.yaml").content;
  const evaluationResults = getSchemaJson(schema, "evaluation/results.json");
  const readinessEvidence = getSchemaJson(schema, "readiness/evidence.json");
  const releaseVersion = inferReleaseVersion(schema.agent, manifestText, evaluationResults, readinessEvidence);
  const generatedDate = String(generatedAt ?? new Date().toISOString()).slice(0, 10);

  switch (relativeFile) {
    case "spec.yaml":
      return renderDefaultManifest(schema.agent, generatedAt, manifestText);
    case "evaluation/scenarios.md":
      return normalizeMarkdownDocument("Evaluation Scenarios", [
        `1. Baseline placeholder scenario for ${schema.agent.name}.`,
      ]);
    case "evaluation/results.json":
      return `${JSON.stringify({
        agent_slug: schema.agent.slug,
        agent_release: releaseVersion,
        executed_at: generatedDate,
        validation_profile: "strict",
        scenario_count: 0,
        pass_count: 0,
        pass_rate: 0,
        minimum_pass_rate: 0.9,
        regressions: [],
        accuracy_acceptance_met: false,
        reviewer: "autonomous-improvement-system",
        evidence_artifacts: REQUIRED_AGENT_FILES.map((entry) =>
          normalizeRepoPath(path.join(schema.agent.relativePackagePath, entry))),
        notes: [
          "Autonomous scaffold created because evaluation artifacts were incomplete.",
        ],
      }, null, 2)}\n`;
    case "readiness/release.md":
      return normalizeMarkdownDocument("Release Readiness", [
        `- release_version: ${releaseVersion}`,
        "- reviewer: autonomous-improvement-system",
        "- status: pending verification",
      ]);
    case "readiness/evidence.json":
      return `${JSON.stringify({
        agent_slug: schema.agent.slug,
        release_version: releaseVersion,
        delivery_status: extractManifestField(manifestText, "status") || "deployable",
        human_verification: {
          recorded: false,
          reviewer: "autonomous-improvement-system",
          verified_at: generatedDate,
          method: "Pending human verification after autonomous normalization.",
        },
        deployment_readiness: {
          ready: false,
          package_documented: false,
          rollback_defined: false,
          monitoring_defined: false,
          tenant_isolation_defined: false,
          cache_freshness_defined: false,
        },
        acceptance_evidence: {
          package_path: `${normalizeRepoPath(schema.agent.relativePackagePath)}/`,
          minimum_scenario_count_met: false,
          minimum_pass_rate_met: false,
          accuracy_acceptance_met: false,
          no_unreviewed_regressions: true,
        },
        notes: [
          "Autonomous scaffold created because readiness evidence was incomplete.",
        ],
      }, null, 2)}\n`;
    case "deployment/package.md":
      return normalizeMarkdownDocument("Deployment Package", [
        "Runtime model: pending.",
        "Rollback plan: pending.",
        "Monitoring plan: pending.",
        "Tenant isolation: pending.",
        "Cache freshness: pending.",
      ]);
    case "positioning/readiness.md":
      return normalizeMarkdownDocument("Marketing Readiness", [
        "Buyer profile: pending.",
        "Proof points: pending.",
        "Go-to-market gaps: pending.",
      ]);
    default:
      return "";
  }
}

function applyMissingArtifactMutations(schema, feedbackIssues, generatedAt) {
  const mutations = [];
  const missingIssues = sortByKey(
    feedbackIssues.filter((issue) => issue.code === "missing_required_artifact" && issue.path),
    "path",
  );

  for (const issue of missingIssues) {
    const relativeFile = normalizeRepoPath(issue.path);
    if (!REQUIRED_AGENT_FILES.includes(relativeFile)) {
      continue;
    }

    const defaultContent = buildDefaultArtifactContent(schema, relativeFile, generatedAt);
    if (setSchemaFile(schema, relativeFile, defaultContent)) {
      mutations.push({
        target: relativeFile,
        file: relativeFile,
        transformation: "restore_required_artifact",
      });
    }
  }

  return mutations;
}

function buildDeploymentSignals(schema) {
  const deploymentText = [
    getSchemaFile(schema, "deployment/package.md").content,
    getSchemaFile(schema, "readiness/release.md").content,
  ].join("\n").toLowerCase();
  const marketingText = getSchemaFile(schema, "positioning/readiness.md").content.toLowerCase();

  return {
    package_documented: normalizeWhitespace(getSchemaFile(schema, "deployment/package.md").content).length > 0,
    rollback_defined: /\brollback\b|\brevert\b|\bbackout\b/.test(deploymentText),
    monitoring_defined: /\bmonitor|\bobservab|\balert|\blogging\b/.test(deploymentText),
    tenant_isolation_defined: /\btenant\b|\bisolation\b/.test(deploymentText),
    cache_freshness_defined: /\bcache\b|\bfreshness\b|\bttl\b/.test(deploymentText),
    positioning_defined: /\bbuyer\b|\bposition|\bpersona\b/.test(marketingText),
    subscription_model_defined: /\bsubscription\b|\bpricing\b|\bplan\b/.test(marketingText),
    proof_points_defined: /\bproof\b|\btestimonial\b|\bcase stud|\breference\b/.test(marketingText),
    gtm_gaps_documented: /\bgap\b|\brisk\b|\bpending\b/.test(marketingText),
  };
}

function normalizeEvaluationResultsArtifact(schema, generatedAt) {
  const manifestText = getSchemaFile(schema, "spec.yaml").content;
  const current = getSchemaJson(schema, "evaluation/results.json");
  const releaseVersion = inferReleaseVersion(schema.agent, manifestText, current, getSchemaJson(schema, "readiness/evidence.json"));
  const scenarioCount = Math.max(0, Number(current.scenario_count ?? current.pass_count ?? 0));
  const passCount = clamp(Number(current.pass_count ?? Math.round(Number(current.pass_rate ?? 0) * scenarioCount)), 0, scenarioCount);
  const passRate = scenarioCount > 0
    ? round(passCount / scenarioCount)
    : clamp(Number(current.pass_rate ?? 0), 0, 1);
  const minimumPassRate = clamp(Number(current.minimum_pass_rate ?? 0.9), 0, 1);

  return {
    agent_slug: schema.agent.slug,
    agent_release: releaseVersion,
    executed_at: normalizeWhitespace(current.executed_at) || String(generatedAt ?? new Date().toISOString()).slice(0, 10),
    validation_profile: normalizeWhitespace(current.validation_profile) || "strict",
    scenario_count: scenarioCount,
    pass_count: passCount,
    pass_rate: passRate,
    minimum_pass_rate: minimumPassRate,
    regressions: Array.isArray(current.regressions) ? current.regressions : [],
    accuracy_acceptance_met:
      typeof current.accuracy_acceptance_met === "boolean"
        ? current.accuracy_acceptance_met
        : passRate >= minimumPassRate,
    reviewer: normalizeWhitespace(current.reviewer) || "autonomous-improvement-system",
    evidence_artifacts: uniqueSorted(
      (Array.isArray(current.evidence_artifacts) ? current.evidence_artifacts : []).concat(
        REQUIRED_AGENT_FILES.map((entry) => normalizeRepoPath(path.join(schema.agent.relativePackagePath, entry))),
      ),
    ),
    notes: Array.isArray(current.notes) ? current.notes.map((entry) => normalizeWhitespace(entry)).filter(Boolean) : [],
    ...(Array.isArray(current.scenario_results) ? { scenario_results: current.scenario_results } : {}),
  };
}

function normalizeReadinessEvidenceArtifact(schema, generatedAt) {
  const manifestText = getSchemaFile(schema, "spec.yaml").content;
  const evaluationResults = normalizeEvaluationResultsArtifact(schema, generatedAt);
  const current = getSchemaJson(schema, "readiness/evidence.json");
  const releaseVersion = inferReleaseVersion(schema.agent, manifestText, evaluationResults, current);
  const signals = buildDeploymentSignals(schema);
  const humanVerification = {
    recorded: Boolean(current.human_verification?.recorded),
    reviewer: normalizeWhitespace(current.human_verification?.reviewer) || "autonomous-improvement-system",
    verified_at: normalizeWhitespace(current.human_verification?.verified_at) || String(generatedAt ?? new Date().toISOString()).slice(0, 10),
    ...(normalizeWhitespace(current.human_verification?.method)
      ? { method: normalizeWhitespace(current.human_verification.method) }
      : { method: "Pending human verification after autonomous normalization." }),
  };
  const deploymentReadiness = {
    ready:
      typeof current.deployment_readiness?.ready === "boolean"
        ? current.deployment_readiness.ready
        : false,
    package_documented:
      typeof current.deployment_readiness?.package_documented === "boolean"
        ? current.deployment_readiness.package_documented
        : signals.package_documented,
    rollback_defined:
      typeof current.deployment_readiness?.rollback_defined === "boolean"
        ? current.deployment_readiness.rollback_defined
        : signals.rollback_defined,
    monitoring_defined:
      typeof current.deployment_readiness?.monitoring_defined === "boolean"
        ? current.deployment_readiness.monitoring_defined
        : signals.monitoring_defined,
    tenant_isolation_defined:
      typeof current.deployment_readiness?.tenant_isolation_defined === "boolean"
        ? current.deployment_readiness.tenant_isolation_defined
        : signals.tenant_isolation_defined,
    cache_freshness_defined:
      typeof current.deployment_readiness?.cache_freshness_defined === "boolean"
        ? current.deployment_readiness.cache_freshness_defined
        : signals.cache_freshness_defined,
  };
  if (!deploymentReadiness.ready) {
    deploymentReadiness.ready =
      humanVerification.recorded &&
      deploymentReadiness.package_documented &&
      deploymentReadiness.rollback_defined &&
      deploymentReadiness.monitoring_defined &&
      deploymentReadiness.tenant_isolation_defined &&
      deploymentReadiness.cache_freshness_defined;
  }

  const commercializationReadiness = current.commercialization_readiness && typeof current.commercialization_readiness === "object"
    ? {
        ...current.commercialization_readiness,
        ready:
          typeof current.commercialization_readiness.ready === "boolean"
            ? current.commercialization_readiness.ready
            : false,
        positioning_defined:
          typeof current.commercialization_readiness.positioning_defined === "boolean"
            ? current.commercialization_readiness.positioning_defined
            : signals.positioning_defined,
        subscription_model_defined:
          typeof current.commercialization_readiness.subscription_model_defined === "boolean"
            ? current.commercialization_readiness.subscription_model_defined
            : signals.subscription_model_defined,
        proof_points_defined:
          typeof current.commercialization_readiness.proof_points_defined === "boolean"
            ? current.commercialization_readiness.proof_points_defined
            : signals.proof_points_defined,
        gtm_gaps_documented:
          typeof current.commercialization_readiness.gtm_gaps_documented === "boolean"
            ? current.commercialization_readiness.gtm_gaps_documented
            : signals.gtm_gaps_documented,
      }
    : {
        ready: false,
        positioning_defined: signals.positioning_defined,
        subscription_model_defined: signals.subscription_model_defined,
        proof_points_defined: signals.proof_points_defined,
        gtm_gaps_documented: signals.gtm_gaps_documented,
      };

  const acceptanceEvidence = {
    ...(current.acceptance_evidence && typeof current.acceptance_evidence === "object"
      ? current.acceptance_evidence
      : {}),
    package_path: normalizeWhitespace(current.acceptance_evidence?.package_path) || `${normalizeRepoPath(schema.agent.relativePackagePath)}/`,
    minimum_scenario_count_met:
      typeof current.acceptance_evidence?.minimum_scenario_count_met === "boolean"
        ? current.acceptance_evidence.minimum_scenario_count_met
        : evaluationResults.scenario_count > 0,
    minimum_pass_rate_met:
      typeof current.acceptance_evidence?.minimum_pass_rate_met === "boolean"
        ? current.acceptance_evidence.minimum_pass_rate_met
        : evaluationResults.pass_rate >= evaluationResults.minimum_pass_rate,
    accuracy_acceptance_met:
      typeof current.acceptance_evidence?.accuracy_acceptance_met === "boolean"
        ? current.acceptance_evidence.accuracy_acceptance_met
        : evaluationResults.accuracy_acceptance_met,
    no_unreviewed_regressions:
      typeof current.acceptance_evidence?.no_unreviewed_regressions === "boolean"
        ? current.acceptance_evidence.no_unreviewed_regressions
        : Array.isArray(evaluationResults.regressions)
          ? evaluationResults.regressions.length === 0
          : true,
  };

  return {
    agent_slug: schema.agent.slug,
    release_version: releaseVersion,
    delivery_status: normalizeWhitespace(current.delivery_status) || extractManifestField(manifestText, "status") || "deployable",
    human_verification: humanVerification,
    deployment_readiness: deploymentReadiness,
    commercialization_readiness: commercializationReadiness,
    acceptance_evidence: acceptanceEvidence,
    notes: Array.isArray(current.notes) ? current.notes.map((entry) => normalizeWhitespace(entry)).filter(Boolean) : [],
    ...(Array.isArray(current.specialist_owned_evidence)
      ? { specialist_owned_evidence: current.specialist_owned_evidence }
      : {}),
    ...(Array.isArray(current.delegated_meta_agent_evidence)
      ? { delegated_meta_agent_evidence: current.delegated_meta_agent_evidence }
      : {}),
  };
}

async function validateMutationCandidate(schema, options = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "catalog-improvement-mutation-"));
  try {
    const relativePackagePath = normalizeRepoPath(schema.agent.relativePackagePath);
    const tempPackagePath = path.join(tempRoot, relativePackagePath);
    await fsp.cp(schema.agent.packagePath, tempPackagePath, { recursive: true, force: true });

    for (const [relativeFile, file] of schema.files.entries()) {
      const tempFilePath = path.join(tempPackagePath, relativeFile);
      ensureDirectory(tempFilePath);
      await fsp.writeFile(tempFilePath, file.content, "utf8");
    }

    const tempAgent = {
      ...schema.agent,
      packagePath: tempPackagePath,
      manifestPath: path.join(tempPackagePath, "spec.yaml"),
      relativePackagePath,
    };
    const validationResult = await analyzeAgent(
      tempAgent,
      options.history ?? normalizeHistory({}),
      options.policyEngine ?? defaultPolicyEngine,
      options.runtimeFeedbackByAgent ?? {},
    );
    const originalBlockingIssues = new Set(
      (options.originalResult?.errors ?? [])
        .filter((issue) => issue.severity === "blocking")
        .map(issueFingerprint),
    );
    const newBlockingErrors = validationResult.errors.filter(
      (issue) => issue.severity === "blocking" && !originalBlockingIssues.has(issueFingerprint(issue)),
    );
    const scoreRegressions = {
      validation:
        round(validationResult.health.validation) < round(options.originalResult?.health?.validation ?? 0),
      evaluation:
        round(validationResult.health.evaluation) < round(options.originalResult?.health?.evaluation ?? 0),
      readiness:
        round(validationResult.health.readiness) < round(options.originalResult?.health?.readiness ?? 0),
    };
    const validationPassed = newBlockingErrors.length === 0 && !Object.values(scoreRegressions).some(Boolean);
    return {
      validation_passed: validationPassed,
      reason: validationPassed ? "success" : "validation_failed",
      new_errors: newBlockingErrors,
      score_regressions: scoreRegressions,
      result: validationResult,
    };
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function persistMutationSchema(schema, options = {}) {
  const writtenFiles = [];
  for (const relativeFile of schema.modifiedFiles) {
    const file = getSchemaFile(schema, relativeFile);
    assertAllowedPath(options.rootDir ?? schema.rootDir, file.path, options.allowedPaths);
    ensureDirectory(file.path);
    await fsp.writeFile(file.path, file.content, "utf8");
    writtenFiles.push(relativeFile);
  }
  return writtenFiles.sort();
}

export async function applyRefinementTargets(schema, targets, options = {}) {
  const uniqueTargets = [];
  const seenTargets = new Set();
  for (const target of targets.map(normalizeTarget)) {
    const key = buildRefinementTargetKey(target);
    if (seenTargets.has(key)) {
      continue;
    }
    seenTargets.add(key);
    uniqueTargets.push(target);
  }

  const feedbackIssues = [...(options.feedback?.errors ?? []), ...(options.feedback?.warnings ?? [])]
    .map(normalizeIssue)
    .sort((left, right) => issueFingerprint(left).localeCompare(issueFingerprint(right)));
  const mutationDetails = [];
  let targetsApplied = 0;

  const missingArtifactMutations = applyMissingArtifactMutations(schema, feedbackIssues, options.generatedAt);
  if (missingArtifactMutations.length > 0) {
    targetsApplied += missingArtifactMutations.length;
    mutationDetails.push(...missingArtifactMutations);
  }

  for (const target of uniqueTargets) {
    const modifiedBefore = schema.modifiedFiles.size;

    if (target.section === "manifest" && normalizeWhitespace(getSchemaFile(schema, "spec.yaml").content).length === 0) {
      setSchemaFile(schema, "spec.yaml", buildDefaultArtifactContent(schema, "spec.yaml", options.generatedAt));
    } else if (target.section === "evaluation") {
      ensureRequiredMarkdownArtifact(schema, "evaluation/scenarios.md", "Evaluation Scenarios", [
        `1. Baseline placeholder scenario for ${schema.agent.name}.`,
      ]);
      setSchemaJson(schema, "evaluation/results.json", normalizeEvaluationResultsArtifact(schema, options.generatedAt));
    } else if (target.section === "readiness") {
      ensureRequiredMarkdownArtifact(schema, "readiness/release.md", "Release Readiness", [
        `- reviewer: autonomous-improvement-system`,
        "- status: pending verification",
      ]);
      ensureRequiredMarkdownArtifact(schema, "deployment/package.md", "Deployment Package", [
        "Runtime model: pending.",
        "Rollback plan: pending.",
        "Monitoring plan: pending.",
        "Tenant isolation: pending.",
        "Cache freshness: pending.",
      ]);
      ensureRequiredMarkdownArtifact(schema, "positioning/readiness.md", "Marketing Readiness", [
        "Buyer profile: pending.",
        "Proof points: pending.",
        "Go-to-market gaps: pending.",
      ]);
      setSchemaJson(schema, "readiness/evidence.json", normalizeReadinessEvidenceArtifact(schema, options.generatedAt));
    }

    if (schema.modifiedFiles.size > modifiedBefore) {
      targetsApplied += 1;
      mutationDetails.push({
        target: target.target,
        section: target.section,
        transformation: target.issue_code ?? target.type ?? "deterministic_normalization",
      });
    }
  }

  const validation = await validateMutationCandidate(schema, options);
  if (!validation.validation_passed) {
    return {
      mutation_status: "rejected",
      reason: validation.reason,
      targets_applied: 0,
      files_modified: 0,
      modified_files: [],
      details: [],
      validation,
      empty_run: schema.modifiedFiles.size === 0,
    };
  }

  const modifiedFiles = await persistMutationSchema(schema, options);
  return {
    mutation_status: modifiedFiles.length > 0 ? "applied" : "rejected",
    reason: modifiedFiles.length > 0 ? "success" : "no_changes",
    targets_applied: targetsApplied,
    files_modified: modifiedFiles.length,
    modified_files: modifiedFiles,
    details: mutationDetails,
    validation,
    empty_run: modifiedFiles.length === 0,
  };
}

function getStatusAndDecision(overallScore, issues, policyEngine) {
  const blockingCount = issues.filter((issue) => issue.severity === "blocking").length;
  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;

  if (blockingCount > 0) {
    return {
      status: "blocked",
      convergence_state: "route_to_human_or_adjacent_specialist",
    };
  }

  if (criticalCount > 0 || overallScore < policyEngine.health_threshold) {
    return {
      status: "needs_refinement",
      convergence_state: "refine_and_retry",
    };
  }

  return {
    status: "converged",
    convergence_state: "converged",
  };
}

function buildRuntimeFeedbackTargets(agentSlug, runtimeFeedback, policyEngine) {
  if (!runtimeFeedback) {
    return [];
  }

  const multiplier = Number(
    policyEngine.runtime_feedback_priority_multiplier ?? defaultPolicyEngine.runtime_feedback_priority_multiplier,
  );
  const targets = [];
  for (const issue of runtimeFeedback.execution_failures ?? []) {
    targets.push(
      createTarget(
        "actions",
        `Review action inputs, outputs, and failure handling for ${agentSlug}`,
        issue.message,
        "runtime",
        {
          type: "runtime_feedback",
          issue_code: issue.type,
          severity: "critical",
          priority_multiplier: multiplier,
          runtime_source: "execution",
        },
      ),
    );
  }

  for (const issue of runtimeFeedback.latency_issues ?? []) {
    targets.push(
      createTarget(
        "interfaces",
        `Tighten latency-sensitive contracts and interface behavior for ${agentSlug}`,
        issue.message,
        "runtime",
        {
          type: "runtime_feedback",
          issue_code: issue.type,
          severity: "advisory",
          priority_multiplier: multiplier,
          runtime_source: "latency",
        },
      ),
    );
  }

  for (const issue of runtimeFeedback.unexpected_behavior ?? []) {
    targets.push(
      createTarget(
        "flows",
        `Review missing steps, transitions, and assumptions for ${agentSlug}`,
        issue.message,
        "runtime",
        {
          type: "runtime_feedback",
          issue_code: issue.type,
          severity: "critical",
          priority_multiplier: multiplier,
          runtime_source: "execution",
        },
      ),
    );
  }

  for (const issue of runtimeFeedback.user_feedback ?? []) {
    targets.push(
      createTarget(
        "interfaces",
        `Refine interface expectations and user-facing behavior for ${agentSlug}`,
        issue.message,
        "runtime",
        {
          type: "runtime_feedback",
          issue_code: issue.type,
          severity: "advisory",
          priority_multiplier: multiplier,
          runtime_source: "user",
        },
      ),
    );
  }

  return targets;
}

function buildRefinementTargets(agent, issues, runtimeFeedback, policyEngine) {
  return issues.map((issue) => {
    if (issue.code.startsWith("missing_")) {
      return createTarget(
        issue.source,
        `Restore ${issue.code.replace(/^missing_/, "").replace(/_/g, " ")}`,
        issue.message,
        issue.source,
        {
          issue_code: issue.code,
          severity: issue.severity,
          priority_multiplier: 1,
        },
      );
    }

    if (issue.code === "evaluation_below_threshold") {
      return createTarget(
        "evaluation",
        "Improve scenario quality or acceptance thresholds",
        issue.message,
        "evaluation",
        {
          issue_code: issue.code,
          severity: issue.severity,
          priority_multiplier: 1,
        },
      );
    }

    if (issue.code === "deployment_not_ready" || issue.code === "missing_human_verification") {
      return createTarget(
        "readiness",
        "Strengthen readiness evidence and release review",
        issue.message,
        "readiness",
        {
          issue_code: issue.code,
          severity: issue.severity,
          priority_multiplier: 1,
        },
      );
    }

    return createTarget("manifest", `Review ${agent.slug}`, issue.message, issue.source, {
      issue_code: issue.code,
      severity: issue.severity,
      priority_multiplier: 1,
    });
  }).concat(buildRuntimeFeedbackTargets(agent.slug, runtimeFeedback, policyEngine));
}

function buildSchemaDiff(previousRecord, currentRecord) {
  if (!previousRecord) {
    return {
      changed_fields: ["initial_run"],
      delta: currentRecord.overall_score,
    };
  }

  const changedFields = [];
  for (const field of ["validation_score", "evaluation_score", "readiness_score", "overall_score", "status"]) {
    if (previousRecord[field] !== currentRecord[field]) {
      changedFields.push(field);
    }
  }

  if (
    stableStringify(previousRecord.unresolved_issue_codes ?? []) !==
    stableStringify(currentRecord.unresolved_issue_codes ?? [])
  ) {
    changedFields.push("unresolved_issue_codes");
  }

  return {
    changed_fields: changedFields,
    delta: round(currentRecord.overall_score - previousRecord.overall_score),
  };
}

function buildRegressions(previousRecord, currentRecord, policyEngine, currentIssues) {
  if (!previousRecord) {
    return [];
  }

  const regressions = [];
  const thresholds = Number(policyEngine.regression_threshold ?? defaultPolicyEngine.regression_threshold);
  const checks = [
    ["validation_score", "validation_score_drop"],
    ["evaluation_score", "evaluation_score_drop"],
    ["readiness_score", "readiness_score_drop"],
  ];

  for (const [field, type] of checks) {
    const delta = round(currentRecord[field] - previousRecord[field]);
    if (delta >= 0) {
      continue;
    }

    const absoluteDrop = Math.abs(delta);
    let severity = "low";
    if (absoluteDrop >= Math.max(0.2, thresholds * 2)) {
      severity = "high";
    } else if (absoluteDrop >= thresholds) {
      severity = "medium";
    }

    regressions.push({
      agent_slug: currentRecord.agent_slug,
      type,
      regression_type: type,
      severity,
      delta,
    });
  }

  const previousIssues = new Set(previousRecord.unresolved_issue_codes ?? previousRecord.issue_codes ?? []);
  const currentIssueCodes = uniqueSorted(currentIssues.map(issueFingerprint));
  const newIssues = currentIssues
    .filter((issue) => !previousIssues.has(issueFingerprint(issue)))
    .map(normalizeIssue);

  if (newIssues.length > 0) {
    regressions.push({
      agent_slug: currentRecord.agent_slug,
      type: "new_unresolved_issues",
      regression_type: "new_unresolved_issues",
      severity: newIssues.some((issue) => issue.severity === "blocking")
        ? "high"
        : newIssues.some((issue) => issue.severity === "critical")
          ? "medium"
          : "low",
      delta: round(-newIssues.length),
      new_issues: newIssues,
    });
  }

  if (currentRecord.status !== "converged" && previousRecord.status === "converged") {
    regressions.push({
      agent_slug: currentRecord.agent_slug,
      type: "convergence_regression",
      regression_type: "convergence_regression",
      severity: currentRecord.status === "blocked" ? "high" : "medium",
      delta: round(currentRecord.overall_score - previousRecord.overall_score),
    });
  }

  return sortByKey(regressions, "type");
}

async function analyzeAgent(agent, history, policyEngine, runtimeFeedbackByAgent = {}) {
  const validation = getValidationScore(agent);
  const evaluation = getEvaluationScore(agent);
  const readiness = getReadinessScore(agent);
  const issues = [...validation.issues, ...evaluation.issues, ...readiness.issues].map(normalizeIssue);
  const overallScore = round(((validation.score + evaluation.score + readiness.score) / 3) * 100);
  const state = getStatusAndDecision(overallScore, issues, policyEngine);
  const runtimeFeedback = runtimeFeedbackByAgent[agent.slug] ?? null;
  const refinementTargets = buildRefinementTargets(agent, issues, runtimeFeedback, policyEngine);
  const unresolvedIssueCodes = uniqueSorted(
    issues
      .filter((issue) => issue.severity === "blocking" || issue.severity === "critical")
      .map(issueFingerprint),
  );
  const issueCodes = uniqueSorted(issues.map(issueFingerprint));

  const currentRecord = {
    agent_slug: agent.slug,
    validation_score: validation.score,
    evaluation_score: evaluation.score,
    readiness_score: readiness.score,
    overall_score: overallScore,
    status: state.status,
    issue_codes: issueCodes,
    unresolved_issue_codes: unresolvedIssueCodes,
  };
  const previousRecord = history.latest_by_agent?.[agent.slug] ?? null;
  const regressions = buildRegressions(previousRecord, currentRecord, policyEngine, issues);
  const schemaDiff = buildSchemaDiff(previousRecord, currentRecord);

  return {
    agent_slug: agent.slug,
    agent_name: agent.name,
    domain: agent.domain,
    package_path: agent.relativePackagePath,
    status: regressions.some((entry) => entry.severity === "high") ? "escalated" : state.status,
    convergence_state: regressions.some((entry) => entry.severity === "high")
      ? "route_to_human_or_adjacent_specialist"
      : state.convergence_state,
    validation,
    evaluation,
    readiness,
    aggregated_feedback: {
      validation_issues: validation.issues,
      evaluation_gaps: evaluation.issues,
      readiness_gaps: readiness.issues,
    },
    errors: issues.filter((issue) => issue.severity === "blocking" || issue.severity === "critical"),
    warnings: issues.filter((issue) => issue.severity === "advisory"),
    refinement_targets: refinementTargets,
    schema_diff: schemaDiff,
    regressions,
    issue_codes: issueCodes,
    unresolved_issue_codes: unresolvedIssueCodes,
    health: {
      validation: validation.score,
      evaluation: evaluation.score,
      readiness: readiness.score,
      overall: overallScore,
    },
    runtime_feedback: runtimeFeedback,
  };
}

function getRecentAgentRunHistory(history, agentSlug, limit = 5) {
  const entries = [];
  for (let index = history.runs.length - 1; index >= 0; index -= 1) {
    const run = history.runs[index];
    const agentRecord = (run.agent_results ?? []).find((entry) => entry.agent_slug === agentSlug);
    if (!agentRecord) {
      continue;
    }

    entries.push({
      generated_at: run.timestamp ?? run.generated_at ?? null,
      overall_score: round(agentRecord.overall_score ?? 0),
      optimization: agentRecord.optimization ?? null,
    });

    if (entries.length >= limit) {
      break;
    }
  }

  return entries;
}

function buildOptimizationCandidates(agentResult) {
  const candidates = [];
  const overallToPoints = (scoreDelta) => round((scoreDelta / 3) * 100);

  if (
    Number(agentResult.evaluation.metadata?.scenario_count ?? 0) > 0 &&
    Number(agentResult.evaluation.metadata?.scenario_count ?? 0) < 5
  ) {
    candidates.push({
      section: "evaluation",
      target: "Increase scenario coverage and strengthen acceptance evidence",
      reason: `Scenario count ${agentResult.evaluation.metadata.scenario_count} is below the preferred optimization floor.`,
      type: "optimization",
      source: "evaluation",
      potential_improvement: 1,
    });
  }

  if (agentResult.evaluation.score < 1) {
    candidates.push({
      section: "evaluation",
      target: "Improve evaluation pass rate and scenario quality",
      reason: `Evaluation score ${agentResult.evaluation.score} is below the optimization target.`,
      type: "optimization",
      source: "evaluation",
      potential_improvement: overallToPoints(1 - agentResult.evaluation.score),
    });
  }

  if (agentResult.readiness.score < 1) {
    candidates.push({
      section: "readiness",
      target: "Fill readiness evidence gaps and complete deployment checks",
      reason: `Readiness score ${agentResult.readiness.score} is below full completeness.`,
      type: "optimization",
      source: "readiness",
      potential_improvement: overallToPoints(1 - agentResult.readiness.score),
    });
  }

  if (agentResult.health.overall < 100 && candidates.length === 0) {
    candidates.push({
      section: "best-practices",
      target: "Tighten package alignment with catalog best-practice baselines",
      reason: "Agent is converged but still below the optimization target.",
      type: "optimization",
      source: "best-practices",
      potential_improvement: 1,
    });
  }

  return candidates.sort((left, right) => {
    if (right.potential_improvement !== left.potential_improvement) {
      return right.potential_improvement - left.potential_improvement;
    }
    return left.section.localeCompare(right.section);
  });
}

function classifyAgentLifecycleState(agentResult, generatedArtifactExists) {
  const isReadyForCodegen =
    agentResult.status === "converged" &&
    agentResult.errors.length === 0 &&
    agentResult.refinement_targets.length === 0;

  if (generatedArtifactExists) {
    return "implemented";
  }

  return isReadyForCodegen ? "ready_for_codegen" : "spec_only";
}

function detectAgentSource(agentSlug, codegenContext) {
  const branchHints = [codegenContext.current_branch, ...codegenContext.refs]
    .filter(Boolean)
    .filter((ref) => ref.includes(agentSlug));

  if (branchHints.some((ref) => /(^|\/)issue-\d+/i.test(ref))) {
    return "issue";
  }

  if (branchHints.some((ref) => /(^|\/)(pr|pull)-\d+/i.test(ref) || /pull\//i.test(ref))) {
    return "pull_request";
  }

  if (/^issue-\d+/i.test(codegenContext.current_branch) && codegenContext.changed_agents.includes(agentSlug)) {
    return "issue";
  }

  if (/^(pr|pull)-\d+/i.test(codegenContext.current_branch) && codegenContext.changed_agents.includes(agentSlug)) {
    return "pull_request";
  }

  return null;
}

function buildCodegenDecision(rootDir, agentResult, policyEngine, codegenContext, history) {
  const generatedArtifactPath = path.join(rootDir, defaultPaths.generatedAgents, `${agentResult.agent_slug}.mjs`);
  const generatedArtifactExists = fs.existsSync(generatedArtifactPath);
  const specHash = buildAgentSpecHash({
    packagePath: path.join(rootDir, agentResult.package_path),
  });
  const cachedEntry = history.learning?.codegen_cache?.[agentResult.agent_slug] ?? null;
  const initialState = classifyAgentLifecycleState(agentResult, generatedArtifactExists);
  const readyForCodegen = initialState === "ready_for_codegen" || generatedArtifactExists;
  const source = detectAgentSource(agentResult.agent_slug, codegenContext);
  const forceCodegen = source === "issue" || source === "pull_request";
  const codegenMode = String(policyEngine.codegen_mode ?? defaultPolicyEngine.codegen_mode);

  let generated = false;
  let codegenReason = "not_eligible";
  let cacheHit = false;
  let cacheReason = "not_eligible";
  if (codegenMode === "forced_and_ready") {
    if (forceCodegen) {
      generated = true;
      codegenReason = "test_platform_override";
    } else if (readyForCodegen) {
      generated = true;
      codegenReason = "ready_for_codegen";
    }
  } else if (codegenMode === "ready_only") {
    if (readyForCodegen) {
      generated = true;
      codegenReason = "ready_for_codegen";
    } else if (forceCodegen) {
      codegenReason = "test_platform_override";
    }
  } else if (forceCodegen) {
    codegenReason = "test_platform_override";
  }

  if (generated) {
    if (forceCodegen) {
      cacheReason = "forced";
    } else if (!generatedArtifactExists) {
      cacheReason = "missing_artifact";
    } else if (cachedEntry?.spec_hash === specHash) {
      generated = false;
      cacheHit = true;
      cacheReason = "unchanged_spec";
    } else {
      cacheReason = "spec_changed";
    }
  } else if (cachedEntry?.spec_hash === specHash && generatedArtifactExists) {
    cacheHit = true;
    cacheReason = "unchanged_spec";
  }

  const agentState = generated ? "implemented" : initialState;

  return {
    agent_state: agentState,
    force_codegen: forceCodegen,
    codegen_reason: codegenReason,
    generated,
    source,
    generated_artifact_path: generatedArtifactPath,
    spec_hash: specHash,
    codegen_cache: {
      hit: cacheHit,
      reason: cacheReason,
    },
  };
}

function renderGeneratedAgentModule(agentResult, codegenDecision, generatedAt) {
  return `// Generated artifact. Regenerate from the agent spec package; do not patch manually.
export default ${JSON.stringify(
    {
      generated_at: generatedAt,
      agent_slug: agentResult.agent_slug,
      agent_name: agentResult.agent_name,
      domain: agentResult.domain,
      package_path: agentResult.package_path,
      agent_state: codegenDecision.agent_state,
      force_codegen: codegenDecision.force_codegen,
      codegen_reason: codegenDecision.codegen_reason,
      source: codegenDecision.source,
      spec_hash: codegenDecision.spec_hash,
      codegen_cache: codegenDecision.codegen_cache,
      status: agentResult.status,
      convergence_state: agentResult.convergence_state,
      health: agentResult.health,
    },
    null,
    2,
  )};
`;
}

function classifyOptimizationRisk(agentResult, selectedTargets, projectedImprovement, policyEngine) {
  const allowedSections = new Set([
    "evaluation",
    "readiness",
    "evidence",
    "marketing-readiness",
    "best-practices",
  ]);
  const sections = uniqueSorted(selectedTargets.map((target) => target.section));
  const reasons = [];

  if (agentResult.errors.length > 0) {
    reasons.push("blocking_validation_issues_present");
  }

  if (agentResult.errors.some((issue) => issue.code.includes("ambigu"))) {
    reasons.push("ambiguity_present");
  }

  if (selectedTargets.length === 0) {
    reasons.push("no_optimization_targets");
  }

  if (sections.some((section) => !allowedSections.has(section))) {
    reasons.push("disallowed_section");
  }

  if (sections.length > 1) {
    reasons.push("multiple_coupled_targets_required");
  }

  if (selectedTargets.length > Number(policyEngine.max_low_risk_targets_per_agent)) {
    reasons.push("target_limit_exceeded");
  }

  if (projectedImprovement > Number(policyEngine.max_expected_improvement_for_low_risk)) {
    reasons.push("expected_improvement_exceeds_low_risk_bound");
  }

  let classification = "low_risk";
  if (
    reasons.includes("blocking_validation_issues_present") ||
    reasons.includes("ambiguity_present") ||
    reasons.includes("disallowed_section")
  ) {
    classification = "disallowed";
  } else if (
    reasons.includes("multiple_coupled_targets_required") ||
    reasons.includes("target_limit_exceeded") ||
    reasons.includes("expected_improvement_exceeds_low_risk_bound") ||
    reasons.includes("no_optimization_targets")
  ) {
    classification = "standard";
  }

  return {
    classification,
    reasons,
  };
}

function buildLowRiskScope(selectedTargets) {
  return {
    agent_count: selectedTargets.length > 0 ? 1 : 0,
    target_count: selectedTargets.length,
    sections: uniqueSorted(selectedTargets.map((target) => target.section)),
  };
}

function countLowGainOptimizationRuns(recentOptimizationAttempts) {
  let count = 0;
  for (const attempt of recentOptimizationAttempts) {
    if (Number(attempt.optimization?.improvement ?? 0) >= 1) {
      break;
    }
    count += 1;
  }
  return count;
}

function countRecentAppliedOptimizations(history, agentSlug, limit = 2) {
  return getRecentAgentRunHistory(history, agentSlug, limit).filter((entry) => entry.optimization?.applied).length;
}

function buildOptimizationIssueKey(plan) {
  const sections = uniqueSorted((plan.optimization_targets ?? []).map((target) => target.section));
  return sections.length > 0 ? sections.join("|") : "none";
}

function buildOptimizationPriorityScore(plan, issueFrequency, agentImpactWeight = 1) {
  return round(
    Number(plan.improvement ?? 0) * 0.5 +
      Number(issueFrequency ?? 0) * 0.2 +
      Number(agentImpactWeight ?? 1) * 0.2 +
      Number(plan.confidence_score ?? 0) * 0.1,
    3,
  );
}

function getAgentHealthDelta(history, agentSlug, currentOverallScore) {
  const previousOverall = history.latest_by_agent?.[agentSlug]?.overall_score;
  if (previousOverall === undefined || previousOverall === null) {
    return 0;
  }

  return round(Number(currentOverallScore ?? 0) - Number(previousOverall ?? 0));
}

function buildOptimizationBudget(agentResults, history, policyEngine) {
  const minBudget = Number(policyEngine.min_budget ?? defaultPolicyEngine.min_budget);
  const adaptiveBudgetFloor = Number(
    policyEngine.adaptive_budget_floor ?? defaultPolicyEngine.adaptive_budget_floor,
  );
  const budgetFloor = Math.max(minBudget, adaptiveBudgetFloor);
  const baseBudget = clamp(
    Number(policyEngine.base_budget ?? defaultPolicyEngine.base_budget),
    budgetFloor,
    Number(policyEngine.max_budget ?? defaultPolicyEngine.max_budget),
  );
  const maxBudget = Number(policyEngine.max_budget ?? defaultPolicyEngine.max_budget);
  const regressionCount = agentResults.reduce((total, result) => total + result.regressions.length, 0);
  const currentHealth = buildHealthSummary(agentResults).catalog_health;
  const previousHealth = Number(history.latest_catalog?.catalog_health ?? currentHealth);
  const healthDelta = round(currentHealth - previousHealth);
  let computedBudget = baseBudget;
  let optimizationEnabled = true;
  let mode = "normal";
  let reason = "base_budget";

  if (healthDelta > 1) {
    computedBudget = Math.min(maxBudget, baseBudget + 5);
    reason = "health_improving";
  } else if (healthDelta < -1) {
    computedBudget = Math.max(budgetFloor, Math.floor(baseBudget / 2));
    reason = "health_degrading";
  }

  if (regressionCount >= Number(policyEngine.regression_soft_limit ?? defaultPolicyEngine.regression_soft_limit)) {
    computedBudget = Math.max(budgetFloor, Math.floor(computedBudget / 2));
    reason = "regression_soft_limit";
  }

  if (regressionCount >= Number(policyEngine.regression_hard_limit ?? defaultPolicyEngine.regression_hard_limit)) {
    mode = "repair_priority";
    computedBudget = budgetFloor;
    reason = "regression_hard_limit";
  }

  const applyCap = Number(
    policyEngine.max_low_risk_applies_per_run ?? defaultPolicyEngine.max_low_risk_applies_per_run,
  );
  const minAppliesPerRun = Number(
    policyEngine.min_applies_per_run ?? defaultPolicyEngine.min_applies_per_run,
  );
  const budgetAfter = optimizationEnabled
    ? Math.max(minAppliesPerRun, Math.min(applyCap, Math.max(budgetFloor, computedBudget)))
    : 0;

  return {
    optimization_enabled: optimizationEnabled,
    mode,
    regression_count: regressionCount,
    health_delta: healthDelta,
    base_budget: baseBudget,
    budget_before: baseBudget,
    budget_after: budgetAfter,
    effective_budget: budgetAfter,
    apply_cap: applyCap,
    min_applies_per_run: minAppliesPerRun,
    adaptive_budget_floor: budgetFloor,
    reason,
    throttling_state: {
      reason,
      budget_before: baseBudget,
      budget_after: budgetAfter,
      oscillation_scope: "per_agent",
    },
  };
}

function withDeferredOptimization(plan, updates = {}) {
  return {
    ...plan,
    applied: false,
    safe_to_apply: false,
    apply_action: "assisted_mode_output_only",
    deferred: true,
    filtered_out: false,
    selected_for_apply: false,
    ...updates,
  };
}

function withSuppressedOptimization(plan, updates = {}) {
  return {
    ...plan,
    applied: false,
    safe_to_apply: false,
    apply_action: "assisted_mode_output_only",
    optimization_suppressed: true,
    suppression_reason: "oscillation_guard",
    selected_for_apply: false,
    deferred: false,
    ...updates,
  };
}

function buildOptimizationPlan(agentResult, history, policyEngine, mode) {
  const optimizationEnabled = Boolean(policyEngine.optimization_enabled);
  const target = Number(policyEngine.optimization_target);
  const maxIterations = Number(policyEngine.max_optimization_iterations);
  const minImprovement = Number(policyEngine.min_improvement_threshold);
  const confidenceScore = round(agentResult.health.overall / 100);
  const recentHistory = getRecentAgentRunHistory(history, agentResult.agent_slug, 3);
  const recentOptimizationAttempts = recentHistory.filter((entry) => entry.optimization?.triggered);
  const lowGainRuns = countLowGainOptimizationRuns(recentOptimizationAttempts);
  const recentHealthDelta =
    recentHistory.length >= 2 ? round(recentHistory[0].overall_score - recentHistory[1].overall_score) : null;
  const oscillationLowGainLimit = Number(
    policyEngine.oscillation_low_gain_limit ?? defaultPolicyEngine.oscillation_low_gain_limit,
  );

  const baseResult = {
    triggered: false,
    iterations: 0,
    improvement: 0,
    stopped_reason: optimizationEnabled ? "not_needed" : "disabled",
    optimization_targets: [],
    type: "standard",
    risk_classification: "disallowed",
    optimization_risk: {
      classification: "disallowed",
      reasons: optimizationEnabled ? ["not_triggered"] : ["optimization_disabled"],
    },
    confidence_score: confidenceScore,
    projected_health: agentResult.health.overall,
    low_risk_scope: {
      agent_count: 0,
      target_count: 0,
      sections: [],
    },
    rollback_ready: false,
    rollback_basis: null,
    safe_to_apply: false,
    low_risk_eligible: false,
    applied: false,
    rolled_back: false,
    optimization_suppressed: false,
    suppression_reason: null,
    apply_action: "assisted_mode_output_only",
    priority_score: 0,
    projected_improvement: 0,
    issue_frequency: 0,
    selected_for_apply: false,
    deferred: false,
    filtered_out: false,
    filter_reason: null,
    low_gain_runs: lowGainRuns,
    eligible_for_oscillation_suppression: false,
  };

  if (!optimizationEnabled) {
    return baseResult;
  }

  const noBlockingIssues = agentResult.errors.length === 0;
  const noAmbiguity = agentResult.errors.every((issue) => !issue.code.includes("ambigu"));
  const converged = agentResult.status === "converged";
  const noRegressions = agentResult.regressions.length === 0;

  if (!noBlockingIssues || !noAmbiguity || !converged || !noRegressions || agentResult.health.overall >= target) {
    return baseResult;
  }

  const candidates = buildOptimizationCandidates(agentResult);
  if (candidates.length === 0) {
    return {
      ...baseResult,
      stopped_reason: "no_gain",
    };
  }

  const selected = [];
  let projectedHealth = agentResult.health.overall;
  let stoppedReason = "limit";

  for (let iteration = 0; iteration < Math.min(maxIterations, candidates.length); iteration += 1) {
    const candidate = candidates[iteration];
    if (candidate.potential_improvement < minImprovement) {
      stoppedReason = "no_gain";
      break;
    }

    selected.push({
      section: candidate.section,
      target: candidate.target,
      reason: candidate.reason,
      source: candidate.source,
      type: candidate.type,
    });
    projectedHealth = round(Math.min(target, projectedHealth + candidate.potential_improvement));

    if (projectedHealth >= target) {
      stoppedReason = "threshold";
      break;
    }
  }

  const improvement = round(projectedHealth - agentResult.health.overall);
  if (selected.length === 0) {
    return {
      ...baseResult,
      stopped_reason: stoppedReason,
    };
  }

  const lowRiskScope = buildLowRiskScope(selected);
  const optimizationRisk = classifyOptimizationRisk(agentResult, selected, improvement, policyEngine);
  const optimizationType =
    optimizationRisk.classification === "low_risk" ? "low_risk" : "standard";
  const rollbackReady =
    optimizationRisk.classification === "low_risk" &&
    lowRiskScope.agent_count === 1 &&
    lowRiskScope.target_count > 0;
  const lowRiskEligible =
    Boolean(policyEngine.low_risk_optimization_enabled) &&
    optimizationRisk.classification === "low_risk" &&
    agentResult.status === "converged" &&
    agentResult.errors.length === 0 &&
    agentResult.regressions.length === 0 &&
    agentResult.errors.every((issue) => !issue.code.includes("ambigu")) &&
    agentResult.health.overall < target &&
    lowRiskScope.agent_count === 1 &&
    lowRiskScope.target_count > 0 &&
    lowRiskScope.target_count <= Number(policyEngine.max_low_risk_targets_per_agent) &&
    !agentResult.errors.some((issue) => issue.source === "readiness") &&
    !agentResult.warnings.some((issue) => issue.source === "readiness" && issue.severity === "critical") &&
    lowGainRuns < 2;
  const fullThreshold = Number(policyEngine.full_autonomous_confidence_threshold);
  const lowRiskThreshold = Number(policyEngine.low_risk_confidence_threshold);
  const fullAutonomousSafe =
    mode === "autonomous" &&
    confidenceScore >= fullThreshold &&
    optimizationRisk.classification === "low_risk" &&
    lowRiskScope.target_count === 1 &&
    improvement >= minImprovement;
  const lowRiskConfidenceEligible =
    mode === "autonomous" &&
    confidenceScore >= lowRiskThreshold &&
    confidenceScore < fullThreshold &&
    lowRiskEligible;

  let applied = false;
  let rolledBack = false;
  const eligibleForOscillationSuppression =
    lowGainRuns >= oscillationLowGainLimit && recentHealthDelta !== null && Math.abs(recentHealthDelta) <= 1;
  if (improvement < minImprovement) {
    stoppedReason = "no_gain";
  }
  let applyAction = "assisted_mode_output_only";

  if (optimizationRisk.classification === "disallowed") {
    stoppedReason = "disallowed";
  } else if (optimizationRisk.classification === "standard") {
    applyAction = "assisted_mode_output_only";
  } else if (mode !== "autonomous") {
    applyAction = "assisted_mode_output_only";
  } else if (confidenceScore < lowRiskThreshold) {
    stoppedReason = "confidence";
  } else if (!rollbackReady) {
    stoppedReason = "disallowed";
  } else if (fullAutonomousSafe || lowRiskConfidenceEligible) {
    const validationErrorsAfterApply = agentResult.errors.length;
    const regressionsAfterApply = agentResult.regressions.length;
    const healthDelta = improvement;
    const keepChange =
      validationErrorsAfterApply === 0 &&
      regressionsAfterApply === 0 &&
      healthDelta >= minImprovement;

    if (keepChange) {
      applied = true;
      applyAction = fullAutonomousSafe ? "auto_apply_allowed" : "low_risk_auto_apply_allowed";
      stoppedReason = "completed";
    } else {
      rolledBack = true;
      applyAction = "assisted_mode_output_only";
      stoppedReason = regressionsAfterApply > 0 ? "regression" : "no_gain";
    }
  }

  return {
    triggered: true,
    iterations: selected.length,
    improvement,
    stopped_reason: stoppedReason,
    optimization_targets: selected,
    type: optimizationType,
    risk_classification: optimizationRisk.classification,
    optimization_risk: optimizationRisk,
    confidence_score: confidenceScore,
    projected_health: projectedHealth,
    low_risk_scope: lowRiskScope,
    rollback_ready: rollbackReady,
    rollback_basis: rollbackReady ? "prior_artifact_state" : null,
    safe_to_apply: applied,
    low_risk_eligible: lowRiskEligible,
    applied,
    rolled_back: rolledBack,
    optimization_suppressed: false,
    suppression_reason: null,
    apply_action: applyAction,
    priority_score: 0,
    projected_improvement: improvement,
    issue_frequency: 0,
    selected_for_apply: false,
    deferred: false,
    filtered_out: false,
    filter_reason: null,
    low_gain_runs: lowGainRuns,
    eligible_for_oscillation_suppression: eligibleForOscillationSuppression,
  };
}

function buildOptimizationSummary(agentResults, history, policyEngine, mode) {
  const minProjectedImprovement = Number(
    policyEngine.min_projected_improvement ?? defaultPolicyEngine.min_projected_improvement,
  );
  const maxOptimizationsPerAgentPerRun = Number(
    policyEngine.max_optimizations_per_agent_per_run ?? defaultPolicyEngine.max_optimizations_per_agent_per_run,
  );
  const cooldownRuns = Number(policyEngine.cooldown_runs ?? defaultPolicyEngine.cooldown_runs);
  const oscillationTtlRuns = Number(
    policyEngine.oscillation_ttl_runs ?? defaultPolicyEngine.oscillation_ttl_runs,
  );
  const maxRecoveredAgentsPerRun = Number(
    policyEngine.max_recovered_agents_per_run ?? defaultPolicyEngine.max_recovered_agents_per_run,
  );
  const budgetState = buildOptimizationBudget(agentResults, history, policyEngine);
  const rawPerAgent = agentResults.map((result) => ({
    agent_slug: result.agent_slug,
    optimization: buildOptimizationPlan(result, history, policyEngine, mode),
  }));
  const candidateEntries = rawPerAgent.filter(
    (entry) =>
      entry.optimization.triggered &&
      entry.optimization.risk_classification === "low_risk",
  );
  const issueFrequencyByKey = new Map();
  for (const entry of candidateEntries) {
    const issueKey = buildOptimizationIssueKey(entry.optimization);
    issueFrequencyByKey.set(issueKey, Number(issueFrequencyByKey.get(issueKey) ?? 0) + 1);
  }

  const filteredOut = new Map();
  const deferred = new Map();
  const scoredCandidates = [];
  for (const entry of candidateEntries) {
    const issueKey = buildOptimizationIssueKey(entry.optimization);
    const issueFrequency = Number(issueFrequencyByKey.get(issueKey) ?? 0);
    const priorityScore = buildOptimizationPriorityScore(entry.optimization, issueFrequency, 1);
    const optimization = {
      ...entry.optimization,
      issue_frequency: issueFrequency,
      priority_score: priorityScore,
    };

    if (Number(optimization.improvement ?? 0) < minProjectedImprovement) {
      filteredOut.set(
        entry.agent_slug,
        {
          ...optimization,
          stopped_reason: "below_value_threshold",
          filtered_out: true,
          filter_reason: "projected_improvement_below_threshold",
          applied: false,
          safe_to_apply: false,
          rolled_back: false,
          apply_action: "assisted_mode_output_only",
        },
      );
      continue;
    }

    const recentAppliedCount = countRecentAppliedOptimizations(history, entry.agent_slug, cooldownRuns);
    if (
      recentAppliedCount >= maxOptimizationsPerAgentPerRun &&
      Number(optimization.improvement ?? 0) < 5
    ) {
      deferred.set(
        entry.agent_slug,
        withDeferredOptimization(optimization, {
          stopped_reason: "cooldown",
          filter_reason: "cooldown_guard",
        }),
      );
      continue;
    }

    scoredCandidates.push({
      agent_slug: entry.agent_slug,
      optimization,
      issue_key: issueKey,
    });
  }

  if (candidateEntries.length > 0 && filteredOut.size === candidateEntries.length) {
    const rescuedEntries = [...filteredOut.entries()]
      .map(([agentSlug, optimization]) => ({
        agent_slug: agentSlug,
        optimization: {
          ...optimization,
          filtered_out: false,
          filter_reason: null,
          stopped_reason: "rescued_by_filter_safety_valve",
        },
      }))
      .sort((left, right) => {
        if (right.optimization.improvement !== left.optimization.improvement) {
          return right.optimization.improvement - left.optimization.improvement;
        }
        return left.agent_slug.localeCompare(right.agent_slug);
      })
      .slice(0, 5);

    for (const rescued of rescuedEntries) {
      filteredOut.delete(rescued.agent_slug);
      scoredCandidates.push({
        agent_slug: rescued.agent_slug,
        optimization: rescued.optimization,
        issue_key: buildOptimizationIssueKey(rescued.optimization),
      });
    }
  }

  scoredCandidates.sort((left, right) => {
    if (right.optimization.priority_score !== left.optimization.priority_score) {
      return right.optimization.priority_score - left.optimization.priority_score;
    }
    if (right.optimization.improvement !== left.optimization.improvement) {
      return right.optimization.improvement - left.optimization.improvement;
    }
    return left.agent_slug.localeCompare(right.agent_slug);
  });

  const currentRunNumber = history.runs.length + 1;
  const agentResultBySlug = new Map(agentResults.map((result) => [result.agent_slug, result]));
  const storedOscillationState = new Map(
    Object.entries(history.learning?.oscillation_state ?? {}).map(([agentSlug, state]) => [agentSlug, state]),
  );
  const ttlEligible = [];
  const recoveredImmediate = new Set();
  const nextOscillationState = new Map();

  for (const [agentSlug, state] of storedOscillationState.entries()) {
    const agentResult = agentResultBySlug.get(agentSlug);
    const healthDelta = agentResult ? getAgentHealthDelta(history, agentSlug, agentResult.health.overall) : 0;
    if (healthDelta >= 1) {
      recoveredImmediate.add(agentSlug);
      continue;
    }

    if (currentRunNumber - Number(state.suppressed_at_run ?? 0) >= oscillationTtlRuns) {
      ttlEligible.push({
        agent_slug: agentSlug,
        suppressed_at_run: Number(state.suppressed_at_run ?? 0),
        priority_score: Number(
          scoredCandidates.find((entry) => entry.agent_slug === agentSlug)?.optimization.priority_score ?? 0,
        ),
      });
      continue;
    }

    nextOscillationState.set(agentSlug, {
      agent_slug: agentSlug,
      suppressed_at_run: Number(state.suppressed_at_run ?? 0),
    });
  }

  ttlEligible.sort((left, right) => {
    if (right.priority_score !== left.priority_score) {
      return right.priority_score - left.priority_score;
    }
    return left.agent_slug.localeCompare(right.agent_slug);
  });

  const recoveredFromTtl = new Set(
    ttlEligible.slice(0, maxRecoveredAgentsPerRun).map((entry) => entry.agent_slug),
  );
  for (const entry of ttlEligible.slice(maxRecoveredAgentsPerRun)) {
    nextOscillationState.set(entry.agent_slug, {
      agent_slug: entry.agent_slug,
      suppressed_at_run: entry.suppressed_at_run,
    });
  }

  for (const entry of rawPerAgent) {
    if (!entry.optimization.eligible_for_oscillation_suppression) {
      continue;
    }
    if (recoveredImmediate.has(entry.agent_slug) || recoveredFromTtl.has(entry.agent_slug)) {
      continue;
    }
    nextOscillationState.set(entry.agent_slug, {
      agent_slug: entry.agent_slug,
      suppressed_at_run: currentRunNumber,
    });
  }

  const activeSuppressedSlugs = new Set(nextOscillationState.keys());

  const selectedAgentSlugs = new Set(
    scoredCandidates
      .filter((entry) => !activeSuppressedSlugs.has(entry.agent_slug))
      .slice(0, Math.max(budgetState.min_applies_per_run, budgetState.effective_budget))
      .map((entry) => entry.agent_slug),
  );

  for (const entry of scoredCandidates) {
    if (selectedAgentSlugs.has(entry.agent_slug) || activeSuppressedSlugs.has(entry.agent_slug)) {
      continue;
    }
    deferred.set(
      entry.agent_slug,
      withDeferredOptimization(entry.optimization, {
        stopped_reason: budgetState.optimization_enabled ? "deferred_by_throttle" : "repair_only",
        filter_reason: budgetState.optimization_enabled ? "optimization_throttle" : "repair_only",
      }),
    );
  }

  const perAgent = sortByKey(
    rawPerAgent.map((entry) => {
      const issueKey = buildOptimizationIssueKey(entry.optimization);
      const issueFrequency = Number(issueFrequencyByKey.get(issueKey) ?? 0);
      const priorityScore = buildOptimizationPriorityScore(entry.optimization, issueFrequency, 1);

      if (activeSuppressedSlugs.has(entry.agent_slug)) {
        return {
          ...entry,
          optimization: withSuppressedOptimization(
            {
              ...entry.optimization,
              issue_frequency: issueFrequency,
              priority_score: priorityScore,
            },
            {
              stopped_reason: "oscillation_guard",
              suppression_reason: "oscillation_guard",
            },
          ),
        };
      }

      if (filteredOut.has(entry.agent_slug)) {
        return {
          ...entry,
          optimization: filteredOut.get(entry.agent_slug),
        };
      }

      if (deferred.has(entry.agent_slug)) {
        return {
          ...entry,
          optimization: deferred.get(entry.agent_slug),
        };
      }

      if (!selectedAgentSlugs.has(entry.agent_slug)) {
        return entry;
      }

      let optimization = {
        ...entry.optimization,
        issue_frequency: issueFrequency,
        priority_score: priorityScore,
        selected_for_apply: true,
      };

      if (!budgetState.optimization_enabled) {
        optimization = withDeferredOptimization(optimization, {
          stopped_reason: "repair_only",
          filter_reason: "repair_only",
        });
      }

      return {
        ...entry,
        optimization,
      };
    }),
    "agent_slug",
  );

  const triggered = perAgent.filter((entry) => entry.optimization.triggered);
  const stableSkipped = perAgent.filter((entry) => entry.optimization.stopped_reason === "stable").length;
  const lowRiskApplied = perAgent.filter(
    (entry) => entry.optimization.applied && entry.optimization.risk_classification === "low_risk",
  ).length;
  const assistedOnly = perAgent.filter(
    (entry) => entry.optimization.triggered && !entry.optimization.applied && !entry.optimization.rolled_back,
  ).length;
  const rolledBack = perAgent.filter((entry) => entry.optimization.rolled_back).length;
  const suppressed = perAgent.filter((entry) => entry.optimization.optimization_suppressed).length;
  const deferredQueue = scoredCandidates
    .filter((entry) => !selectedAgentSlugs.has(entry.agent_slug))
    .map((entry) => ({
      agent_slug: entry.agent_slug,
      priority_score: entry.optimization.priority_score,
      projected_improvement: entry.optimization.improvement,
    }));
  for (const [agentSlug, optimization] of deferred.entries()) {
    if (deferredQueue.some((entry) => entry.agent_slug === agentSlug)) {
      continue;
    }
    deferredQueue.push({
      agent_slug: agentSlug,
      priority_score: Number(optimization.priority_score ?? 0),
      projected_improvement: Number(optimization.improvement ?? 0),
    });
  }
  deferredQueue.sort((left, right) => {
    if (right.priority_score !== left.priority_score) {
      return right.priority_score - left.priority_score;
    }
    return left.agent_slug.localeCompare(right.agent_slug);
  });
  const avgImprovement =
    triggered.length === 0
      ? 0
      : round(
          triggered.reduce((total, entry) => total + entry.optimization.improvement, 0) / triggered.length,
        );
  const uniqueStoppedReasons = uniqueSorted(triggered.map((entry) => entry.optimization.stopped_reason));

  return {
    triggered: triggered.length > 0,
    iterations: triggered.reduce((total, entry) => total + entry.optimization.iterations, 0),
    improvement: avgImprovement,
    stopped_reason:
      triggered.length === 0
        ? "not_needed"
        : uniqueStoppedReasons.length === 1
          ? uniqueStoppedReasons[0]
          : "mixed",
    agents_optimized: triggered.length,
    avg_improvement: avgImprovement,
    skipped_stable: stableSkipped,
    low_risk_applied: lowRiskApplied,
    assisted_only: assistedOnly,
    rolled_back: rolledBack,
    suppressed,
    optimization_throttled: scoredCandidates.length > budgetState.effective_budget,
    candidates_total: candidateEntries.length,
    candidates_applied: lowRiskApplied,
    candidates_deferred: deferredQueue.length,
    deferred_optimizations: deferredQueue,
    optimization_control: {
      applied: lowRiskApplied,
      deferred: deferredQueue.length,
      filtered_out: filteredOut.size,
      throttled: scoredCandidates.length > budgetState.effective_budget,
      budget_used: lowRiskApplied,
      budget_remaining: Math.max(0, budgetState.effective_budget - lowRiskApplied),
      candidates_total: candidateEntries.length,
      effective_budget: budgetState.effective_budget,
      mode: budgetState.mode,
      optimization_enabled: budgetState.optimization_enabled,
      reason: budgetState.reason,
      throttling_state: budgetState.throttling_state,
    },
    throttling_state: budgetState.throttling_state,
    oscillation_control: {
      suppressed_active: activeSuppressedSlugs.size,
      recovered_this_run: recoveredImmediate.size + recoveredFromTtl.size,
      expired: ttlEligible.length,
    },
    oscillation_state: Object.fromEntries(nextOscillationState.entries()),
    per_agent: perAgent,
  };
}

async function runWithParallelism(values, parallelism, worker) {
  const concurrency = Math.max(1, Number(parallelism) || 1);
  const results = new Array(values.length);
  let index = 0;

  async function runWorker() {
    while (index < values.length) {
      const current = index;
      index += 1;
      results[current] = await worker(values[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()));
  return results;
}

function regressionsFromHistoryRun(run) {
  return Array.isArray(run?.regressions)
    ? run.regressions
    : Array.isArray(run?.regressions_detected)
      ? run.regressions_detected
      : [];
}

export function detectImprovementTrigger(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const policyEngine = {
    ...defaultPolicyEngine,
    ...(options.policyEngine ?? {}),
  };
  const history = options.history ? normalizeHistory(options.history) : loadImprovementHistory(options.historyPath ?? path.join(rootDir, defaultPaths.history));
  const allAgents = options.allAgents ?? discoverCatalogAgents(rootDir);
  const explicitAgents = parseDelimitedList(options.agents);
  const changedAgents = detectChangedAgentSlugs(rootDir);
  const lastRun = history.runs.at(-1) ?? null;
  const regressionCount = regressionsFromHistoryRun(lastRun).length;
  const regressedAgents = uniqueSorted(regressionsFromHistoryRun(lastRun).map((entry) => entry.agent_slug));
  const healthDelta = round(
    lastRun?.health_trend?.delta ??
      lastRun?.health_summary?.delta ??
      history.latest_catalog?.delta ??
      0,
  );
  const previousPriorityWeights = {
    ...defaultPriorityWeights,
    ...(history.learning?.priority_weights ?? history.latest_catalog?.priority_weights ?? {}),
  };

  if (options.force) {
    return {
      trigger_type: "manual",
      scope: explicitAgents.length > 0 ? "targeted" : options.domain ? "domain" : "full_catalog",
      reason: "Manual force override requested.",
      agents: explicitAgents,
      priority_weights: previousPriorityWeights,
      changed_agents_count: changedAgents.length,
      regression_count: regressionCount,
      health_delta: healthDelta,
      should_execute: true,
      threshold_state: "allowed",
    };
  }

  if (explicitAgents.length > 0) {
    return {
      trigger_type: "manual",
      scope: "targeted",
      reason: "Manual targeted run requested.",
      agents: explicitAgents,
      priority_weights: previousPriorityWeights,
      changed_agents_count: changedAgents.length,
      regression_count: regressionCount,
      health_delta: healthDelta,
      should_execute: true,
      threshold_state: "allowed",
    };
  }

  if (options.domain) {
    return {
      trigger_type: "manual",
      scope: "domain",
      reason: `Manual domain run requested for ${options.domain}.`,
      agents: [],
      domain: options.domain,
      priority_weights: previousPriorityWeights,
      changed_agents_count: changedAgents.length,
      regression_count: regressionCount,
      health_delta: healthDelta,
      should_execute: true,
      threshold_state: "allowed",
    };
  }

  const triggerValue = String(options.trigger ?? "").toLowerCase();
  if (triggerValue === "schedule" || triggerValue === "scheduled") {
    return {
      trigger_type: "schedule",
      scope: "full_catalog",
      reason: "Scheduled catalog improvement run.",
      agents: allAgents.map((agent) => agent.slug),
      priority_weights: previousPriorityWeights,
      changed_agents_count: changedAgents.length,
      regression_count: regressionCount,
      health_delta: healthDelta,
      should_execute: true,
      threshold_state: "allowed",
    };
  }

  if (changedAgents.length > 0) {
    if (changedAgents.length > 50) {
      return {
        trigger_type: "git",
        scope: "targeted",
        reason: `Detected ${changedAgents.length} changed agents; deferring noisy auto-run to the scheduled full scan.`,
        agents: changedAgents,
        priority_weights: previousPriorityWeights,
        changed_agents_count: changedAgents.length,
        regression_count: regressionCount,
        health_delta: healthDelta,
        should_execute: false,
        threshold_state: "deferred_to_schedule",
      };
    }

    return {
      trigger_type: "git",
      scope: "targeted",
      reason: "Detected changes under catalog/.",
      agents: changedAgents,
      priority_weights: previousPriorityWeights,
      changed_agents_count: changedAgents.length,
      regression_count: regressionCount,
      health_delta: healthDelta,
      should_execute: true,
      threshold_state: "allowed",
    };
  }

  if (regressedAgents.length > 0) {
    return {
      trigger_type: "regression",
      scope: regressionCount >= 5 ? "full_catalog" : "targeted",
      reason:
        regressionCount >= 5
          ? `Last run detected ${regressionCount} regressions; escalating to a full catalog repair run.`
          : "Last run detected regressions requiring targeted repair.",
      agents: regressionCount >= 5 ? allAgents.map((agent) => agent.slug) : regressedAgents,
      priority_weights: previousPriorityWeights,
      changed_agents_count: changedAgents.length,
      regression_count: regressionCount,
      health_delta: healthDelta,
      should_execute: true,
      threshold_state: regressionCount >= 5 ? "escalated" : "allowed",
    };
  }

  if (healthDelta <= Number(policyEngine.health_delta_trigger_threshold)) {
    return {
      trigger_type: "health_degradation",
      scope: "full_catalog",
      reason:
        healthDelta <= Number(policyEngine.health_degradation_threshold)
          ? `Catalog health dropped by ${healthDelta}; escalating to a full recovery run.`
          : `Catalog health dropped by ${healthDelta}; triggering a full repair run.`,
      agents: allAgents.map((agent) => agent.slug),
      priority_weights: previousPriorityWeights,
      changed_agents_count: changedAgents.length,
      regression_count: regressionCount,
      health_delta: healthDelta,
      should_execute: true,
      threshold_state:
        healthDelta <= Number(policyEngine.health_degradation_threshold) ? "escalated" : "allowed",
    };
  }

  return {
    trigger_type: "manual",
    scope: "full_catalog",
    reason: "No auto-trigger signal matched; running full catalog scan.",
    agents: allAgents.map((agent) => agent.slug),
    priority_weights: previousPriorityWeights,
    changed_agents_count: changedAgents.length,
    regression_count: regressionCount,
    health_delta: healthDelta,
    should_execute: true,
    threshold_state: "allowed",
  };
}

function resolveSelectedAgents(allAgents, triggerDecision, options) {
  if (triggerDecision.scope === "domain") {
    return allAgents.filter((agent) => agent.domain === options.domain);
  }

  if (triggerDecision.scope === "targeted") {
    const selected = new Set(triggerDecision.agents ?? []);
    return allAgents.filter((agent) => selected.has(agent.slug));
  }

  return allAgents;
}

function sourceFromRegressionType(type) {
  if (type.startsWith("evaluation_")) {
    return "evaluation";
  }

  if (type.startsWith("readiness_")) {
    return "readiness";
  }

  return "validation";
}

function buildGlobalPriorities(agentResults, priorityWeights = defaultPriorityWeights) {
  const grouped = new Map();

  for (const result of agentResults) {
    for (const issue of [...result.errors, ...result.warnings]) {
      const fingerprint = issueFingerprint(issue);
      const entry = grouped.get(fingerprint) ?? {
        code: issue.code,
        source: issue.source,
        severity: issue.severity,
        message: issue.message,
        agent_slugs: [],
      };
      entry.agent_slugs.push(result.agent_slug);
      if ((ISSUE_SEVERITY_WEIGHT[issue.severity] ?? 0) > (ISSUE_SEVERITY_WEIGHT[entry.severity] ?? 0)) {
        entry.severity = issue.severity;
      }
      grouped.set(fingerprint, entry);
    }
  }

  return [...grouped.values()]
    .map((entry) => {
      const sourceWeight = Number(priorityWeights[entry.source] ?? 1);
      const severityWeight = Number(ISSUE_SEVERITY_WEIGHT[entry.severity] ?? 1);
      const impactScore = round(entry.agent_slugs.length * severityWeight * sourceWeight);
      if (entry.severity === "advisory" && entry.agent_slugs.length < 2) {
        return null;
      }

      let priority = "P2";
      if (entry.agent_slugs.length >= 5) {
        priority = "P0";
      } else if (entry.agent_slugs.length >= 3 && severityWeight >= 2) {
        priority = "P0";
      } else if (severityWeight >= 2 || impactScore >= 3) {
        priority = "P1";
      }

      return {
        ...entry,
        agent_slugs: uniqueSorted(entry.agent_slugs),
        priority,
        impact_score: impactScore,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftPriority = PRIORITY_ORDER[left.priority] ?? 3;
      const rightPriority = PRIORITY_ORDER[right.priority] ?? 3;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      if (right.impact_score !== left.impact_score) {
        return right.impact_score - left.impact_score;
      }

      if (right.agent_slugs.length !== left.agent_slugs.length) {
        return right.agent_slugs.length - left.agent_slugs.length;
      }

      return left.code.localeCompare(right.code);
    });
}

function severityWeightForTarget(target) {
  return ISSUE_SEVERITY_WEIGHT[target.severity] ?? (target.source === "runtime" ? 2 : 1);
}

function crossSectionImpactForTarget(target) {
  if (target.source === "runtime") {
    return 3;
  }

  if (target.section === "manifest" || target.section === "actions" || target.section === "flows") {
    return 3;
  }

  if (target.section === "evaluation" || target.section === "readiness" || target.section === "interfaces") {
    return 2;
  }

  return 1;
}

function buildRefinementTargetKey(target) {
  return stableStringify({
    section: target.section,
    target: target.target,
    source: target.source,
    issue_code: target.issue_code ?? null,
    runtime_source: target.runtime_source ?? null,
  });
}

function buildConvergenceControl(history, agentResults, policyEngine) {
  const maxIterations = Number(
    policyEngine.max_spec_refinement_iterations ?? defaultPolicyEngine.max_spec_refinement_iterations,
  );
  const previousRun = history.runs.at(-1) ?? null;
  const previousIssueFingerprints = new Set((previousRun?.global_issues ?? []).map((issue) => issue.code));
  const currentIssueFingerprints = new Set(
    agentResults.flatMap((result) => result.errors.map((issue) => issue.code)),
  );
  const noNewErrors = [...currentIssueFingerprints].every((issueCode) => previousIssueFingerprints.has(issueCode));
  const previousHealth = Number(previousRun?.catalog_health ?? history.latest_catalog?.catalog_health ?? 0);
  const currentHealth = buildHealthSummary(agentResults).catalog_health;
  const healthDelta = round(currentHealth - previousHealth);
  const iterationsUsed = Math.min(maxIterations, history.runs.length > 0 ? 2 : 1);
  const earlyExit = noNewErrors && Math.abs(healthDelta) < 0.5 && iterationsUsed >= 2;

  return {
    iterations_used: iterationsUsed,
    early_exit: earlyExit,
    batched_fixes: 0,
    no_new_errors: noNewErrors,
    health_delta: healthDelta,
  };
}

function buildRuntimeFeedbackApplied(agentResults) {
  const sources = new Set();
  let count = 0;
  for (const result of agentResults) {
    for (const target of result.refinement_targets) {
      if (target.source !== "runtime") {
        continue;
      }
      count += 1;
      if (target.runtime_source) {
        sources.add(target.runtime_source);
      }
    }
  }

  return {
    count,
    sources: uniqueSorted([...sources]),
  };
}

function buildRefinementPlan(agentResults, priorityWeights, policyEngine, convergenceControl) {
  const topTargetsPerIteration = Number(
    policyEngine.top_refinement_targets_per_iteration ?? defaultPolicyEngine.top_refinement_targets_per_iteration,
  );
  const flattenedTargets = [];
  for (const result of agentResults) {
    for (const target of result.refinement_targets) {
      flattenedTargets.push({
        agent_slug: result.agent_slug,
        target,
      });
    }
  }

  const frequencyByKey = new Map();
  for (const entry of flattenedTargets) {
    const key = buildRefinementTargetKey(entry.target);
    frequencyByKey.set(key, Number(frequencyByKey.get(key) ?? 0) + 1);
  }

  const prioritizedTargets = flattenedTargets
    .map((entry) => {
      const frequency = Number(frequencyByKey.get(buildRefinementTargetKey(entry.target)) ?? 1);
      const severityWeight = severityWeightForTarget(entry.target);
      const crossSectionImpact = crossSectionImpactForTarget(entry.target);
      const basePriority =
        severityWeight * 0.5 +
        crossSectionImpact * 0.3 +
        frequency * 0.2;
      const priorityScore = round(basePriority * Number(entry.target.priority_multiplier ?? 1), 3);

      return {
        ...entry,
        target: normalizeTarget({
          ...entry.target,
          priority_score: priorityScore,
          frequency,
          cross_section_impact: crossSectionImpact,
          batched: frequency > 1,
        }),
      };
    })
    .sort((left, right) => {
      if (right.target.priority_score !== left.target.priority_score) {
        return right.target.priority_score - left.target.priority_score;
      }
      return left.agent_slug.localeCompare(right.agent_slug);
    });

  const selectedTargets = prioritizedTargets.slice(0, topTargetsPerIteration);
  const batchedFixes = new Set(
    selectedTargets.filter((entry) => entry.target.batched).map((entry) => buildRefinementTargetKey(entry.target)),
  ).size;
  convergenceControl.batched_fixes = batchedFixes;

  return {
    global_priorities: buildGlobalPriorities(agentResults, priorityWeights),
    agent_targets: sortByKey(
      agentResults.map((result) => ({
        agent_slug: result.agent_slug,
        targets: selectedTargets
          .filter((entry) => entry.agent_slug === result.agent_slug)
          .map((entry) => entry.target),
      })),
      "agent_slug",
    ),
    prioritized_targets: selectedTargets.map((entry) => ({
      agent_slug: entry.agent_slug,
      target: entry.target,
    })),
    batched_fixes: batchedFixes,
  };
}

function buildCatalogSummary(agentResults) {
  return {
    total_agents: agentResults.length,
    converged: agentResults.filter((result) => result.status === "converged").length,
    needs_refinement: agentResults.filter((result) => result.status === "needs_refinement").length,
    blocked: agentResults.filter((result) => result.status === "blocked").length,
    escalated: agentResults.filter((result) => result.status === "escalated").length,
  };
}

function buildHealthSummary(agentResults) {
  const overallScores = agentResults.map((result) => result.health.overall);
  const averageScore =
    overallScores.length === 0
      ? 0
      : round(overallScores.reduce((total, value) => total + value, 0) / overallScores.length);

  return {
    catalog_health: averageScore,
    distribution: {
      healthy: agentResults.filter((result) => result.health.overall >= 85).length,
      watch: agentResults.filter((result) => result.health.overall >= 70 && result.health.overall < 85).length,
      critical: agentResults.filter((result) => result.health.overall < 70).length,
    },
    per_agent: sortByKey(
      agentResults.map((result) => ({
        agent_slug: result.agent_slug,
        validation: result.health.validation,
        evaluation: result.health.evaluation,
        readiness: result.health.readiness,
        overall: result.health.overall,
      })),
      "agent_slug",
    ),
  };
}

function buildHealthTrend(history, catalogHealth) {
  const previousScore = Number(history.latest_catalog?.catalog_health ?? 0);
  const delta = round(catalogHealth - previousScore);
  const trend = delta > 1 ? "improving" : delta < -1 ? "degrading" : "stable";
  const historyEntries = [...(history.health_history ?? []), {
    timestamp: new Date().toISOString(),
    health_score: catalogHealth,
  }]
    .slice(-20)
    .map((entry) => ({
      timestamp: entry.timestamp,
      health_score: round(entry.health_score),
    }));

  return {
    trend,
    delta,
    history: historyEntries,
  };
}

function buildConvergenceOverview(agentResults, healthTrend) {
  let catalogStatus = "stable";
  if (healthTrend.trend === "degrading" || agentResults.some((result) => result.status === "escalated")) {
    catalogStatus = "degraded";
  } else if (agentResults.some((result) => result.status !== "converged")) {
    catalogStatus = "improving";
  }

  return {
    catalog_status: catalogStatus,
    high_risk_agents: sortByKey(
      agentResults.filter((result) => result.status === "escalated" || result.status === "blocked"),
      "agent_slug",
    ).map((result) => result.agent_slug),
    ready_agents: sortByKey(
      agentResults.filter((result) => result.status === "converged"),
      "agent_slug",
    ).map((result) => result.agent_slug),
    needs_attention: sortByKey(
      agentResults.filter((result) => result.status !== "converged"),
      "agent_slug",
    ).map((result) => result.agent_slug),
    trend: healthTrend.trend,
  };
}

function buildActionsTaken(mode, scope, policyEngine, selectedAgents, triggerDecision) {
  if (!triggerDecision.should_execute) {
    return [
      {
        type: "defer_to_scheduled_run",
        state: "executed",
        scope,
        reason: triggerDecision.reason,
        agent_count: selectedAgents.length,
      },
    ];
  }

  if (mode === "passive") {
    return [
      {
        type: "monitor_only",
        state: "executed",
        scope,
        reason: triggerDecision.reason,
        agent_count: selectedAgents.length,
      },
    ];
  }

  if (!policyEngine.auto_run_enabled) {
    return [
      {
        type: "autonomous_run_blocked_by_policy",
        state: "suggested",
        scope,
        reason: triggerDecision.reason,
        agent_count: selectedAgents.length,
      },
    ];
  }

  return [
    {
      type: "run_continuous_improvement_orchestrator",
      state: "executed",
      scope,
      reason: triggerDecision.reason,
      agent_count: selectedAgents.length,
    },
  ];
}

function buildPatterns(history, currentGlobalPriorities, currentRegressions) {
  const grouped = new Map();
  const runs = history.runs.slice(-20);

  for (const run of runs) {
    for (const issue of run.global_issues ?? []) {
      const entry = grouped.get(issue.code) ?? {
        type: issue.code,
        source: issue.source,
        frequency: 0,
        affected_agents: new Set(),
      };
      entry.frequency += 1;
      for (const slug of issue.agent_slugs ?? []) {
        entry.affected_agents.add(slug);
      }
      grouped.set(issue.code, entry);
    }
  }

  for (const issue of currentGlobalPriorities) {
    const entry = grouped.get(issue.code) ?? {
      type: issue.code,
      source: issue.source,
      frequency: 0,
      affected_agents: new Set(),
    };
    entry.frequency += 1;
    for (const slug of issue.agent_slugs ?? []) {
      entry.affected_agents.add(slug);
    }
    grouped.set(issue.code, entry);
  }

  for (const regression of currentRegressions) {
    const type = `regression:${regression.type ?? regression.regression_type}`;
    const entry = grouped.get(type) ?? {
      type,
      source: sourceFromRegressionType(regression.type ?? regression.regression_type ?? ""),
      frequency: 0,
      affected_agents: new Set(),
    };
    entry.frequency += 1;
    if (regression.agent_slug) {
      entry.affected_agents.add(regression.agent_slug);
    }
    grouped.set(type, entry);
  }

  return [...grouped.values()]
    .map((entry) => ({
      type: entry.type,
      source: entry.source,
      frequency: entry.frequency,
      affected_agents: uniqueSorted([...entry.affected_agents]),
    }))
    .filter((entry) => entry.frequency > 0)
    .sort((left, right) => {
      if (right.frequency !== left.frequency) {
        return right.frequency - left.frequency;
      }

      if (right.affected_agents.length !== left.affected_agents.length) {
        return right.affected_agents.length - left.affected_agents.length;
      }

      return left.type.localeCompare(right.type);
    });
}

function buildBestPracticesIntegration(patterns, recentIssues) {
  const recommendedUpdates = patterns
    .filter((pattern) => pattern.frequency >= 2)
    .slice(0, 5)
    .map((pattern) => ({
      type: "recommended_update",
      target_agent: "best-practices-curation-specialist",
      source: pattern.source,
      pattern: pattern.type,
      message: `Review recurring pattern ${pattern.type} affecting ${pattern.affected_agents.length} agents.`,
    }));

  const deprecatedPatterns = recentIssues
    .filter((issue) => issue.priority === "P2" && issue.agent_slugs.length === 1)
    .slice(0, 3)
    .map((issue) => ({
      type: "deprecated_pattern",
      pattern: issue.code,
      message: `Monitor whether ${issue.code} still needs active best-practice coverage.`,
    }));

  return {
    target_agent: "best-practices-curation-specialist",
    input: {
      patterns,
      recent_issues: recentIssues,
    },
    recommended_updates: recommendedUpdates,
    deprecated_patterns: deprecatedPatterns,
  };
}

function buildAdaptivePriorityWeights(patterns, regressions, previousWeights) {
  const rawWeights = {
    ...defaultPriorityWeights,
    ...previousWeights,
  };

  for (const pattern of patterns) {
    if (!rawWeights[pattern.source]) {
      continue;
    }
    rawWeights[pattern.source] += pattern.frequency * 0.1;
  }

  for (const regression of regressions) {
    const source = sourceFromRegressionType(regression.type ?? regression.regression_type ?? "");
    rawWeights[source] += regression.severity === "high" ? 0.5 : regression.severity === "medium" ? 0.25 : 0.1;
  }

  const average =
    Object.values(rawWeights).reduce((total, value) => total + value, 0) / Object.keys(rawWeights).length;

  return {
    validation: round(rawWeights.validation / average),
    evaluation: round(rawWeights.evaluation / average),
    readiness: round(rawWeights.readiness / average),
  };
}

function buildLearningUpdates(bestPracticesIntegration, priorityWeights) {
  const updates = [
    {
      type: "priority_weights_updated",
      priority_weights: priorityWeights,
    },
  ];

  if (bestPracticesIntegration.recommended_updates.length > 0) {
    updates.push({
      type: "best_practices_feedback",
      target_agent: bestPracticesIntegration.target_agent,
      recommended_updates: bestPracticesIntegration.recommended_updates,
      deprecated_patterns: bestPracticesIntegration.deprecated_patterns,
    });
  }

  return updates;
}

function countConsecutiveRunsWithIssue(history, issueCode) {
  let count = 0;
  for (let index = history.runs.length - 1; index >= 0; index -= 1) {
    const run = history.runs[index];
    const hasIssue = (run.global_issues ?? []).some((issue) => issue.code === issueCode);
    if (!hasIssue) {
      break;
    }
    count += 1;
  }
  return count;
}

function buildEscalationSignals(agentResults, globalPriorities, history, triggerDecision, allAgentsCount, policyEngine) {
  const conflictingSources = agentResults.some((result) => {
    const criticalSources = uniqueSorted(result.errors.map((issue) => issue.source));
    return criticalSources.length > 1;
  });
  const sameIssuePersisted = globalPriorities.some(
    (issue) => countConsecutiveRunsWithIssue(history, issue.code) >= 2,
  );
  const affectedAgents = uniqueSorted(globalPriorities.flatMap((issue) => issue.agent_slugs)).length;
  const largeScaleInstability =
    allAgentsCount > 0 && affectedAgents / allAgentsCount >= 0.2;
  const iterationExhausted = 1 >= Number(policyEngine.max_iterations);

  return {
    conflicting_sources: conflictingSources,
    same_issue_persisted: sameIssuePersisted,
    iteration_exhausted: iterationExhausted,
    large_scale_instability: largeScaleInstability,
    affected_agents: affectedAgents,
    escalated_trigger: triggerDecision.threshold_state === "escalated",
  };
}

function buildAutonomyDecision(mode, agentResults, healthSummary, escalationSignals, optimizationSummary) {
  const validationErrors = agentResults.reduce((total, result) => total + result.errors.length, 0);
  const ambiguityIssues = agentResults.reduce(
    (total, result) =>
      total + result.errors.filter((issue) => issue.code.includes("ambigu")).length,
    0,
  );
  const missingRequiredSections = agentResults.some((result) =>
    result.errors.some((issue) => issue.code === "missing_required_artifact"),
  );
  const unresolvedConstraintConflicts = agentResults.some((result) =>
    result.errors.some((issue) => issue.code.includes("constraint")),
  );
  const competingRefinementTargets = agentResults.some((result) => result.refinement_targets.length > 1);
  const competingOptimizationTargets = (optimizationSummary?.per_agent ?? []).some(
    (entry) => (entry.optimization?.optimization_targets?.length ?? 0) > 1,
  );
  const confidenceScore = round(healthSummary.catalog_health / 100);
  const lowRiskApplied = Number(optimizationSummary?.low_risk_applied ?? 0) > 0;
  const safeToApply =
    mode === "autonomous" &&
    ((validationErrors === 0 &&
      ambiguityIssues === 0 &&
      confidenceScore >= 0.95 &&
      !missingRequiredSections &&
      !unresolvedConstraintConflicts &&
      !competingRefinementTargets &&
      !competingOptimizationTargets &&
      !escalationSignals.conflicting_sources) ||
      lowRiskApplied);

  let reason = "Assisted mode never auto-applies changes.";
  if (mode === "autonomous") {
    reason = safeToApply
      ? lowRiskApplied
        ? "Low-risk optimization guardrails are satisfied."
        : "Autonomous guardrails are satisfied."
      : "Autonomous guardrails blocked auto-apply; falling back to report-only output.";
  } else if (mode === "passive") {
    reason = "Passive mode only monitors and reports.";
  }

  return {
    mode,
    reason,
    safe_to_apply: safeToApply,
    confidence_score: confidenceScore,
    validation_errors: validationErrors,
    ambiguity_issues: ambiguityIssues,
    action: safeToApply
      ? lowRiskApplied
        ? "low_risk_auto_apply_allowed"
        : "auto_apply_allowed"
      : "assisted_mode_output_only",
  };
}

function buildNextActions(
  agentResults,
  mode,
  regressions,
  triggerDecision,
  patterns,
  healthTrend,
  escalationSignals,
  optimizationSummary,
) {
  const nextActions = [];

  if (mode === "passive") {
    nextActions.push("Review passive monitoring output and approve assisted or autonomous execution if needed.");
  }

  if (triggerDecision.threshold_state === "deferred_to_schedule") {
    nextActions.push("Skip the noisy git-triggered run and let the scheduled full scan handle the large change set.");
  }

  if (regressions.some((entry) => entry.severity === "high")) {
    nextActions.push("Run targeted repair on high-severity regressions and route blockers to a human owner.");
  }

  if (agentResults.some((result) => result.status === "blocked")) {
    nextActions.push("Resolve missing artifacts or readiness blockers before the next improvement cycle.");
  }

  if (agentResults.some((result) => result.status === "needs_refinement")) {
    nextActions.push("Review refinement targets and schedule a targeted-repair batch for non-converged agents.");
  }

  if (patterns.some((pattern) => pattern.frequency >= 2)) {
    nextActions.push("Feed recurring issue patterns into best-practices curation and update refinement guidance.");
  }

  if (optimizationSummary?.agents_optimized > 0) {
    nextActions.push("Review conservative optimization targets for converged agents that are still below quality target.");
  }

  if (triggerDecision.trigger_type === "health_degradation" || healthTrend.trend === "degrading") {
    nextActions.push("Run a full-catalog iterative improvement pass until health stabilizes.");
  }

  if (escalationSignals.conflicting_sources || escalationSignals.same_issue_persisted) {
    nextActions.push("Escalate persistent or conflicting feedback to a human owner or adjacent specialist.");
  }

  if (nextActions.length === 0) {
    nextActions.push(
      healthTrend.trend === "stable"
        ? "No immediate action required; continue scheduled monitoring."
        : "Continue the current improvement mode and monitor the next run.",
    );
  }

  return uniqueSorted(nextActions);
}

function buildExecutionController(
  mode,
  policyEngine,
  healthSummary,
  regressionsDetected,
  triggerDecision,
  selectedAgentsCount,
  autonomyDecision,
  escalationSignals,
  parallelism,
) {
  const shouldEscalate =
    regressionsDetected.some((entry) => entry.severity === "high") ||
    healthSummary.catalog_health < Number(policyEngine.escalation_threshold ?? defaultPolicyEngine.escalation_threshold) ||
    escalationSignals.iteration_exhausted ||
    escalationSignals.conflicting_sources ||
    escalationSignals.same_issue_persisted ||
    escalationSignals.large_scale_instability ||
    escalationSignals.escalated_trigger;
  const shouldAutoApply = autonomyDecision.safe_to_apply;
  const maxAgentsPerRun = Number(policyEngine.max_agents_per_run ?? defaultPolicyEngine.max_agents_per_run);
  const batchCount = Math.max(1, Math.ceil(selectedAgentsCount / maxAgentsPerRun));

  return {
    mode,
    auto_run_enabled: Boolean(policyEngine.auto_run_enabled),
    max_iterations: Number(policyEngine.max_iterations),
    max_total_iterations: Number(policyEngine.max_total_iterations),
    max_agents_per_run: maxAgentsPerRun,
    max_parallel_agents: Number(policyEngine.max_parallel_agents),
    batch_count: batchCount,
    changed_agents_count: Number(triggerDecision.changed_agents_count ?? 0),
    regression_count: Number(triggerDecision.regression_count ?? 0),
    health_delta: Number(triggerDecision.health_delta ?? 0),
    iterations_used: 1,
    parallelism,
    auto_apply_enabled: shouldAutoApply,
    auto_apply_threshold: Number(policyEngine.auto_apply_threshold),
    escalation_threshold: Number(policyEngine.escalation_threshold),
    decision: !triggerDecision.should_execute
      ? "deferred_to_schedule"
      : shouldEscalate
      ? "route_to_human_or_adjacent_specialist"
      : shouldAutoApply
        ? "auto_apply_allowed"
        : "report_only",
  };
}

function getGitStatusEntries(rootDir) {
  try {
    return runGit(rootDir, ["status", "--porcelain=v1"])
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2),
        path: normalizeRepoPath(line.slice(3).split(" -> ").at(-1)),
      }));
  } catch {
    return [];
  }
}

function buildPublishConfig(options = {}) {
  return {
    enabled: Boolean(options.publish),
    branch: options.publishBranch ?? defaultPublishConfig.branch,
    base: options.publishBase ?? defaultPublishConfig.base,
    commitMessage: options.publishCommitMessage ?? defaultPublishConfig.commitMessage,
    prTitle: options.publishPrTitle ?? defaultPublishConfig.prTitle,
    commitPaths: ["catalog/", "reports/generated/"],
    prBody:
      options.publishPrBody ??
      "Automated update from the autonomous improvement system.\n\nThis PR is maintained by the system-owned autonomous branch.",
  };
}

function gitRefExists(rootDir, refName) {
  try {
    runGit(rootDir, ["show-ref", "--verify", "--quiet", refName]);
    return true;
  } catch {
    return false;
  }
}

function ensurePublishWorkspace(rootDir, publishConfig, allowedPaths = mutationAllowedPaths) {
  const statusEntries = getGitStatusEntries(rootDir);
  const disallowedEntries = statusEntries.filter((entry) =>
    !allowedPaths.some((prefix) => entry.path === prefix.slice(0, -1) || entry.path.startsWith(prefix)),
  );
  if (disallowedEntries.length > 0) {
    throw new Error(
      `Publish requires a clean allowlisted workspace; found disallowed paths: ${disallowedEntries.map((entry) => entry.path).join(", ")}`,
    );
  }

  try {
    runGit(rootDir, ["fetch", "origin", "--prune"]);
  } catch {
    // Keep publish workspace prep deterministic even when fetch is temporarily unavailable.
  }

  const remoteBranchRef = `refs/remotes/origin/${publishConfig.branch}`;
  const remoteBaseRef = `refs/remotes/origin/${publishConfig.base}`;

  if (gitRefExists(rootDir, remoteBranchRef)) {
    runGit(rootDir, ["checkout", "-B", publishConfig.branch, `origin/${publishConfig.branch}`]);
  } else if (gitRefExists(rootDir, remoteBaseRef)) {
    runGit(rootDir, ["checkout", "-B", publishConfig.branch, `origin/${publishConfig.base}`]);
  } else {
    runGit(rootDir, ["checkout", "-B", publishConfig.branch]);
  }

  return {
    prepared: true,
    branch: publishConfig.branch,
    disallowed_paths: disallowedEntries.map((entry) => entry.path),
  };
}

function getHeadCommit(rootDir) {
  try {
    return normalizeWhitespace(runGit(rootDir, ["rev-parse", "HEAD"]));
  } catch {
    return null;
  }
}

function parsePullRequestUrl(output) {
  const normalized = normalizeWhitespace(output);
  const match = normalized.match(/https?:\/\/\S+\/pull\/(\d+)\b/);
  if (!match) {
    return {
      url: normalized || null,
      number: null,
    };
  }

  return {
    url: match[0],
    number: Number.parseInt(match[1], 10),
  };
}
function ensureAutonomousPullRequest(rootDir, publishConfig) {
  try {
    const existing = JSON.parse(
      runCommand(rootDir, "gh", [
        "pr",
        "list",
        "--head",
        publishConfig.branch,
        "--base",
        publishConfig.base,
        "--state",
        "open",
        "--json",
        "number,url",
      ]),
    );
    if (Array.isArray(existing) && existing.length > 0) {
      return {
        created: false,
        number: existing[0].number,
        url: existing[0].url,
      };
    }

    const created = parsePullRequestUrl(
      runCommand(rootDir, "gh", [
        "pr",
        "create",
        "--head",
        publishConfig.branch,
        "--base",
        publishConfig.base,
        "--title",
        publishConfig.prTitle,
        "--body",
        publishConfig.prBody,
      ]),
    );
    return {
      created: true,
      number: created.number,
      url: created.url,
    };
  } catch (error) {
    return {
      created: false,
      error: normalizeWhitespace(error?.message ?? "gh pr create failed"),
    };
  }
}

function publishAutonomousChanges(rootDir, publishConfig, publishablePaths = []) {
  const allowedPublishablePaths = uniqueSorted(
    publishablePaths.filter((entryPath) =>
      publishConfig.commitPaths.some((prefix) => entryPath === prefix.slice(0, -1) || entryPath.startsWith(prefix)),
    ),
  );
  const stagingPrefixes = uniqueSorted(
    allowedPublishablePaths.flatMap((entryPath) =>
      publishConfig.commitPaths.filter((prefix) => entryPath === prefix.slice(0, -1) || entryPath.startsWith(prefix)),
    ),
  );
  if (allowedPublishablePaths.length === 0) {
    return {
      enabled: true,
      branch: publishConfig.branch,
      base: publishConfig.base,
      empty_run: true,
      committed: false,
      pushed: false,
      pr: null,
      paths: [],
    };
  }

  runGit(rootDir, ["add", "--", ...stagingPrefixes]);

  try {
    runGit(rootDir, ["diff", "--cached", "--quiet", "--", ...stagingPrefixes]);
    return {
      enabled: true,
      branch: publishConfig.branch,
      base: publishConfig.base,
      empty_run: true,
      committed: false,
      pushed: false,
      pr: null,
      paths: allowedPublishablePaths,
    };
  } catch {
    // staged diff exists
  }

  runGit(rootDir, ["commit", "-m", publishConfig.commitMessage]);
  runGit(rootDir, ["push", "origin", publishConfig.branch, "--force"]);
  return {
    enabled: true,
    branch: publishConfig.branch,
    base: publishConfig.base,
    empty_run: false,
    committed: true,
    pushed: true,
    commit: getHeadCommit(rootDir),
    paths: allowedPublishablePaths,
    pr: ensureAutonomousPullRequest(rootDir, publishConfig),
  };
}

async function writeText(rootDir, filePath, contents, allowedPaths = mutationAllowedPaths) {
  assertAllowedPath(rootDir, filePath, allowedPaths);
  ensureDirectory(filePath);
  await fsp.writeFile(filePath, contents, "utf8");
}

async function writeJson(rootDir, filePath, payload, allowedPaths = mutationAllowedPaths) {
  await writeText(rootDir, filePath, `${JSON.stringify(payload, null, 2)}\n`, allowedPaths);
}

function summarizeTopIssues(globalPriorities) {
  return globalPriorities.slice(0, 3).map((entry) => ({
    code: entry.code,
    agents: entry.agent_slugs.length,
    message: entry.message,
  }));
}

export function formatImprovementSummary(report) {
  const trendValue = report.health_trend?.trend ?? "stable";
  const arrow = trendValue === "improving" ? "↑" : trendValue === "degrading" ? "↓" : "→";
  const deltaValue = Number(report.health_trend?.delta ?? report.health_summary?.delta ?? 0);
  const delta = deltaValue > 0 ? `+${deltaValue}` : `${deltaValue}`;
  const improvedCount = report.agents_updated.length;
  const regressions = report.regressions.length;
  const lines = [
    `Catalog Health: ${report.health_summary.catalog_health} (${arrow} ${delta})`,
    `Agents Improved: ${improvedCount}`,
    `Regressions: ${regressions}`,
    "Agent States:",
    `- Spec Only: ${report.agent_state_summary.spec_only}`,
    `- Ready For Codegen: ${report.agent_state_summary.ready_for_codegen}`,
    `- Implemented: ${report.agent_state_summary.implemented}`,
    "Optimization:",
    `- Low-Risk Applied: ${report.optimization.low_risk_applied}`,
    `- Assisted Only: ${report.optimization.assisted_only}`,
    `- Rolled Back: ${report.optimization.rolled_back}`,
    `- Suppressed (Oscillation): ${report.optimization.suppressed}`,
    "Optimization Control:",
    `- Candidates: ${report.optimization_control.candidates_total}`,
    `- Applied: ${report.optimization_control.applied}`,
    `- Deferred: ${report.optimization_control.deferred}`,
    `- Filtered (Low Value): ${report.optimization_control.filtered_out}`,
    `- Budget Used: ${report.optimization_control.budget_used}/${report.optimization_control.effective_budget}`,
    "Oscillation Control:",
    `- Suppressed Active: ${report.oscillation_control.suppressed_active}`,
    `- Recovered This Run: ${report.oscillation_control.recovered_this_run}`,
    `- Expired: ${report.oscillation_control.expired}`,
    "Convergence Control:",
    `- Iterations Used: ${report.convergence_control.iterations_used}`,
    `- Early Exit: ${report.convergence_control.early_exit}`,
    `- Batched Fixes: ${report.convergence_control.batched_fixes}`,
    "Runtime Feedback:",
    `- Applied: ${report.runtime_feedback_applied.count}`,
    `- Sources: ${report.runtime_feedback_applied.sources.join(", ") || "none"}`,
    "Mutation:",
    `- Targets Applied: ${report.mutation_summary?.targets_applied ?? 0}`,
    `- Files Modified: ${report.mutation_summary?.files_modified ?? 0}`,
    `- Validation Passed: ${report.mutation_summary?.validation_passed ?? true}`,
    `- Empty Run: ${report.mutation_summary?.empty_run ?? true}`,
    "Publish:",
    `- Enabled: ${report.publish_summary?.enabled ?? false}`,
    `- Branch: ${report.publish_summary?.branch ?? "n/a"}`,
    `- Committed: ${report.publish_summary?.committed ?? false}`,
    `- Pushed: ${report.publish_summary?.pushed ?? false}`,
    "Top Issues:",
  ];

  for (const issue of summarizeTopIssues(report.global_priorities)) {
    lines.push(`- ${issue.message} (${issue.agents} agents)`);
  }

  if (report.global_priorities.length === 0) {
    lines.push("- None");
  }

  return `${lines.join("\n")}\n`;
}

function buildHistoryRun(report, priorityWeights) {
  return normalizeHistoryRun({
    run_id: report.run_id,
    timestamp: report.generated_at,
    trigger: report.trigger,
    scope: report.scope,
    catalog_health: report.health_summary.catalog_health,
    catalog_summary: report.catalog_summary,
    health_summary: {
      ...report.health_summary,
      trend: report.health_trend.trend,
      delta: report.health_trend.delta,
    },
    health_trend: report.health_trend,
    regressions: report.regressions,
    global_issues: report.global_priorities,
    agent_results: report.agent_results.map((result) => ({
      agent_slug: result.agent_slug,
      status: result.status,
      overall_score: result.health.overall,
      issue_codes: result.issue_codes,
      unresolved_issue_codes: result.unresolved_issue_codes,
      optimization: result.optimization,
    })),
    refinement_targets: report.refinement_plan.agent_targets,
    patterns: report.patterns,
    priority_weights: priorityWeights,
    learning_updates: report.learning_updates,
    convergence_control: report.convergence_control,
    runtime_feedback_applied: report.runtime_feedback_applied,
  });
}

export function analyzeImprovementHistory(historyInput) {
  const history =
    typeof historyInput === "string" ? loadImprovementHistory(historyInput) : normalizeHistory(historyInput ?? {});
  const latestRun = history.runs.at(-1) ?? null;
  const patterns = buildPatterns(history, latestRun?.global_issues ?? [], latestRun?.regressions ?? []);
  const bestPracticesIntegration = buildBestPracticesIntegration(patterns, latestRun?.global_issues ?? []);
  const priorityWeights = buildAdaptivePriorityWeights(
    patterns,
    latestRun?.regressions ?? [],
    history.learning?.priority_weights ?? defaultPriorityWeights,
  );
  const healthHistory = history.health_history ?? [];
  const currentHealth = Number(healthHistory.at(-1)?.health_score ?? 0);
  const previousHealth = Number(healthHistory.at(-2)?.health_score ?? 0);
  const delta = round(currentHealth - previousHealth);
  const trend = delta > 1 ? "improving" : delta < -1 ? "degrading" : "stable";

  return {
    analyzed_at: new Date().toISOString(),
    run_count: history.runs.length,
    latest_run_id: latestRun?.run_id ?? null,
    patterns,
    learning_updates: buildLearningUpdates(bestPracticesIntegration, priorityWeights),
    best_practices_integration: bestPracticesIntegration,
    priority_weights: priorityWeights,
    health_trend: {
      trend,
      delta,
      history: history.health_history ?? [],
    },
  };
}

export async function runCatalogImprovement(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const mode = options.mode ?? "assisted";
  const validationProfile = options.validationProfile ?? "strict";
  const persist = options.persist !== false;
  const historyPath = path.resolve(rootDir, options.historyPath ?? defaultPaths.history);
  const reportPath = path.resolve(rootDir, options.reportPath ?? defaultPaths.report);
  const perAgentReportsDir = path.resolve(rootDir, options.perAgentReportsDir ?? defaultPaths.perAgentReports);
  const generatedAgentsDir = path.resolve(rootDir, options.generatedAgentsDir ?? defaultPaths.generatedAgents);
  const publishConfig = buildPublishConfig(options);
  const policyEngine = {
    ...defaultPolicyEngine,
    ...(options.policyEngine ?? {}),
  };
  const runtimeFeedbackInput =
    options.runtimeFeedback ??
    (options.runtimeFeedbackPath ? readJsonIfExists(path.resolve(rootDir, options.runtimeFeedbackPath)) : null);
  const runtimeFeedbackByAgent = normalizeRuntimeFeedbackInput(runtimeFeedbackInput);

  if (options.applyRefinements && !persist) {
    throw new Error("Spec mutation requires persistence; rerun without persist=false.");
  }

  if (publishConfig.enabled && !persist) {
    throw new Error("Publishing requires persistence; rerun without persist=false.");
  }

  const history = loadImprovementHistory(historyPath);
  const allAgents = discoverCatalogAgents(rootDir);
  const triggerDecision = detectImprovementTrigger({
    ...options,
    rootDir,
    history,
    allAgents,
    policyEngine,
  });
  const selectedAgents = resolveSelectedAgents(allAgents, triggerDecision, options);
  const limitedAgents = options.maxAgents
    ? selectedAgents.slice(0, Number(options.maxAgents))
    : selectedAgents;
  const limitedAgentsBySlug = new Map(limitedAgents.map((agent) => [agent.slug, agent]));
  const cappedParallelism = Math.min(
    Number(options.parallelism ?? 4),
    Number(policyEngine.max_parallel_agents ?? defaultPolicyEngine.max_parallel_agents),
  );
  const batchedAgents = chunkValues(
    limitedAgents,
    Number(policyEngine.max_agents_per_run ?? defaultPolicyEngine.max_agents_per_run),
  );
  const baselinePriorityWeights = {
    ...defaultPriorityWeights,
    ...(triggerDecision.priority_weights ?? {}),
  };

  const agentResults = [];
  if (triggerDecision.should_execute) {
    for (const batch of batchedAgents) {
      const batchResults = await runWithParallelism(
        batch,
        cappedParallelism,
        (agent) => analyzeAgent(agent, history, policyEngine, runtimeFeedbackByAgent),
      );
      agentResults.push(...batchResults);
    }
  }
  let sortedResults = sortByKey(agentResults, "agent_slug");
  let publishWorkspace = {
    enabled: publishConfig.enabled,
    prepared: false,
    branch: publishConfig.branch,
    base: publishConfig.base,
  };
  if (publishConfig.enabled) {
    publishWorkspace = {
      ...publishWorkspace,
      ...ensurePublishWorkspace(rootDir, publishConfig),
    };
  }

  let mutationSummary = {
    enabled: Boolean(options.applyRefinements),
    targets_considered: sortedResults.reduce((total, result) => total + result.refinement_targets.length, 0),
    targets_applied: 0,
    files_modified: 0,
    modified_files: [],
    validation_passed: true,
    empty_run: true,
    agent_mutations: [],
  };

  if (options.applyRefinements && triggerDecision.should_execute && sortedResults.length > 0) {
    const modifiedFiles = new Set();
    const agentMutations = [];
    let validationPassed = true;

    for (const result of sortedResults) {
      const agent = limitedAgentsBySlug.get(result.agent_slug);
      if (!agent) {
        continue;
      }

      const mutation = await applyRefinementTargets(
        createMutationSchema(rootDir, agent),
        result.refinement_targets,
        {
          rootDir,
          allowedPaths: mutationAllowedPaths,
          generatedAt: new Date().toISOString(),
          feedback: {
            errors: result.errors,
            warnings: result.warnings,
          },
          history,
          originalResult: result,
          policyEngine,
          runtimeFeedbackByAgent,
        },
      );

      validationPassed = validationPassed && mutation.validation?.validation_passed !== false;
      const repoModifiedFiles = mutation.modified_files.map((entry) =>
        normalizeRepoPath(path.join(agent.relativePackagePath, entry)),
      );
      repoModifiedFiles.forEach((entry) => modifiedFiles.add(entry));
      agentMutations.push({
        agent_slug: result.agent_slug,
        mutation_status: mutation.mutation_status,
        reason: mutation.reason,
        targets_applied: mutation.targets_applied,
        files_modified: mutation.files_modified,
        modified_files: repoModifiedFiles,
      });
    }

    mutationSummary = {
      enabled: true,
      targets_considered: sortedResults.reduce((total, result) => total + result.refinement_targets.length, 0),
      targets_applied: agentMutations.reduce((total, entry) => total + entry.targets_applied, 0),
      files_modified: modifiedFiles.size,
      modified_files: [...modifiedFiles].sort(),
      validation_passed: validationPassed,
      empty_run: modifiedFiles.size === 0,
      agent_mutations: agentMutations,
    };

    if (modifiedFiles.size > 0) {
      const refreshedAgentsBySlug = new Map(discoverCatalogAgents(rootDir).map((agent) => [agent.slug, agent]));
      const rerunAgents = limitedAgents.map((agent) => refreshedAgentsBySlug.get(agent.slug) ?? agent);
      const rerunBatches = chunkValues(
        rerunAgents,
        Number(policyEngine.max_agents_per_run ?? defaultPolicyEngine.max_agents_per_run),
      );
      const rerunResults = [];
      for (const batch of rerunBatches) {
        const batchResults = await runWithParallelism(
          batch,
          cappedParallelism,
          (agent) => analyzeAgent(agent, history, policyEngine, runtimeFeedbackByAgent),
        );
        rerunResults.push(...batchResults);
      }
      sortedResults = sortByKey(rerunResults, "agent_slug");
    }
  }
  const initialGlobalPriorities = buildGlobalPriorities(sortedResults, baselinePriorityWeights);
  const regressions = sortByKey(
    sortedResults.flatMap((result) => result.regressions),
    "agent_slug",
  );
  const patterns = buildPatterns(history, initialGlobalPriorities, regressions);
  const priorityWeights = buildAdaptivePriorityWeights(patterns, regressions, baselinePriorityWeights);
  const globalPriorities = buildGlobalPriorities(sortedResults, priorityWeights);
  const optimization = buildOptimizationSummary(sortedResults, history, policyEngine, mode);
  const optimizationByAgent = new Map(
    optimization.per_agent.map((entry) => [entry.agent_slug, entry.optimization]),
  );
  const optimizedResults = sortedResults.map((result) => ({
    ...result,
    optimization: optimizationByAgent.get(result.agent_slug) ?? {
      triggered: false,
      iterations: 0,
      improvement: 0,
      stopped_reason: "not_needed",
      optimization_targets: [],
      confidence_score: round(result.health.overall / 100),
      projected_health: result.health.overall,
      safe_to_apply: false,
      apply_action: "assisted_mode_output_only",
    },
  }));
  const codegenContext = {
    current_branch: getCurrentBranch(rootDir),
    refs: listGitRefs(rootDir),
    changed_agents: detectChangedAgentSlugs(rootDir),
  };
  const generatedAt = new Date().toISOString();
  const lifecycleResults = optimizedResults.map((result) => {
    const codegenDecision = buildCodegenDecision(rootDir, result, policyEngine, codegenContext, history);
    return {
      ...result,
      agent_state: codegenDecision.agent_state,
      force_codegen: codegenDecision.force_codegen,
      codegen_reason: codegenDecision.codegen_reason,
      generated: codegenDecision.generated,
      source: codegenDecision.source,
      generated_artifact_path: codegenDecision.generated_artifact_path,
      spec_hash: codegenDecision.spec_hash,
      codegen_cache: codegenDecision.codegen_cache,
    };
  });
  const agentStateSummary = {
    spec_only: lifecycleResults.filter((result) => result.agent_state === "spec_only").length,
    ready_for_codegen: lifecycleResults.filter((result) => result.agent_state === "ready_for_codegen").length,
    implemented: lifecycleResults.filter((result) => result.agent_state === "implemented").length,
  };
  const catalogSummary = buildCatalogSummary(sortedResults);
  let healthSummary = buildHealthSummary(sortedResults);
  if (!triggerDecision.should_execute) {
    healthSummary = {
      ...healthSummary,
      catalog_health: round(history.latest_catalog?.catalog_health ?? 0),
    };
  }
  const healthTrend = !triggerDecision.should_execute
    ? {
        trend: "stable",
        delta: 0,
        history: [...(history.health_history ?? []), {
          timestamp: new Date().toISOString(),
          health_score: round(history.latest_catalog?.catalog_health ?? 0),
        }].slice(-20),
      }
    : buildHealthTrend(history, healthSummary.catalog_health);
  const convergenceOverview = buildConvergenceOverview(sortedResults, healthTrend);
  const convergenceControl = buildConvergenceControl(history, sortedResults, policyEngine);
  const refinementPlan = buildRefinementPlan(sortedResults, priorityWeights, policyEngine, convergenceControl);
  const runtimeFeedbackApplied = buildRuntimeFeedbackApplied(sortedResults);
  const escalationSignals = buildEscalationSignals(
    sortedResults,
    globalPriorities,
    history,
    triggerDecision,
    allAgents.length,
    policyEngine,
  );
  const autonomyDecision = buildAutonomyDecision(
    mode,
    lifecycleResults,
    healthSummary,
    escalationSignals,
    optimization,
  );
  const agentsUpdated = sortByKey(
    sortedResults
      .filter((result) => (history.latest_by_agent?.[result.agent_slug]?.overall_score ?? 0) < result.health.overall)
      .map((result) => ({
        agent_slug: result.agent_slug,
        overall_score: result.health.overall,
      })),
    "agent_slug",
  );
  const bestPracticesIntegration = buildBestPracticesIntegration(patterns, globalPriorities);
  const learningUpdates = buildLearningUpdates(bestPracticesIntegration, priorityWeights);
  const actionsTaken = buildActionsTaken(mode, triggerDecision.scope, policyEngine, limitedAgents, triggerDecision);
  const nextActions = buildNextActions(
    lifecycleResults,
    mode,
    regressions,
    triggerDecision,
    patterns,
    healthTrend,
    escalationSignals,
    optimization,
  );
  const executionController = buildExecutionController(
    mode,
    policyEngine,
    healthSummary,
    regressions,
    triggerDecision,
    limitedAgents.length,
    autonomyDecision,
    escalationSignals,
    cappedParallelism,
  );
  const runId = `improvement-${new Date().toISOString()}`;
  let publishSummary = {
    enabled: publishConfig.enabled,
    prepared: publishWorkspace.prepared,
    branch: publishConfig.branch,
    base: publishConfig.base,
    empty_run: true,
    committed: false,
    pushed: false,
    pr: null,
  };

  const report = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    trigger: {
      trigger_type: triggerDecision.trigger_type,
      scope: triggerDecision.scope,
      reason: triggerDecision.reason,
      agents: triggerDecision.agents ?? [],
      changed_agents_count: Number(triggerDecision.changed_agents_count ?? 0),
      regression_count: Number(triggerDecision.regression_count ?? 0),
      health_delta: Number(triggerDecision.health_delta ?? 0),
      threshold_state: triggerDecision.threshold_state,
      mode,
      validation_profile: validationProfile,
      changed_agents:
        triggerDecision.trigger_type === "git" || options.changed ? detectChangedAgentSlugs(rootDir) : [],
    },
    scope: {
      scope: triggerDecision.scope,
      agents: limitedAgents.map((agent) => agent.slug),
      domain: options.domain ?? triggerDecision.domain ?? null,
    },
    actions_taken: actionsTaken,
    agents_updated: agentsUpdated,
    regressions,
    regressions_detected: regressions,
    patterns,
    learning_updates: learningUpdates,
    optimization,
    optimization_control: optimization.optimization_control,
    throttling_state: optimization.throttling_state,
    oscillation_control: optimization.oscillation_control,
    agent_state_summary: agentStateSummary,
    runtime_feedback_applied: runtimeFeedbackApplied,
    convergence_control: convergenceControl,
    health_summary: healthSummary,
    health_trend: healthTrend,
    next_actions: nextActions,
    catalog_summary: catalogSummary,
    agent_results: lifecycleResults,
    global_priorities: globalPriorities,
    refinement_plan: refinementPlan,
    convergence_overview: convergenceOverview,
    learning_handoff: bestPracticesIntegration,
    best_practices_integration: bestPracticesIntegration,
    priority_weights: priorityWeights,
    mutation_summary: mutationSummary,
    escalation_signals: escalationSignals,
    execution_controller: executionController,
    autonomy_decision: autonomyDecision,
    publish_summary: publishSummary,
    policy_decision: {
      auto_run_enabled: Boolean(policyEngine.auto_run_enabled),
      max_iterations: Number(policyEngine.max_iterations),
      max_total_iterations: Number(policyEngine.max_total_iterations),
      max_agents_per_run: Number(policyEngine.max_agents_per_run),
      max_parallel_agents: Number(policyEngine.max_parallel_agents),
      regression_threshold: Number(policyEngine.regression_threshold),
      health_threshold: Number(policyEngine.health_threshold),
      health_delta_trigger_threshold: Number(policyEngine.health_delta_trigger_threshold),
      health_degradation_threshold: Number(policyEngine.health_degradation_threshold),
      auto_apply_threshold: Number(policyEngine.auto_apply_threshold),
      escalation_threshold: Number(policyEngine.escalation_threshold),
      optimization_enabled: Boolean(policyEngine.optimization_enabled),
      optimization_target: Number(policyEngine.optimization_target),
      max_optimization_iterations: Number(policyEngine.max_optimization_iterations),
      low_risk_optimization_enabled: Boolean(policyEngine.low_risk_optimization_enabled),
      low_risk_confidence_threshold: Number(policyEngine.low_risk_confidence_threshold),
      full_autonomous_confidence_threshold: Number(policyEngine.full_autonomous_confidence_threshold),
      max_expected_improvement_for_low_risk: Number(policyEngine.max_expected_improvement_for_low_risk),
      max_low_risk_targets_per_agent: Number(policyEngine.max_low_risk_targets_per_agent),
      max_low_risk_applies_per_run: Number(policyEngine.max_low_risk_applies_per_run),
      min_projected_improvement: Number(policyEngine.min_projected_improvement),
      regression_soft_limit: Number(policyEngine.regression_soft_limit),
      regression_hard_limit: Number(policyEngine.regression_hard_limit),
      base_budget: Number(policyEngine.base_budget),
      min_budget: Number(policyEngine.min_budget),
      max_budget: Number(policyEngine.max_budget),
      max_optimizations_per_agent_per_run: Number(policyEngine.max_optimizations_per_agent_per_run),
      cooldown_runs: Number(policyEngine.cooldown_runs),
      min_applies_per_run: Number(policyEngine.min_applies_per_run),
      adaptive_budget_floor: Number(policyEngine.adaptive_budget_floor),
      oscillation_ttl_runs: Number(policyEngine.oscillation_ttl_runs),
      max_recovered_agents_per_run: Number(policyEngine.max_recovered_agents_per_run),
      oscillation_low_gain_limit: Number(policyEngine.oscillation_low_gain_limit),
      codegen_mode: String(policyEngine.codegen_mode),
      top_refinement_targets_per_iteration: Number(policyEngine.top_refinement_targets_per_iteration),
      max_spec_refinement_iterations: Number(policyEngine.max_spec_refinement_iterations),
      runtime_feedback_priority_multiplier: Number(policyEngine.runtime_feedback_priority_multiplier),
      min_improvement_threshold: Number(policyEngine.min_improvement_threshold),
      mode,
    },
    orchestrator_reference: "continuous-improvement-orchestrator",
    autonomous_agent_reference: "autonomous-improvement-system",
  };

  if (persist) {
    await writeJson(rootDir, reportPath, report);
    await fsp.mkdir(generatedAgentsDir, { recursive: true });
    await Promise.all(
      lifecycleResults
        .filter((result) => result.generated)
        .map((result) =>
          writeText(
            rootDir,
            path.join(generatedAgentsDir, `${result.agent_slug}.mjs`),
            renderGeneratedAgentModule(
              result,
              {
                agent_state: result.agent_state,
                force_codegen: result.force_codegen,
                codegen_reason: result.codegen_reason,
                source: result.source,
              },
              generatedAt,
            ),
          ),
        ),
    );

    const updatedHistory = normalizeHistory({
      ...history,
      version: 2,
      latest_catalog: {
        catalog_health: healthSummary.catalog_health,
        trend: healthTrend.trend,
        delta: healthTrend.delta,
        generated_at: report.generated_at,
        priority_weights: priorityWeights,
      },
      latest_by_agent: {
        ...(history.latest_by_agent ?? {}),
      },
      runs: [...(history.runs ?? []), buildHistoryRun(report, priorityWeights)].slice(-100),
      health_history: [...(history.health_history ?? []), {
        timestamp: report.generated_at,
        health_score: healthSummary.catalog_health,
      }].slice(-100),
      learning: {
        priority_weights: priorityWeights,
        patterns,
        recommended_updates: bestPracticesIntegration.recommended_updates,
        deprecated_patterns: bestPracticesIntegration.deprecated_patterns,
        oscillation_state: optimization.oscillation_state,
        codegen_cache: {
          ...(history.learning?.codegen_cache ?? {}),
          ...Object.fromEntries(
            lifecycleResults
              .filter((result) => result.generated || result.codegen_cache.hit)
              .map((result) => [
                result.agent_slug,
                {
                  spec_hash: result.spec_hash,
                  generated_path: path.relative(rootDir, result.generated_artifact_path),
                },
              ]),
          ),
        },
        runtime_history: {
          ...(history.learning?.runtime_history ?? {}),
          ...Object.fromEntries(
            Object.entries(runtimeFeedbackByAgent).map(([agentSlug, feedback]) => [
              agentSlug,
              {
                issues: [
                  ...(feedback.execution_failures ?? []),
                  ...(feedback.latency_issues ?? []),
                  ...(feedback.unexpected_behavior ?? []),
                  ...(feedback.user_feedback ?? []),
                ],
                last_seen: report.generated_at,
              },
            ]),
          ),
        },
      },
    });

    for (const result of lifecycleResults) {
      updatedHistory.latest_by_agent[result.agent_slug] = normalizeAgentHistoryRecord({
        agent_slug: result.agent_slug,
        generated_at: report.generated_at,
        validation_score: result.health.validation,
        evaluation_score: result.health.evaluation,
        readiness_score: result.health.readiness,
        overall_score: result.health.overall,
        status: result.status,
        issue_codes: result.issue_codes,
        unresolved_issue_codes: result.unresolved_issue_codes,
        optimization: result.optimization,
      });
    }

    await writeJson(rootDir, historyPath, updatedHistory);
    await fsp.mkdir(perAgentReportsDir, { recursive: true });
    await Promise.all(
      lifecycleResults.map((result) =>
        writeJson(rootDir, path.join(perAgentReportsDir, `${result.agent_slug}.json`), result),
      ),
    );

    if (publishConfig.enabled) {
      const generatedPaths = lifecycleResults
        .filter((result) => result.generated)
        .map((result) => normalizeRepoPath(path.relative(rootDir, result.generated_artifact_path)));
      publishSummary = publishAutonomousChanges(
        rootDir,
        publishConfig,
        [...(report.mutation_summary.modified_files ?? []), ...generatedPaths],
      );
      report.publish_summary = publishSummary;
    }
  }

  return report;
}

export function parseImproveCatalogArgs(argv) {
  const args = {
    positional: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args.positional.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return {
    agents: args.agents,
    applyRefinements: Boolean(args["apply-refinements"]),
    changed: Boolean(args.changed),
    domain: args.domain,
    force: Boolean(args.force),
    historyPath: args.history,
    maxAgents: args["max-agents"] ? Number(args["max-agents"]) : undefined,
    mode: args.mode ?? "assisted",
    parallelism: args.parallelism ? Number(args.parallelism) : 4,
    policyEngine: {
      ...defaultPolicyEngine,
      auto_run_enabled: args["auto-run-enabled"] ? args["auto-run-enabled"] !== "false" : true,
      health_threshold: args["health-threshold"]
        ? Number(args["health-threshold"])
        : defaultPolicyEngine.health_threshold,
      health_delta_trigger_threshold: args["health-delta-trigger-threshold"]
        ? Number(args["health-delta-trigger-threshold"])
        : defaultPolicyEngine.health_delta_trigger_threshold,
      health_degradation_threshold: args["health-degradation-threshold"]
        ? Number(args["health-degradation-threshold"])
        : defaultPolicyEngine.health_degradation_threshold,
      max_iterations: args["max-iterations"]
        ? Number(args["max-iterations"])
        : defaultPolicyEngine.max_iterations,
      max_total_iterations: args["max-total-iterations"]
        ? Number(args["max-total-iterations"])
        : defaultPolicyEngine.max_total_iterations,
      max_agents_per_run: args["max-agents-per-run"]
        ? Number(args["max-agents-per-run"])
        : defaultPolicyEngine.max_agents_per_run,
      max_parallel_agents: args["max-parallel-agents"]
        ? Number(args["max-parallel-agents"])
        : defaultPolicyEngine.max_parallel_agents,
      regression_threshold: args["regression-threshold"]
        ? Number(args["regression-threshold"])
        : defaultPolicyEngine.regression_threshold,
      auto_apply_threshold: args["auto-apply-threshold"]
        ? Number(args["auto-apply-threshold"])
        : defaultPolicyEngine.auto_apply_threshold,
      escalation_threshold: args["escalation-threshold"]
        ? Number(args["escalation-threshold"])
        : defaultPolicyEngine.escalation_threshold,
      optimization_enabled: args["optimization-enabled"]
        ? args["optimization-enabled"] !== "false"
        : defaultPolicyEngine.optimization_enabled,
      optimization_target: args["optimization-target"]
        ? Number(args["optimization-target"])
        : defaultPolicyEngine.optimization_target,
      max_optimization_iterations: args["max-optimization-iterations"]
        ? Number(args["max-optimization-iterations"])
        : defaultPolicyEngine.max_optimization_iterations,
      low_risk_optimization_enabled: args["low-risk-optimization-enabled"]
        ? args["low-risk-optimization-enabled"] !== "false"
        : defaultPolicyEngine.low_risk_optimization_enabled,
      low_risk_confidence_threshold: args["low-risk-confidence-threshold"]
        ? Number(args["low-risk-confidence-threshold"])
        : defaultPolicyEngine.low_risk_confidence_threshold,
      full_autonomous_confidence_threshold: args["full-autonomous-confidence-threshold"]
        ? Number(args["full-autonomous-confidence-threshold"])
        : defaultPolicyEngine.full_autonomous_confidence_threshold,
      max_expected_improvement_for_low_risk: args["max-expected-improvement-for-low-risk"]
        ? Number(args["max-expected-improvement-for-low-risk"])
        : defaultPolicyEngine.max_expected_improvement_for_low_risk,
      max_low_risk_targets_per_agent: args["max-low-risk-targets-per-agent"]
        ? Number(args["max-low-risk-targets-per-agent"])
        : defaultPolicyEngine.max_low_risk_targets_per_agent,
      max_low_risk_applies_per_run: args["max-low-risk-applies-per-run"]
        ? Number(args["max-low-risk-applies-per-run"])
        : defaultPolicyEngine.max_low_risk_applies_per_run,
      min_projected_improvement: args["min-projected-improvement"]
        ? Number(args["min-projected-improvement"])
        : defaultPolicyEngine.min_projected_improvement,
      regression_soft_limit: args["regression-soft-limit"]
        ? Number(args["regression-soft-limit"])
        : defaultPolicyEngine.regression_soft_limit,
      regression_hard_limit: args["regression-hard-limit"]
        ? Number(args["regression-hard-limit"])
        : defaultPolicyEngine.regression_hard_limit,
      base_budget: args["base-budget"]
        ? Number(args["base-budget"])
        : defaultPolicyEngine.base_budget,
      min_budget: args["min-budget"]
        ? Number(args["min-budget"])
        : defaultPolicyEngine.min_budget,
      max_budget: args["max-budget"]
        ? Number(args["max-budget"])
        : defaultPolicyEngine.max_budget,
      max_optimizations_per_agent_per_run: args["max-optimizations-per-agent-per-run"]
        ? Number(args["max-optimizations-per-agent-per-run"])
        : defaultPolicyEngine.max_optimizations_per_agent_per_run,
      cooldown_runs: args["cooldown-runs"]
        ? Number(args["cooldown-runs"])
        : defaultPolicyEngine.cooldown_runs,
      min_applies_per_run: args["min-applies-per-run"]
        ? Number(args["min-applies-per-run"])
        : defaultPolicyEngine.min_applies_per_run,
      adaptive_budget_floor: args["adaptive-budget-floor"]
        ? Number(args["adaptive-budget-floor"])
        : defaultPolicyEngine.adaptive_budget_floor,
      oscillation_ttl_runs: args["oscillation-ttl-runs"]
        ? Number(args["oscillation-ttl-runs"])
        : defaultPolicyEngine.oscillation_ttl_runs,
      max_recovered_agents_per_run: args["max-recovered-agents-per-run"]
        ? Number(args["max-recovered-agents-per-run"])
        : defaultPolicyEngine.max_recovered_agents_per_run,
      oscillation_low_gain_limit: args["oscillation-low-gain-limit"]
        ? Number(args["oscillation-low-gain-limit"])
        : defaultPolicyEngine.oscillation_low_gain_limit,
      codegen_mode: args["codegen-mode"]
        ? String(args["codegen-mode"])
        : defaultPolicyEngine.codegen_mode,
      top_refinement_targets_per_iteration: args["top-refinement-targets-per-iteration"]
        ? Number(args["top-refinement-targets-per-iteration"])
        : defaultPolicyEngine.top_refinement_targets_per_iteration,
      max_spec_refinement_iterations: args["max-spec-refinement-iterations"]
        ? Number(args["max-spec-refinement-iterations"])
        : defaultPolicyEngine.max_spec_refinement_iterations,
      runtime_feedback_priority_multiplier: args["runtime-feedback-priority-multiplier"]
        ? Number(args["runtime-feedback-priority-multiplier"])
        : defaultPolicyEngine.runtime_feedback_priority_multiplier,
      min_improvement_threshold: args["min-improvement-threshold"]
        ? Number(args["min-improvement-threshold"])
        : defaultPolicyEngine.min_improvement_threshold,
    },
    reportPath: args.report,
    rootDir: args.root,
    runtimeFeedbackPath: args["runtime-feedback"],
    publish: Boolean(args.publish),
    publishBase: args["publish-base"],
    publishBranch: args["publish-branch"],
    publishCommitMessage: args["publish-commit-message"],
    publishPrBody: args["publish-pr-body"],
    publishPrTitle: args["publish-pr-title"],
    trigger: args.trigger,
    validationProfile: args["validation-profile"] ?? "strict",
    generatedAgentsDir: args["generated-agents-dir"],
  };
}
