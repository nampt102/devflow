import { LlmError } from "./llm-client.js";

// OpenAI-compatible /embeddings client (TEI, vLLM, OpenAI). Local bge-m3 on TEI is the intended default.

export interface EmbedConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  maxChars: number;
}

export function loadEmbedConfig(env: NodeJS.ProcessEnv): EmbedConfig | null {
  const baseUrl = env.DEVFLOW_EMBED_BASE_URL?.trim();
  const model = env.DEVFLOW_EMBED_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env.DEVFLOW_EMBED_API_KEY?.trim() || undefined,
    model,
    timeoutMs: Number(env.DEVFLOW_EMBED_TIMEOUT_MS) || 30_000,
    maxChars: Number(env.DEVFLOW_EMBED_MAX_CHARS) || 4_000,
  };
}

export async function embedText(
  config: EmbedConfig,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ vector: number[]; tokens: number }> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, input: [text.slice(0, config.maxChars)] }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    throw new LlmError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  if (res.status === 429) throw new LlmError("rate_limited");
  if (res.status >= 500) throw new LlmError("server_error");
  if (!res.ok) throw new LlmError("client_error");
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new LlmError("empty");
  }
  const vector = json?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > 16_000 || !vector.every((x: unknown) => typeof x === "number" && Number.isFinite(x))) {
    throw new LlmError("empty");
  }
  return { vector, tokens: Number(json.usage?.prompt_tokens) || 0 };
}
