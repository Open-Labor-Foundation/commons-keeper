/**
 * llm-client.mjs
 *
 * Shared OpenAI-compatible chat-completions client used by every LLM-backed
 * pass (security-review.mjs, dependency-mitigation.mjs). One place for the
 * request shape and JSON-extraction helpers so each caller only supplies its
 * own system/user prompt.
 */

export const DEFAULT_BASE_URL = "https://api.featherless.ai/v1";
export const DEFAULT_MODEL = "Qwen/Qwen3-32B";

// Serverless model hosts (Featherless included) can cold-start a rarely-used
// model on first request; the gateway itself timed out around 60s in
// practice. But a request can also just hang with no response at all — no
// error, no timeout — so a client-side abort is the only thing that
// guarantees this doesn't block the whole multi-repo pass indefinitely.
const DEFAULT_TIMEOUT_MS = 120_000;

export async function callChatModel({ systemPrompt, userPrompt, apiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`LLM call timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`LLM call failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export function extractJsonArray(content) {
  const match = content.match(/\[\s*(?:\{[\s\S]*\}\s*,?\s*)*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function extractJsonObject(content) {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
