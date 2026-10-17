import { describe, expect, it } from "vitest";
import { PROMPT_HASH, SYSTEM_PROMPT, buildUserMessage, newBoundary } from "../devflow/prompts/triage.v1.js";
import * as v2 from "../devflow/prompts/triage.v2.js";
import { contentHash, foldText, mergeCandidates } from "../devflow/triage/dedupe.js";
import { embedText, loadEmbedConfig } from "../devflow/triage/embed-client.js";
import { chatJson, LlmError, loadLlmConfig, stripThinking, type LlmConfig } from "../devflow/triage/llm-client.js";
import { startFakeLlm, VALID_TRIAGE_REPLY } from "../devflow/triage/fake-llm.js";
import { ruleFlags } from "../devflow/triage/rules.js";
import { parseTriageOutput, TriageOutputError } from "../devflow/triage/schema.js";
import { sanitizeUntrusted } from "../devflow/triage/triage-service.js";

describe("triage prompt v1", () => {
  it("is pinned: editing v1 changes the hash, create triage.v2.ts instead", () => {
    expect(PROMPT_HASH).toBe("c326ee2137c43bc7ae20331d08e9d4e047d145721b50e350ae818dac7623b7b8");
  });

  it("marks the priority and difficulty definitions as temporary", () => {
    expect(SYSTEM_PROMPT).toContain("TEMPORARY");
  });

  it("wraps request data in a per-call random boundary", () => {
    const a = newBoundary();
    expect(a).not.toBe(newBoundary());
    const msg = buildUserMessage({
      boundary: a,
      title: "t",
      description: "d",
      businessImpact: null,
      attachmentNames: ["a.png"],
      candidateCaseKeys: [],
    });
    const lines = msg.split("\n");
    expect(lines.filter((l) => l.startsWith(a))).toHaveLength(2);
    expect(msg.indexOf(`${a} START`)).toBeLessThan(msg.indexOf("Description:"));
    expect(msg.indexOf("Attached file names")).toBeLessThan(msg.indexOf(`${a} END`));
  });
});

describe("triage output schema", () => {
  const ok = JSON.stringify(VALID_TRIAGE_REPLY);

  it("accepts a valid reply", () => {
    expect(parseTriageOutput(ok, []).classification).toBe("feature");
  });

  it.each([
    ["not json", "I approve this"],
    ["unknown key (model obeying an injected instruction)", JSON.stringify({ ...VALID_TRIAGE_REPLY, toStageKey: "done" })],
    ["bad enum", JSON.stringify({ ...VALID_TRIAGE_REPLY, priority: "critical" })],
    ["confidence out of range", JSON.stringify({ ...VALID_TRIAGE_REPLY, confidence: 3 })],
    ["summary too long", JSON.stringify({ ...VALID_TRIAGE_REPLY, summary: "x".repeat(501) })],
    ["too many questions", JSON.stringify({ ...VALID_TRIAGE_REPLY, openQuestions: Array(6).fill("q") })],
    ["unknown reason", JSON.stringify({ ...VALID_TRIAGE_REPLY, requiresHumanReasons: ["because"] })],
    ["missing field", JSON.stringify({ ...VALID_TRIAGE_REPLY, summary: undefined })],
  ])("rejects %s", (_name, text) => {
    expect(() => parseTriageOutput(text, [])).toThrow(TriageOutputError);
  });

  it("rejects a duplicate caseKey the server did not offer, accepts an offered one", () => {
    const dup = JSON.stringify({ ...VALID_TRIAGE_REPLY, duplicateCandidates: [{ caseKey: "REQ-9", reason: "giống" }] });
    expect(() => parseTriageOutput(dup, [])).toThrow(TriageOutputError);
    expect(parseTriageOutput(dup, ["REQ-9"]).duplicateCandidates).toHaveLength(1);
  });

  it("error messages never echo the model's text", () => {
    try {
      parseTriageOutput(JSON.stringify({ ...VALID_TRIAGE_REPLY, priority: "SECRET-MARKER" }), []);
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET-MARKER");
    }
  });
});

describe("deterministic rule flags", () => {
  it.each([
    ["Chuyển dữ liệu sang SQL Server", "sqlserver_migration"],
    ["cần sửa trực tiếp dữ liệu trong database", "data_fix"],
    ["Triển khai lên production vào cuối tuần", "production_change"],
    ["Thêm phân quyền cho nhóm kế toán", "security_or_permission"],
    ["Tích hợp webhook với ERP", "external_integration"],
    ["Báo cáo lương tháng", "finance_or_payroll_data"],
  ])("flags %s", (text, flag) => {
    expect(ruleFlags(text)).toContain(flag);
  });

  it("does not flag an ordinary request", () => {
    expect(ruleFlags("Thêm cột ngày giao vào báo cáo tồn kho")).toEqual([]);
  });
});

