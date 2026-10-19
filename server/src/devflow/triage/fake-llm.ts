import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Fake OpenAI-compatible server for tests and offline demos. Each queued step answers one request;
// when the queue is empty it answers with `fallback`. Every request body is recorded.

export type FakeStep =
  | { reply: unknown | string; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { status: number; retryAfter?: string }
  | { hang: true }
  | { truncated: string }
  | { raw: string };

export interface FakeLlm {
  baseUrl: string;
  requests: Array<{ headers: IncomingMessage["headers"]; body: any }>;
  queue: FakeStep[];
  embedRequests: Array<{ body: any }>;
  /** Steps for /embeddings; empty queue = a deterministic bag-of-words vector. */
  embedQueue: FakeStep[];
  fallback: FakeStep;
  close(): Promise<void>;
}

export const VALID_TRIAGE_REPLY = {
  classification: "feature",
  classificationReason: "Người dùng cần thêm báo cáo mới.",
  priority: "medium",
  priorityReason: "Công việc thường, chưa có hạn gấp.",
  difficulty: "easy",
  difficultyReason: "Chỉ cần thêm một báo cáo từ dữ liệu có sẵn.",
  requiresHuman: false,
  requiresHumanReasons: [],
  duplicateCandidates: [],
  suggestedSystemKeys: [],
  summary: "Cần báo cáo tồn kho theo kho.",
  confidence: 0.8,
  assumptions: [],
  openQuestions: [],
};

/** Deterministic bag-of-words embedding (32 dims, unit length): texts sharing words get a high cosine. */
export function fakeEmbedding(text: string, dims = 32): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.codePointAt(0)!) >>> 0;
    v[h % dims] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

export async function startFakeLlm(fallback: FakeStep = { reply: VALID_TRIAGE_REPLY }): Promise<FakeLlm> {
  const fake: FakeLlm = { baseUrl: "", requests: [], queue: [], embedRequests: [], embedQueue: [], fallback, close: async () => {} };
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* recorded as null */
      }
      if (req.url?.endsWith("/embeddings")) {
        fake.embedRequests.push({ body });
        const es = fake.embedQueue.shift();
        if (es && "hang" in es) return;
        if (es && "status" in es) return void res.writeHead(es.status).end("{}");
        if (es && "raw" in es) return void res.writeHead(200, { "content-type": "application/json" }).end(es.raw);
        const input = String(body?.input?.[0] ?? "");
        return void res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [{ index: 0, embedding: fakeEmbedding(input) }], usage: { prompt_tokens: 7 } }));
      }
      fake.requests.push({ headers: req.headers, body });
      const step = fake.queue.shift() ?? fake.fallback;
      if ("hang" in step) return; // never answers; the client timeout fires
      if ("status" in step) {
        res.writeHead(step.status, step.retryAfter ? { "retry-after": step.retryAfter } : {});
        return void res.end("{}");
      }
      if ("raw" in step) return void res.writeHead(200, { "content-type": "application/json" }).end(step.raw);
      const content = "truncated" in step ? step.truncated : "reply" in step && typeof step.reply === "string" ? step.reply : JSON.stringify((step as any).reply);
      const usage = "usage" in step && step.usage ? step.usage : { prompt_tokens: 120, completion_tokens: 80 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `fake-${fake.requests.length}`,
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "truncated" in step ? "length" : "stop" }],
          usage,
        }),
      );
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return fake;
}
