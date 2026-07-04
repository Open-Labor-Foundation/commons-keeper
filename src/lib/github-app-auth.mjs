/**
 * github-app-auth.mjs
 *
 * Lets commons-keeper authenticate to GitHub as the dedicated `olf-keeper`
 * App installation instead of a personal access token, so commits/PRs/
 * advisories/issues are attributed to the app, not whoever's PAT happened to
 * be in GH_TOKEN. Installation access tokens expire after 1 hour, so this
 * mints one, caches it, and re-mints only once the cached token is close to
 * expiring — then sets it as GH_TOKEN/GITHUB_TOKEN so every existing `gh`/
 * `git` call site picks it up for free through normal environment
 * inheritance, no call-site changes required.
 *
 * Ported from commons-devloop/scripts/lib/github-app-auth.mjs, same pattern.
 */

import crypto from "node:crypto";
import fs from "node:fs";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const JWT_LIFETIME_SECONDS = 600;

let cachedToken = null;
let cachedExpiresAtMs = 0;

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iat: now - 60,
    exp: now + JWT_LIFETIME_SECONDS,
    iss: String(appId)
  }));
  const signingInput = `${header}.${payload}`;
  const signature = base64url(crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKeyPem));
  return `${signingInput}.${signature}`;
}

export function githubAppAuthConfigured(env = process.env) {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_PATH);
}

/**
 * Ensures env.GH_TOKEN/GITHUB_TOKEN hold a currently-valid GitHub App
 * installation token. Returns false (no-op) if app auth isn't configured;
 * throws if it's configured but minting a token fails, so callers see a
 * real auth failure rather than silently falling back to a stale token.
 */
export async function ensureGithubAppAuth(env = process.env, { fetchImpl = fetch } = {}) {
  if (!githubAppAuthConfigured(env)) {
    return false;
  }

  const nowMs = Date.now();
  if (!cachedToken || nowMs >= cachedExpiresAtMs - REFRESH_BUFFER_MS) {
    const privateKeyPem = fs.readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
    const jwt = buildAppJwt(env.GITHUB_APP_ID, privateKeyPem);

    const response = await fetchImpl(
      `https://api.github.com/app/installations/${String(env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to mint GitHub App installation token (${response.status}): ${text}`);
    }

    const body = await response.json();
    cachedToken = body.token;
    cachedExpiresAtMs = new Date(body.expires_at).getTime();
  }

  env.GH_TOKEN = cachedToken;
  env.GITHUB_TOKEN = cachedToken;
  return true;
}