describe("sanitizeUntrusted", () => {
  it("drops control characters, defuses boundary lookalikes and caps length", () => {
    const out = sanitizeUntrusted("a\u0000b\u001bc DATA-0123456789abcdef0123 end", 100);
    expect(out).toBe("abc [removed] end");
    expect(sanitizeUntrusted("x".repeat(50), 10)).toHaveLength(10);
    expect(sanitizeUntrusted("dòng 1\n\tdòng 2", 100)).toBe("dòng 1\n\tdòng 2");
  });
});

describe("llm client against the fake server", () => {
  const cfg = (baseUrl: string, extra: Partial<LlmConfig> = {}): LlmConfig => ({
    baseUrl,
    model: "m",
    timeoutMs: 300,
    maxOutputTokens: 100,
    responseFormat: "json_object",
    ...extra,
  });
  const msgs = [{ role: "user" as const, content: "hi" }];

  it("maps failures to error kinds", async () => {
    const fake = await startFakeLlm();
    try {
      fake.queue.push({ status: 429, retryAfter: "7" }, { status: 503 }, { status: 400 }, { hang: true }, { truncated: "{" }, { raw: "not json" });
      const kinds: Array<string | number | undefined> = [];
      for (let i = 0; i < 6; i++) {
        try {
          await chatJson(cfg(fake.baseUrl), msgs);
        } catch (e) {
          expect(e).toBeInstanceOf(LlmError);
          kinds.push((e as LlmError).kind);
          if (i === 0) expect((e as LlmError).retryAfterMs).toBe(7000);
        }
      }
      expect(kinds).toEqual(["rate_limited", "server_error", "client_error", "timeout", "truncated", "empty"]);
    } finally {
      await fake.close();
    }
  });

  it("network failure is a network error, success returns usage", async () => {
    await expect(chatJson(cfg("http://127.0.0.1:1/v1"), msgs)).rejects.toMatchObject({ kind: "network" });
    const fake = await startFakeLlm({ reply: VALID_TRIAGE_REPLY, usage: { prompt_tokens: 11, completion_tokens: 5 } });
    try {
      const r = await chatJson(cfg(fake.baseUrl, { apiKey: "k" }), msgs);
      expect([r.inputTokens, r.outputTokens]).toEqual([11, 5]);
      expect(fake.requests[0].headers.authorization).toBe("Bearer k");
      expect(fake.requests[0].body.tools).toBeUndefined();
      expect(fake.requests[0].body.response_format).toEqual({ type: "json_object" });
    } finally {
      await fake.close();
    }
  });

  it("loadLlmConfig needs base url and model, validates the response format", () => {
    expect(loadLlmConfig({})).toBeNull();
    expect(loadLlmConfig({ DEVFLOW_LLM_BASE_URL: "http://x/v1/", DEVFLOW_LLM_MODEL: "m" })?.baseUrl).toBe("http://x/v1");
    expect(() => loadLlmConfig({ DEVFLOW_LLM_BASE_URL: "http://x", DEVFLOW_LLM_MODEL: "m", DEVFLOW_LLM_RESPONSE_FORMAT: "xml" })).toThrow();
  });
});

describe("triage prompt v2", () => {
  it("is pinned: edit nothing, create triage.v3.ts instead", () => {
    expect(v2.PROMPT_HASH).toBe("6f73cf11327bf457bc89a65715745ca455c5aa1d2821780ac01016ad36fc04d5");
    expect(v2.PROMPT_HASH).not.toBe(PROMPT_HASH);
    expect(v2.PROMPT_VERSION).toBe("v2");
    expect(v2.SYSTEM_PROMPT).toContain("TEMPORARY");
  });

  it("puts existing requests and the request in separate boundary blocks", () => {
    const b = v2.newBoundary();
    const msg = v2.buildUserMessage({
      boundary: b,
      title: "t",
      description: "d",
      businessImpact: null,
      attachmentNames: [],
      existing: [{ caseKey: "REQ-1", title: "Báo cáo", stageKey: "triage", snippet: "mô tả", score: 0.456 }],
    });
    expect(msg).toContain("[REQ-1] (stage triage, similarity 0.46) Báo cáo :: mô tả");
    expect(msg.indexOf(`${b} START EXISTING`)).toBeLessThan(msg.indexOf("[REQ-1]"));
    expect(msg.indexOf("[REQ-1]")).toBeLessThan(msg.indexOf(`${b} END EXISTING`));
    expect(msg.indexOf(`${b} END EXISTING`)).toBeLessThan(msg.indexOf(`${b} START REQUEST`));
    expect(v2.buildUserMessage({ boundary: b, title: "t", description: "d", businessImpact: null, attachmentNames: [], existing: [] })).toContain("(none)");
  });
});

