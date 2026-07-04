#!/usr/bin/env node
/**
 * print-app-token.mjs
 *
 * Mints (or reuses a cached, still-valid) olf-keeper GitHub App installation
 * token and prints it to stdout — nothing else. Called from entrypoint.sh at
 * the top of each pass so `GH_TOKEN` stays fresh across the container's
 * entire lifetime (installation tokens expire after 1 hour; the catalog and
 * security loops run far less often than that).
 */

import { ensureGithubAppAuth, githubAppAuthConfigured } from "./lib/github-app-auth.mjs";

if (!githubAppAuthConfigured(process.env)) {
  console.error("GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY_PATH not set — nothing to print.");
  process.exit(1);
}

await ensureGithubAppAuth(process.env);
process.stdout.write(process.env.GH_TOKEN);
