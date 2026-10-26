import { describe, expect, it } from "vitest";
import { agentBadge, ensureAgent, setupBlocker, syncPipeline, type SetupHttp } from "./agent-setup";

const spec = (extra: Record<string, unknown> = {}) => ({
  name: "DevFlow QA",
  adapterType: "claude_local",
  adapterConfig: { model: "m", env: { A: "1" } },
  runtimeConfig: {},
  metadata: {},
  instructions: "NEW",
  promptVersion: "v1",
  ...extra,
});

/** A scripted Paperclip: records every call; `agent` is the live agent (or null), statuses are played in order. */
function fake(opts: { agent?: { id: string; problem?: string | null } | null; secrets?: unknown[]; statuses?: string[]; file?: string; bound?: boolean; runnerEnv?: boolean } = {}) {
  const calls: string[] = [];
  const statuses = [...(opts.statuses ?? ["idle"])];
  let lastStatus = "idle";
  const http: SetupHttp = {
    async get(path: string): Promise<never> {
      calls.push(`GET ${path}`);
      if (path.endsWith("/devflow/qa-agent")) return ({ spec: spec({ runnerEnvironment: "devflow-runner" }), agent: opts.agent ? { ...opts.agent, name: "n", status: "idle", problem: opts.agent.problem ?? null } : null }) as never;
      if (path.endsWith("/secrets")) return (opts.secrets ?? [{ id: "sec1", name: "devflow-ba-anthropic" }]) as never;
      if (path.endsWith("/environments")) return (opts.runnerEnv === false ? [] : [{ id: "env1", name: "devflow-runner" }]) as never;
      if (path.includes("/instructions-bundle/file")) return ({ content: opts.file ?? "NEW", contentHash: "h" }) as never;
      if (path.startsWith("/agents/")) {
        lastStatus = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
        return ({ id: "ag1", status: lastStatus, adapterConfig: opts.bound === false ? {} : { instructionsFilePath: "x" } }) as never;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string, body: unknown) {
      calls.push(`POST ${path} ${JSON.stringify(body).slice(0, 3000)}`);
      return { id: path.includes("/agents") ? "ag1" : "sec-new" } as never;
    },
    async put(path: string) {
      calls.push(`PUT ${path}`);
      return {} as never;
    },
    async patch(path: string, body: unknown) {
      calls.push(`PATCH ${path} ${JSON.stringify(body)}`);
      return {} as never;
    },
  };
  return { http, calls };
}
const noWait = { sleep: async () => {}, maxPolls: 3 };

describe("ensureAgent", () => {
  it("creates a missing agent bound to the runner with the key as a secret reference", async () => {
    const { http, calls } = fake({ agent: null });
    const r = await ensureAgent(http, { companyId: "c1", role: "qa", ...noWait });
    expect(r).toMatchObject({ state: "ready", agentId: "ag1" });
    const created = calls.find((c) => c.startsWith("POST /companies/c1/agents"))!;
    expect(created).toContain('"defaultEnvironmentId":"env1"');
    expect(created).toContain('"secretId":"sec1"');
    expect(created).not.toContain("sk-");
  });

  it("refuses to create without a key when the company has none, and stores a typed key once", async () => {
    await expect(ensureAgent(fake({ agent: null, secrets: [] }).http, { companyId: "c1", role: "qa", ...noWait })).rejects.toThrow(/paste the Anthropic key first/);
    const { http, calls } = fake({ agent: null, secrets: [] });
    await ensureAgent(http, { companyId: "c1", role: "qa", anthropicKey: " sk-test ", ...noWait });
    expect(calls.filter((c) => c.startsWith("POST /companies/c1/secrets"))).toHaveLength(1);
    // the agent refers to the new secret, never to the value
    expect(calls.find((c) => c.startsWith("POST /companies/c1/agents"))).toContain('"secretId":"sec-new"');
  });

  it("rotates the key only when one is typed", async () => {
    const withKey = fake({ agent: { id: "ag1" } });
    await ensureAgent(withKey.http, { companyId: "c1", role: "qa", anthropicKey: "sk-new", ...noWait });
    expect(withKey.calls.some((c) => c.startsWith("POST /secrets/sec1/rotate"))).toBe(true);
    const without = fake({ agent: { id: "ag1" } });
    await ensureAgent(without.http, { companyId: "c1", role: "qa", ...noWait });
    expect(without.calls.some((c) => c.includes("/rotate"))).toBe(false);
  });

  it("updates an existing agent without status, rewrites changed instructions and binds them", async () => {
    const { http, calls } = fake({ agent: { id: "ag1" }, file: "OLD", bound: false });
    await ensureAgent(http, { companyId: "c1", role: "qa", ...noWait });
    const update = calls.find((c) => c.startsWith("PATCH /agents/ag1 {"))!;
    expect(update).not.toContain('"status"');
    expect(calls).toContain("PUT /agents/ag1/instructions-bundle/file");
    expect(calls.some((c) => c.startsWith("PATCH /agents/ag1/instructions-bundle "))).toBe(true);
  });

  it("leaves identical instructions alone", async () => {
    const { http, calls } = fake({ agent: { id: "ag1" }, file: "NEW" });
    await ensureAgent(http, { companyId: "c1", role: "qa", ...noWait });
    expect(calls).not.toContain("PUT /agents/ag1/instructions-bundle/file");
  });

  it("waits while Paperclip verifies the agent and switches it on afterwards", async () => {
    const { http, calls } = fake({ agent: { id: "ag1" }, statuses: ["verifying", "verifying", "paused", "idle"] });
    const r = await ensureAgent(http, { companyId: "c1", role: "qa", sleep: async () => {}, maxPolls: 8 });
    expect(r.state).toBe("ready");
    // never asks a verifying agent to start (that is the 409), only the paused one
    expect(calls.filter((c) => c.includes('{"status":"idle"}'))).toHaveLength(1);
  });

  it("reports verifying instead of an error when it never finishes", async () => {
    const { http } = fake({ agent: { id: "ag1" }, statuses: ["verifying"] });
    expect(await ensureAgent(http, { companyId: "c1", role: "qa", ...noWait })).toMatchObject({ state: "verifying" });
  });

  it("names the missing runner and the problem DevFlow still sees", async () => {
    await expect(ensureAgent(fake({ agent: null, runnerEnv: false }).http, { companyId: "c1", role: "qa", ...noWait })).rejects.toThrow(/setup-dev-runner/);
  });
});

describe("syncPipeline", () => {
  const patches = [{ stageId: "s1", key: "qa_signoff", body: { config: { approver: { kind: "role", roles: ["qa"] } } } }];
  it("sends only the patches and the merged transitions of a seeded pipeline", async () => {
    const { http, calls } = fake();
    const msg = await syncPipeline(http, "c1", { exists: true, id: "p1", patches, transitions: [{ fromStageKey: "a", toStageKey: "b" }], transitionsMissing: 1 });
    expect(calls).toEqual(['PATCH /pipelines/p1/stages/s1 {"config":{"approver":{"kind":"role","roles":["qa"]}}}', "PUT /pipelines/p1/transitions"]);
    expect(msg).toBe("Pipeline synced: 1 stage updated, 1 transition added");
  });
  it("does nothing when already up to date", async () => {
    const { http, calls } = fake();
    expect(await syncPipeline(http, "c1", { exists: true, id: "p1", patches: [], transitions: null, transitionsMissing: 0 })).toBe("Pipeline already up to date");
    expect(calls).toEqual([]);
  });
  it("creates a missing pipeline from the definition, then its transitions", async () => {
    const { http, calls } = fake();
    await syncPipeline(http, "c1", { exists: false, id: null, patches: [], transitions: null, transitionsMissing: 0, definition: { key: "dev-request", name: "n", transitions: [{ fromStageKey: "a", toStageKey: "b" }] } });
    expect(calls[0]).toMatch(/^POST \/companies\/c1\/pipelines .*"enforceTransitions":false/);
    expect(calls[0]).not.toContain('"transitions"');
    expect(calls[1]).toBe("PUT /pipelines/sec-new/transitions");
  });
});

describe("row helpers", () => {
  it("picks the button and words from the agent state", () => {
    expect(agentBadge(null)).toMatchObject({ label: "Not created", action: "create" });
    expect(agentBadge({ id: "a", name: "n", status: "idle", problem: "agent_prompt_outdated" })).toMatchObject({ label: "Needs update", action: "update", detail: "prompt is out of date" });
    expect(agentBadge({ id: "a", name: "n", status: "verifying", problem: null })).toMatchObject({ label: "Verifying" });
    expect(agentBadge({ id: "a", name: "n", status: "idle", problem: null })).toMatchObject({ label: "Ready", action: null });
  });
  it("asks for the key only when there is no agent and no key on file", () => {
    expect(setupBlocker(null, false, "")).toMatch(/Anthropic key/);
    expect(setupBlocker(null, true, "")).toBeNull();
    expect(setupBlocker(null, false, "sk-x")).toBeNull();
  });
});
