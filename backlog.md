# commons-keeper backlog

---

## BACKLOG-001: Decay detection and renewal enforcement

commons-keeper detects stale specialist definitions in the labor-commons catalog and drives the renewal process — from first flag through escalation to resolution.

**Why:** The decay counter (labor-commons BACKLOG-001) only works if something enforces it. commons-keeper is the natural enforcement point: it already runs continuously against the catalog, already scores health, and already has a three-tier escalation model. Decay enforcement is an extension of that loop, not a separate system.

**Detection:**

Each pass, commons-keeper reads every spec's `freshness.stale_after` date against the current date:

- `stale_after` in the past by 0–30 days → `stale`, surface in report, open a renewal issue
- `stale_after` in the past by 30+ days without a renewal PR → `expired`, escalate
- No `freshness` block present → treat as missing required field, flag as a validation error

**Health scoring:**

Stale and expired specs contribute to catalog health degradation:

- Each `stale` spec subtracts from the catalog health score
- Each `expired` spec triggers the same repair escalation path as a regression (`health delta <= -2`)
- A domain with multiple expired specs triggers full-domain review

**Renewal issues:**

When commons-keeper flags a spec as stale, it opens a renewal issue in the labor-commons repo with:

- the spec slug
- the domain
- `last_reviewed` and `stale_after` dates
- a checklist: review for domain changes, update content if needed, update `last_reviewed`, submit PR

**Autonomous behavior:**

commons-keeper does not autonomously update spec content — renewal requires human domain knowledge. What it *can* do autonomously (within confidence threshold):

- Update `freshness.status` from `current` to `stale` or `expired` as time passes
- Close renewal issues when a PR merges with an updated `last_reviewed`
- Reset the `stale_after` computed date after a successful renewal

**Related:** labor-commons BACKLOG-001 defines the `freshness` schema that this enforcement reads.
