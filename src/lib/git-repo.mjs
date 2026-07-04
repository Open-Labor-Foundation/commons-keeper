/**
 * git-repo.mjs
 *
 * Shared git/file-scanning helpers for the multi-repo security tooling —
 * array-args execFileSync only, never shell string interpolation, so none
 * of this is exposed to command injection regardless of what a package
 * name, branch name, or file path happens to contain.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function cloneOrUpdate(cloneUrl, workDir) {
  if (fs.existsSync(path.join(workDir, ".git"))) {
    runGit(workDir, ["fetch", "--depth=200", "origin", "main"]);
  } else {
    fs.mkdirSync(path.dirname(workDir), { recursive: true });
    runGit(path.dirname(workDir), ["clone", "--depth=200", cloneUrl, workDir]);
    runGit(workDir, ["fetch", "--depth=200", "origin", "main"]);
  }
  // Always land back on main synced with origin, regardless of what branch a
  // prior pass (e.g. a dependency-mitigation branch) left checked out.
  runGit(workDir, ["checkout", "-B", "main", "origin/main"]);
  return runGit(workDir, ["rev-parse", "HEAD"]).trim();
}

export function listAllTrackedFiles(workDir) {
  return runGit(workDir, ["ls-files"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function listChangedFiles(workDir, sinceSha, headSha) {
  if (sinceSha === headSha) return [];
  try {
    return runGit(workDir, ["diff", "--name-only", `${sinceSha}..${headSha}`])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // sinceSha no longer reachable (force-push, history rewrite) — fall back
    // to a fresh baseline rather than erroring the whole run.
    return null;
  }
}

export function buildDiffText(workDir, sinceSha, headSha, files) {
  if (files.length === 0) return "";
  return runGit(workDir, ["diff", "--unified=3", `${sinceSha}..${headSha}`, "--", ...files]);
}

export function isCodeFile(relPath, target) {
  if ((target.codeFiles ?? []).includes(relPath)) return true;
  const ext = path.extname(relPath);
  if (!(target.codeExtensions ?? []).includes(ext)) return false;
  return (target.codeDirs ?? []).some((dir) => relPath === dir || relPath.startsWith(`${dir}/`));
}

export function chunkFilesByContent(workDir, files, maxCharsPerChunk) {
  const chunks = [];
  let current = [];
  let currentSize = 0;
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(workDir, file), "utf8");
    } catch {
      continue;
    }
    const entrySize = content.length + file.length + 32;
    if (currentSize + entrySize > maxCharsPerChunk && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push({ file, content });
    currentSize += entrySize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function renderFileChunkText(chunk) {
  return chunk.map(({ file, content }) => `--- FILE: ${file} ---\n${content}`).join("\n\n");
}

export function chunkDiffText(diffText, maxCharsPerChunk) {
  if (diffText.length <= maxCharsPerChunk) return diffText ? [diffText] : [];
  const perFileDiffs = diffText.split(/(?=^diff --git )/m).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const entry of perFileDiffs) {
    if (current.length + entry.length > maxCharsPerChunk && current) {
      chunks.push(current);
      current = "";
    }
    current += entry;
  }
  if (current) chunks.push(current);
  return chunks;
}
