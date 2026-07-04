#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  analyzeImprovementHistory,
  defaultPaths,
  loadImprovementHistory,
} from "./lib/catalog-improvement.mjs";

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
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

  return args;
}

const args = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(args.root ?? process.cwd());
const historyPath = path.resolve(rootDir, args.history ?? defaultPaths.history);
const outputPath = path.resolve(rootDir, args.report ?? defaultPaths.analysis);

const history = loadImprovementHistory(historyPath);
const analysis = analyzeImprovementHistory(history);

await import("node:fs/promises").then(({ writeFile, mkdir }) =>
  mkdir(path.dirname(outputPath), { recursive: true }).then(() =>
    writeFile(outputPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8"),
  ),
);

process.stdout.write(
  `Improvement History Analysis\n` +
    `Runs: ${analysis.run_count}\n` +
    `Trend: ${analysis.health_trend.trend} (${analysis.health_trend.delta})\n` +
    `Patterns: ${analysis.patterns.length}\n`,
);
