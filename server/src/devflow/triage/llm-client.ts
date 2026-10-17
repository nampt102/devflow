// Thin OpenAI-compatible /chat/completions client (commercial API or vLLM, same config; ADR D6).
// No tools are offered to the model, so prompt injection can change text but cannot trigger actions.
// Request and response bodies are never logged; callers log only the error kind.

export type LlmErrorKind = "timeout" | "network" | "rate_limited" | "server_error" | "client_error" | "truncated" | "empty";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    readonly retryAfterMs?: number,
  ) {
    super(`llm ${kind}`);
    this.name = "LlmError";
  }
}

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  // json_schema support differs between vLLM versions and providers (unverified), so it is opt-in.
  responseFormat: "none" | "json_object" | "json_schema";
  // merged into the request body, e.g. {"chat_template_kwargs":{"enable_thinking":false}} for Qwen3 on vLLM
  extraBody?: Record<string, unknown>;
}

export interface LlmResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestId: string | null;
  latencyMs: number;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv): LlmConfig | null {
  const baseUrl = env.DEVFLOW_LLM_BASE_URL?.trim();
  const model = env.DEVFLOW_LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  const format = env.DEVFLOW_LLM_RESPONSE_FORMAT?.trim() || "json_object";
  if (format !== "none" && format !== "json_object" && format !== "json_schema") {
    throw new Error("DEVFLOW_LLM_RESPONSE_FORMAT must be none, json_object or json_schema");
  }
  let extraBody: Record<string, unknown> | undefined;
  if (env.DEVFLOW_LLM_EXTRA_BODY?.trim()) {
    const parsed = JSON.parse(env.DEVFLOW_LLM_EXTRA_BODY);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DEVFLOW_LLM_EXTRA_BODY must be a JSON object");
    extraBody = parsed;
  }
  return {
    extraBody,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env.DEVFLOW_LLM_API_KEY?.trim() || undefined,
    model,
    timeoutMs: Number(env.DEVFLOW_LLM_TIMEOUT_MS) || 60_000,
    maxOutputTokens: Number(env.DEVFLOW_LLM_MAX_OUTPUT_TOKENS) || 1_500,
    responseFormat: format,
  };
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(at - Date.now(), 0), 3_600_000);
}

/** Drop a leading <think>…</think> block (reasoning models without a server-side parser). null = block never closed. */
export function stripThinking(text: string): string | null {
  const t = text.trimStart();
  if (!/^<think>/i.test(t)) return text;
  const end = t.search(/<\/think>/i);
  return end === -1 ? null : t.slice(end + "</think>".length).trim();
}

export async function chatJson(
  config: LlmConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  jsonSchema?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmResult> {
  const body: Record<string, unknown> = {
    ...config.extraBody,
    model: config.model,
    messages,
    temperature: 0,
    max_tokens: config.maxOutputTokens,
  };
  if (config.responseFormat === "json_object") body.response_format = { type: "json_object" };
  if (config.responseFormat === "json_schema" && jsonSchema) {
    body.response_format = { type: "json_schema", json_schema: { name: "triage", strict: true, schema: jsonSchema } };
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    throw new LlmError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  if (res.status === 429) throw new LlmError("rate_limited", retryAfterMs(res.headers.get("retry-after")));
  if (res.status >= 500) throw new LlmError("server_error");
  if (!res.ok) throw new LlmError("client_error");

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new LlmError("empty");
  }
  const choice = json?.choices?.[0];
  const raw = choice?.message?.content;
  if (typeof raw !== "string" || raw.trim() === "") throw new LlmError("empty");
  if (choice.finish_reason === "length") throw new LlmError("truncated");
  const content = stripThinking(raw);
  if (content === null) throw new LlmError("truncated");
  if (content === "") throw new LlmError("empty");
  return {
    content,
    model: typeof json.model === "string" ? json.model : config.model,
    inputTokens: Number(json.usage?.prompt_tokens) || 0,
    outputTokens: Number(json.usage?.completion_tokens) || 0,
    requestId: typeof json.id === "string" ? json.id.slice(0, 250) : null,
    latencyMs: Date.now() - started,
  };
}
