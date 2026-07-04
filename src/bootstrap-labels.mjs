#!/usr/bin/env node
/**
 * bootstrap-labels.mjs
 *
 * Creates or updates GitHub labels in the target repo from config/github-labels.json.
 * Run this once before commons-keeper creates its first spec-pack issues.
 *
 * Usage:
 *   node src/bootstrap-labels.mjs [--repo <owner/repo>] [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const dryRun = process.argv.includes("--dry-run");

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const targetRepo = getArg("--repo", process.env.TARGET_REPO ?? "Open-Labor-Foundation/labor-commons");
const labelsPath = path.join(repoRoot, "config", "github-labels.json");

if (!fs.existsSync(labelsPath)) {
  console.error(`Labels config not found: ${labelsPath}`);
  process.exit(1);
}

const labels = JSON.parse(fs.readFileSync(labelsPath, "utf8"));

console.log(`Bootstrapping ${labels.length} labels → ${targetRepo}`);
if (dryRun) console.log("DRY RUN — no labels will be created or updated\n");

function getExistingLabels() {
  try {
    const out = execFileSync("gh", [
      "label", "list",
      "--repo", targetRepo,
      "--limit", "500",
      "--json", "name,color,description",
    ], { encoding: "utf8" });
    return new Map(JSON.parse(out).map((l) => [l.name, l]));
  } catch {
    console.error("Warning: could not fetch existing labels");
    return new Map();
  }
}

const existing = getExistingLabels();
let created = 0;
let updated = 0;
let skipped = 0;

for (const label of labels) {
  const current = existing.get(label.name);
  const colorWithHash = label.color.startsWith("#") ? label.color : `#${label.color}`;
  const normalizedColor = label.color.replace(/^#/, "").toLowerCase();
  const existingColor = (current?.color ?? "").replace(/^#/, "").toLowerCase();

  if (current) {
    const needsUpdate = existingColor !== normalizedColor ||
      (current.description ?? "") !== (label.description ?? "");

    if (!needsUpdate) {
      console.log(`  skip (matches): ${label.name}`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  [dry-run] Would update: ${label.name}`);
      updated++;
      continue;
    }

    try {
      execFileSync("gh", [
        "label", "edit", label.name,
        "--repo", targetRepo,
        "--color", colorWithHash,
        "--description", label.description ?? "",
      ], { stdio: "pipe" });
      console.log(`  updated: ${label.name}`);
      updated++;
    } catch (err) {
      console.error(`  failed to update "${label.name}": ${err.message}`);
    }
  } else {
    if (dryRun) {
      console.log(`  [dry-run] Would create: ${label.name}`);
      created++;
      continue;
    }

    try {
      execFileSync("gh", [
        "label", "create", label.name,
        "--repo", targetRepo,
        "--color", colorWithHash,
        "--description", label.description ?? "",
      ], { stdio: "pipe" });
      console.log(`  created: ${label.name}`);
      created++;
    } catch (err) {
      console.error(`  failed to create "${label.name}": ${err.message}`);
    }
  }
}

console.log(`\nDone. Created: ${created}, Updated: ${updated}, Skipped (unchanged): ${skipped}`);
