#!/usr/bin/env node

import process from "node:process";

import {
  formatImprovementSummary,
  parseImproveCatalogArgs,
  runCatalogImprovement,
} from "./lib/catalog-improvement.mjs";

function usage() {
  process.stdout.write(`Usage:
  node infra/scripts/improve-catalog.mjs
  node infra/scripts/improve-catalog.mjs --agents slug1,slug2
  node infra/scripts/improve-catalog.mjs --domain <domain>
  node infra/scripts/improve-catalog.mjs --mode <passive|assisted|autonomous> [--changed] [--force] [--trigger <manual|schedule>] [--parallelism <n>] [--validation-profile <profile>] [--codegen-mode <none|ready_only|forced_and_ready>] [--runtime-feedback <path>] [--history <path>] [--report <path>] [--generated-agents-dir <path>] [--apply-refinements] [--publish] [--publish-branch <branch>] [--publish-base <branch>]
`);
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  usage();
  process.exit(0);
}

const options = parseImproveCatalogArgs(rawArgs);
const report = await runCatalogImprovement(options);
process.stdout.write(formatImprovementSummary(report));
