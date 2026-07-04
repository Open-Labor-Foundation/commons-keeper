# commons-keeper

The autonomous maintenance loop for the Open Labor Foundation stack.
commons-keeper runs two independent loops for as long as its container is
up: one validating and scoring the
[labor-commons](https://github.com/Open-Labor-Foundation/labor-commons)
catalog, and one reviewing every OLF repo for newly introduced security
issues.

This is maintenance infrastructure. It runs on the stack, not in it.

---

## What it does

### Catalog loop

Each pass through the catalog, commons-keeper:

1. Validates every specialist definition against the schema — catching structural errors, missing required fields, and definition drift
2. Scores catalog health across validation correctness, readiness completeness, and best-practice alignment
3. Detects regressions against stored history
4. Applies safe, deterministic refinements to definitions that qualify — or surfaces them as recommendations, depending on mode
5. Commits changes to `autonomous/improvements` and maintains a PR into `autonomous/review`

### Security review loop

Each pass, commons-keeper clones or updates every repo listed in
[`config/security-review-targets.json`](config/security-review-targets.json)
(the full OLF stack) and runs two independent checks per repo:

1. **Code-logic review** — an LLM reasoning pass over whatever code changed
   since the last pass (or, the first time it sees a repo, a bounded first
   look at that repo's current code). Catches logic flaws — auth bypass,
   injection, hardcoded secrets — the same way an interactive review would.
   Needs an LLM key; if none is configured this step is skipped (logged, not
   fatal) rather than blocking the rest of the pass.
2. **Dependency audit** — `npm audit` against the repo's `package-lock.json`,
   which checks currently pinned dependency versions against the GitHub
   Advisory Database — a real, continuously updated CVE/GHSA feed. Runs
   every pass regardless of whether any code changed, since a new advisory
   can apply to a dependency version you haven't touched. Needs no LLM key.
   Skipped for repos with no `package.json`.

Findings that clear their respective thresholds get filed as GitHub issues
(labeled `security`, `human-review`) directly on the repo they were found
in, deduplicated against already-filed issues.

The code-logic pass and the dependency audit check fundamentally different
things and neither substitutes for the other: the LLM pass reasons about
your own code and will never know about a CVE; `npm audit` only knows about
published advisories for third-party packages and will never catch a bug in
code you wrote.

### Dependency mitigation (when there's no upstream fix)

A CVE with no patched version to bump to doesn't just get logged and
dropped. For each such finding on a *direct* dependency, commons-keeper:

1. Scans this repo's own code for where the package is actually imported.
2. Asks the LLM to judge — from that code alone, not assumption — whether
   the vulnerable behavior is reachable, and if so, to propose one of two
   mitigations: a defensive guard around the call site, or, if the package
   isn't imported anywhere at all, removing the unused dependency outright.
3. Only acts if the proposal clears a confidence bar and, for a code guard,
   the exact text it wants to change matches the file precisely once — a
   hallucinated or ambiguous target is rejected, never guessed at.
4. Opens a pull request with the change into that repo's own `main` —
   never merges it, never touches the third-party package's own repository.
   A human reviews and merges it like any other PR.

This stays entirely inside repos the Open Labor Foundation owns. It does
not, and will not, autonomously patch or open PRs against third-party
projects on the public internet — that's a meaningfully different, riskier
capability than anything else commons-keeper does, and hasn't been built.

---

## Modes

| Mode | Behavior |
|---|---|
| `passive` | Monitor and report only |
| `assisted` | Full analysis, recommendations emitted, no changes written |
| `autonomous` | Applies deterministic safe refinements within defined safety thresholds |

---

## Safety thresholds

Autonomous changes only apply when all conditions are met: zero validation errors, zero ambiguity issues, confidence ≥ 0.95, no competing refinement targets. commons-keeper never autonomously rewrites specialist content — that requires human domain knowledge. What it handles autonomously is structural quality and metadata.

---

## Who runs it

The Open Labor Foundation runs commons-keeper against labor-commons as part of ongoing catalog maintenance. It is what keeps the shared catalog accurate and healthy over time.

commons-keeper is open source. Anyone running a fork of labor-commons is free to deploy their own instance against their own catalog. Setup instructions and Docker configuration are below.

---

## Bootstrap

Before commons-keeper can file spec-pack issues, the required GitHub labels must exist in the target repo. Run this once after setting up your `GH_TOKEN`:

```bash
TARGET_REPO=Open-Labor-Foundation/labor-commons node src/bootstrap-labels.mjs
# or via npm:
TARGET_REPO=Open-Labor-Foundation/labor-commons npm run keeper:bootstrap
```

Use `--dry-run` to preview what will be created without making changes.

The security-review loop needs the same `security`, `human-review`, and
`dependency` labels present on every repo it files issues into (or opens
mitigation PRs against), not just the catalog target. Run bootstrap once
per repo in
[`config/security-review-targets.json`](config/security-review-targets.json):

```bash
for repo in labor-commons commons-keeper commons-board commons-crew commons-artifacts open-labor-foundation; do
  TARGET_REPO="Open-Labor-Foundation/$repo" npm run keeper:bootstrap
done
```

---

## Docker

commons-keeper runs as a single long-lived Docker container. The entrypoint starts two independent loops that run for the container's entire lifetime — neither depends on an external cron or scheduler:

| Loop | Default interval | Override |
|---|---|---|
| Catalog (`improve-catalog.mjs` + issue filing) | 1 hour | `KEEPER_CATALOG_INTERVAL_SECONDS` |
| Security review (`security-review.mjs`) | 24 hours | `KEEPER_SECURITY_INTERVAL_SECONDS` |

A failed pass in either loop is logged and retried on its next tick — it doesn't crash the container or block the other loop. State and reports persist via volume mounts at `/commons-keeper/state` and `/commons-keeper/reports`; the security-review loop's per-repo checkouts and last-reviewed-commit state live under `/commons-keeper/state` as well.

```bash
docker build -t commons-keeper .

docker run -d --restart unless-stopped \
  -e GH_TOKEN=<token> \
  -e TARGET_REPO=Open-Labor-Foundation/labor-commons \
  -e KEEPER_MODE=passive \
  -e FEATHERLESS_API_KEY=<key> \
  -v commons-keeper-state:/commons-keeper/state \
  -v commons-keeper-reports:/commons-keeper/reports \
  commons-keeper
```

Copy `.env.example` to `.env` and supply values before running.

---

## Branch strategy

| Branch | Purpose |
|---|---|
| `autonomous/improvements` | commons-keeper commits here each loop |
| `autonomous/review` | PR target — human review before merge to `main` |

---

Part of the [Open Labor Foundation](https://github.com/Open-Labor-Foundation/open-labor-foundation).
