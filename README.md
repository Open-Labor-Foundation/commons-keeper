# commons-keeper

The autonomous maintenance loop for the Open Labor Foundation stack.
commons-keeper runs two independent loops for as long as its container is
up: one validating and scoring the
[labor-commons](https://github.com/Open-Labor-Foundation/labor-commons)
catalog, and one reviewing every OLF repo for newly introduced security
issues.

This is maintenance infrastructure. It runs on the stack, not in it.

> See [open-labor-foundation/ARCHITECTURE.md](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/ARCHITECTURE.md)
> for the full ecosystem picture. No architectural shortcoming identified for
> this repo — its independence from what it certifies is by design and is
> expected to remain permanent, unlike commons-devloop.

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
(the full OLF stack) and runs five independent checks per repo:

1. **Code-logic review** — an LLM reasoning pass over whatever code changed
   since the last pass (or, the first time it sees a repo, a bounded first
   look at that repo's current code). Catches logic flaws — auth bypass,
   injection, hardcoded secrets — the same way an interactive review would.
   Needs an LLM key; if none is configured this step is skipped (logged, not
   fatal) rather than blocking the rest of the pass.
2. **SAST** — a [semgrep](https://semgrep.dev/) pass (`p/security-audit` +
   `p/owasp-top-ten` rulesets) over the exact same file scope as the
   code-logic pass. Rule-based, not judgment-based: catches the same broad
   vulnerability classes via fixed pattern matching, with none of an LLM's
   variance. Needs no LLM key.
3. **Secrets scan** — a [gitleaks](https://github.com/gitleaks/gitleaks)
   pass over the full working tree, every pass regardless of whether code
   changed, since it also catches secrets that predate commons-keeper's
   first look at a repo. Purpose-built for this, unlike the code-logic
   pass's incidental "flag hardcoded secrets if you notice one" instruction.
   Findings never include the matched value — only rule id, file, and line;
   any hit files as `critical` severity with a rotate-immediately
   recommendation. Needs no LLM key.
4. **Dependency audit (npm)** — `npm audit` against the repo's
   `package-lock.json`, which checks currently pinned dependency versions
   against the GitHub Advisory Database — a real, continuously updated
   CVE/GHSA feed. Runs every pass regardless of whether any code changed,
   since a new advisory can apply to a dependency version you haven't
   touched. Needs no LLM key. Skipped for repos with no `package.json`.
5. **Dependency audit (other ecosystems)** — an
   [osv-scanner](https://github.com/google/osv-scanner) pass covering
   dependency ecosystems npm audit can't see (Python, Go, etc. —
   `labor-commons` and `commons-artifacts` both carry Python code). Its
   npm-ecosystem results are filtered out, since npm audit already owns
   that ecosystem; osv-scanner only adds coverage npm audit structurally
   can't provide. Needs no LLM key.

Each of the five is individually toggleable off (`--no-sast`,
`--no-secrets-scan`, `--no-osv`, `--no-mitigations`, or the matching
`SECURITY_REVIEW_*` env var — see [`.env.example`](.env.example)) without
disabling the rest of the pass.

Findings that clear their respective thresholds get filed as private draft
GitHub security advisories (the repo's Security tab, not public issues —
an unpatched vulnerability shouldn't be disclosed the moment it's found),
deduplicated against already-filed advisories.

None of the five checks substitutes for another — each catches something
structurally invisible to the rest: the LLM pass reasons about your code's
*logic* but will never know about a CVE or reliably catch every hardcoded
secret; semgrep catches known vulnerability patterns by rule, not by
reasoning about intent; gitleaks is a dedicated, full-tree secrets sweep;
`npm audit` and osv-scanner only know about published advisories for
third-party packages (across different ecosystems) and will never catch a
bug in code you wrote.

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

### PR verification loop

Independent claim-vs-diff review for every open PR across
[`config/security-review-targets.json`](config/security-review-targets.json):
does the PR's own description ("wired in," "automatic," "resolved,"
"verified," "no longer a gap") actually match its diff, or does it ship a
real mechanism with no real caller — a route or field nothing invokes, a
backend capability with no UI path, a doc edited to assert a gap is closed
rather than the gap being closed.

This exists because that exact pattern was found repeatedly, by hand,
across this org's PR history in a single session — see `GOVERNANCE.md`
in `open-labor-foundation`. The check that caught it every time was
structural, not clever: a reviewer with no memory of the authoring
session, given only the claim and the diff, forced to independently
re-derive an answer instead of trusting what was already written down.
This automates exactly that, on a schedule, so it doesn't depend on a
human — or an authoring session — remembering to ask for it.

Each pass, for every open PR not yet reviewed at its current head commit:

1. **Deterministic pre-checks** — cheap, exact, no LLM needed. Does the PR
   body reference another PR number as though it were merged/resolved when
   it's actually still open? Does the diff use reachability language
   ("wired in," "automatic") while touching only backend files, on a repo
   with a real end-user UI, with nothing under that UI's directory?
2. **LLM claim-vs-diff pass** — given only the PR's title, description,
   and diff (no other context), checks every "done/resolved/verified"
   claim against what the diff actually delivers. Needs an LLM key; if
   none is configured this step is skipped (logged, not fatal) and the
   deterministic checks still run.

Findings that clear the confidence threshold get posted as a PR comment —
not a silent log, not a merge block (commons-keeper has no merge
authority anywhere in this repo) — the same "surfaced, not silently
resolved" principle `GOVERNANCE.md` states for disagreement generally.

**Scope, stated plainly:** this is a single structured LLM pass over the
diff and description, plus the two deterministic pre-checks above. It is
**not** a full agentic reviewer with repo tool access — it can't
dynamically grep the rest of a repo, run a test suite, or verify a claim
that depends on cross-file state the diff alone doesn't show. That's a
real capability gap, not closed here; it's the natural next extension if
this proves out.

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

commons-keeper runs as a single long-lived Docker container. The entrypoint starts three independent loops that run for the container's entire lifetime — none depends on an external cron or scheduler:

| Loop | Default interval | Override |
|---|---|---|
| Catalog (`improve-catalog.mjs` + issue filing) | 1 hour | `KEEPER_CATALOG_INTERVAL_SECONDS` |
| Security review (`security-review.mjs`) | 24 hours | `KEEPER_SECURITY_INTERVAL_SECONDS` |
| PR verification (`pr-verification.mjs`) | 30 minutes | `KEEPER_PR_VERIFICATION_INTERVAL_SECONDS` |

A failed pass in any loop is logged and retried on its next tick — it doesn't crash the container or block the other loops. State and reports persist via volume mounts at `/commons-keeper/state` and `/commons-keeper/reports`; the security-review loop's per-repo checkouts and last-reviewed-commit state, and the PR-verification loop's per-PR last-reviewed-commit state, both live under `/commons-keeper/state` as well.

The container runs as the base image's built-in non-root `node` user (uid 1000), not root — this process clones other repos and runs several third-party scanners against them, so it shouldn't hold more filesystem privilege than it needs. Named volumes (as in the example below) pick up the right ownership automatically; if you bind-mount host directories instead, `chown` them to uid 1000 first. If you're using `GITHUB_APP_PRIVATE_KEY_PATH`, make sure the key file is readable by uid 1000 on the host.

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