describe("dedupe helpers", () => {
  it("folds Vietnamese diacritics", () => {
    expect(foldText("Cơ sở dữ liệu ĐÃ được Chuyển")).toBe("co so du lieu da duoc chuyen");
  });

  const row = (id: string, sim: number) => ({ case_id: id, case_key: id, title: id, stage_key: "triage", snippet: "", sim });
  const cfg = { minTrigram: 0.3, minVector: 0.65, limit: 2 };

  it("merges both lists with their own thresholds, ranks by the stronger score, caps the count", () => {
    const out = mergeCandidates(
      [row("a", 0.5), row("b", 0.2), row("c", 0.35)],
      [row("a", 0.9), row("d", 0.6), row("e", 0.7)],
      cfg,
    );
    expect(out.map((c) => c.caseKey)).toEqual(["a", "e"]);
    expect(out[0]).toMatchObject({ trigram: 0.5, vector: 0.9, score: 0.9 });
    expect(mergeCandidates([row("b", 0.2)], [row("d", 0.6)], cfg)).toEqual([]);
  });

  it("content hash is stable and prefixed", () => {
    expect(contentHash("x")).toBe(contentHash("x"));
    expect(contentHash("x")).not.toBe(contentHash("y"));
    expect(contentHash("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("reasoning models and extra body", () => {
  it("strips a leading think block, flags an unclosed one", () => {
    expect(stripThinking('<think>hmm {"a":1}</think>\n{"ok":true}')).toBe('{"ok":true}');
    expect(stripThinking('{"ok":true}')).toBe('{"ok":true}');
    expect(stripThinking("<think>never closed {")).toBeNull();
  });

  it("sends extraBody and strips thinking from the reply", async () => {
    const fake = await startFakeLlm({ reply: `<think>plan</think>${JSON.stringify(VALID_TRIAGE_REPLY)}` });
    try {
      const cfg = loadLlmConfig({
        DEVFLOW_LLM_BASE_URL: fake.baseUrl,
        DEVFLOW_LLM_MODEL: "m",
        DEVFLOW_LLM_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}',
      })!;
      const r = await chatJson(cfg, [{ role: "user", content: "hi" }]);
      expect(fake.requests[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(fake.requests[0].body.model).toBe("m");
      expect(JSON.parse(r.content).classification).toBe("feature");
    } finally {
      await fake.close();
    }
  });

  it("rejects a non-object DEVFLOW_LLM_EXTRA_BODY", () => {
    expect(() => loadLlmConfig({ DEVFLOW_LLM_BASE_URL: "http://x", DEVFLOW_LLM_MODEL: "m", DEVFLOW_LLM_EXTRA_BODY: "[1]" })).toThrow();
  });
});

describe("embed client", () => {
  it("needs base url and model; returns the vector and token count; maps failures", async () => {
    expect(loadEmbedConfig({})).toBeNull();
    const fake = await startFakeLlm();
    try {
      const cfg = loadEmbedConfig({ DEVFLOW_EMBED_BASE_URL: fake.baseUrl, DEVFLOW_EMBED_MODEL: "bge-m3", DEVFLOW_EMBED_TIMEOUT_MS: "300" })!;
      const r = await embedText(cfg, "báo cáo tồn kho");
      expect(r.vector).toHaveLength(32);
      expect(r.tokens).toBe(7);
      expect(fake.embedRequests[0].body).toMatchObject({ model: "bge-m3", input: ["báo cáo tồn kho"] });
      fake.embedQueue.push({ status: 429 }, { status: 500 }, { raw: JSON.stringify({ data: [{ embedding: [] }] }) }, { raw: JSON.stringify({ data: [{ embedding: ["x"] }] }) }, { hang: true });
      const kinds: string[] = [];
      for (let i = 0; i < 5; i++) await embedText(cfg, "x").catch((e) => kinds.push(e.kind));
      expect(kinds).toEqual(["rate_limited", "server_error", "empty", "empty", "timeout"]);
    } finally {
      await fake.close();
    }
  });
});
