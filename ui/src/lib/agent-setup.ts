import type { AgentSetupSpec, SetupRole, SetupStatus } from "../api/devflowSetup";

// The steps scripts/devflow/lib/setup-stage-agent.mjs and setup-dev-request-pipeline.mjs take, run from the Setup page with the
// signed-in person's own permissions (openspec change add-agent-setup-ui, D1). Every call is an ordinary Paperclip API call;
// the HTTP layer is passed in so the sequence can be tested. Safe to run again.

export interface SetupHttp {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
}

/** The Anthropic key secret, shared by every stage agent (its name predates the Planner). */
export const ANTHROPIC_SECRET_NAME = "devflow-ba-anthropic";

export const ROLE_TITLES: Record<SetupRole, { label: string; title: string; capabilities: string }> = {
  ba: { label: "BA", title: "BA (DevFlow)", capabilities: "Reads the request and the repositories and proposes a business analysis spec. A person approves it." },
  plan: { label: "Planner", title: "Planner (DevFlow)", capabilities: "Turns the approved BA spec into a technical plan of tasks. A person approves it." },
  dev: { label: "Dev", title: "Dev (DevFlow)", capabilities: "Writes the change on the runner; DevFlow pushes it and opens a draft pull request. A person reviews it." },
  qa: { label: "QA", title: "QA (DevFlow)", capabilities: "Checks the pull request's branch against the approved acceptance criteria on the runner and reports evidence. It changes nothing and never pushes; a person signs off." },
};

type AgentRow = { id: string; status?: string; adapterConfig?: Record<string, unknown> };
type SecretRow = { id: string; name: string; status?: string };

export interface EnsureAgentOptions {
  companyId: string;
  role: SetupRole;
  /** the Anthropic key, only when the company has no secret yet or the person chose to replace it */
  anthropicKey?: string;
  sleep?: (ms: number) => Promise<void>;
  /** how many times to look at a verifying agent (default 24, growing delay) */
  maxPolls?: number;
}

export type EnsureAgentResult =
  | { state: "ready"; agentId: string; promptVersion: string }
  | { state: "verifying"; agentId: string }
  | { state: "problem"; agentId: string; problem: string };

export class SetupError extends Error {
  constructor(public step: string, message: string) {
    super(`${step}: ${message}`);
    this.name = "SetupError";
  }
}

const list = <T>(body: unknown): T[] => (Array.isArray(body) ? (body as T[]) : ((body as { items?: T[] } | null)?.items ?? []));
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof SetupError) throw e;
    throw new SetupError(name, e instanceof Error ? e.message : String(e));
  }
}

/** Wait until the agent is on (`idle`): a new agent is verified first and refuses to start meanwhile (409). */
async function switchOn(http: SetupHttp, agentId: string, sleep: (ms: number) => Promise<void>, maxPolls: number): Promise<boolean> {
  for (let i = 0; i < maxPolls; i++) {
    const now = await http.get<{ status?: string }>(`/agents/${agentId}`);
    if (now.status === "idle") return true;
    if (now.status !== "verifying" && now.status !== "pending") {
      try {
        await http.patch(`/agents/${agentId}`, { status: "idle" });
      } catch (e) {
        if (statusOf(e) !== 409) throw e;
      }
    }
    await sleep(Math.min(2000 + i * 500, 8000));
  }
  return false;
}

export async function ensureAgent(http: SetupHttp, opts: EnsureAgentOptions): Promise<EnsureAgentResult> {
  const { companyId, role } = opts;
  const sleep = opts.sleep ?? realSleep;
  const maxPolls = opts.maxPolls ?? 24;
  const meta = ROLE_TITLES[role];
  const setupUrl = `/companies/${companyId}/devflow/${role}-agent`;

  const state = await step("read the setup", () => http.get<AgentSetupSpec>(setupUrl));
  const { spec } = state;

  // the Anthropic key, as a company secret the agent refers to (a plain value in the agent config is refused)
  const secrets = list<SecretRow>(await step("list secrets", () => http.get(`/companies/${companyId}/secrets`)));
  let secret = secrets.find((s) => s.name === ANTHROPIC_SECRET_NAME && s.status !== "deleted");
  const key = opts.anthropicKey?.trim();
  if (!secret) {
    if (!key) throw new SetupError("Anthropic key", "paste the Anthropic key first");
    secret = await step("store the key", () => http.post<SecretRow>(`/companies/${companyId}/secrets`, { name: ANTHROPIC_SECRET_NAME, value: key, description: "Anthropic key for the DevFlow stage agents" }));
  } else if (key) {
    await step("replace the key", () => http.post(`/secrets/${secret!.id}/rotate`, { value: key }));
  }

  // Dev and QA run only on the runner: bind them to its Paperclip SSH environment
  let environmentFields: Record<string, unknown> = {};
  if (spec.runnerEnvironment) {
    const envs = list<{ id: string; name: string }>(await step("list environments", () => http.get(`/companies/${companyId}/environments`)));
    const runner = envs.find((e) => e.name === spec.runnerEnvironment);
    if (!runner) throw new SetupError("runner", `the environment "${spec.runnerEnvironment}" does not exist: run scripts/devflow/setup-dev-runner.mjs`);
    environmentFields = { defaultEnvironmentId: runner.id };
  }

  const adapterConfig = {
    ...spec.adapterConfig,
    env: { ...((spec.adapterConfig.env as Record<string, unknown> | undefined) ?? {}), ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret!.id, version: "latest" } },
  };

  let agentId = state.agent?.id;
  if (!agentId) {
    const created = await step("create the agent", () =>
      http.post<AgentRow>(`/companies/${companyId}/agents`, {
        name: spec.name,
        role: "general",
        title: meta.title,
        capabilities: meta.capabilities,
        adapterType: spec.adapterType,
        ...environmentFields,
        adapterConfig,
        runtimeConfig: spec.runtimeConfig,
        metadata: spec.metadata,
        instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": spec.instructions } },
      }),
    );
    agentId = created.id;
  } else {
    // merge, never replace: Paperclip keeps the binding of the instructions file in the same config.
    // No `status` here: an agent being verified refuses it; it is switched on afterwards.
    await step("update the agent", () => http.patch(`/agents/${agentId}`, { adapterConfig, runtimeConfig: spec.runtimeConfig, metadata: spec.metadata, ...environmentFields }));
    const file = await step("read the instructions", () => http.get<{ content: string; contentHash?: string | null }>(`/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`));
    if (file.content !== spec.instructions) {
      await step("update the instructions", () => http.put(`/agents/${agentId}/instructions-bundle/file`, { path: "AGENTS.md", content: spec.instructions, baseHash: file.contentHash ?? null }));
    }
  }

  // an agent whose instructions are not bound to it ignores them
  const current = await step("read the agent", () => http.get<AgentRow>(`/agents/${agentId}`));
  if (!current.adapterConfig?.instructionsFilePath) {
    await step("bind the instructions", () => http.patch(`/agents/${agentId}/instructions-bundle`, { mode: "managed", entryFile: "AGENTS.md" }));
  }

  const on = await step("switch the agent on", () => switchOn(http, agentId!, sleep, maxPolls));
  if (!on) return { state: "verifying", agentId };

  const after = await step("check the agent", () => http.get<AgentSetupSpec>(setupUrl));
  if (after.agent?.problem) return { state: "problem", agentId, problem: after.agent.problem };
  return { state: "ready", agentId, promptVersion: spec.promptVersion };
}

/** Create the pipeline, or add only what a seeded one lacks. Returns what was done, for the toast. */
export async function syncPipeline(http: SetupHttp, companyId: string, status: SetupStatus["pipeline"]): Promise<string> {
  if (!status.exists) {
    const def = status.definition;
    if (!def) throw new SetupError("pipeline", "the server sent no definition to create");
    const { transitions, ...create } = def;
    const created = await step("create the pipeline", () => http.post<{ id: string }>(`/companies/${companyId}/pipelines`, { ...create, enforceTransitions: false }));
    await step("set the transitions", () => http.put(`/pipelines/${created.id}/transitions`, { transitions, enforceTransitions: true }));
    return "Pipeline created";
  }
  for (const p of status.patches) {
    await step(`update stage ${p.key}`, () => http.patch(`/pipelines/${status.id}/stages/${p.stageId}`, p.body));
  }
  if (status.transitions) {
    await step("add the missing transitions", () => http.put(`/pipelines/${status.id}/transitions`, { transitions: status.transitions, enforceTransitions: true }));
  }
  const parts = [status.patches.length ? `${status.patches.length} stage${status.patches.length === 1 ? "" : "s"} updated` : "", status.transitionsMissing ? `${status.transitionsMissing} transition${status.transitionsMissing === 1 ? "" : "s"} added` : ""].filter(Boolean);
  return parts.length ? `Pipeline synced: ${parts.join(", ")}` : "Pipeline already up to date";
}

export type AgentBadge = { label: string; tone: "ok" | "warn" | "off"; action: "create" | "update" | null; detail?: string };

const PROBLEM_TEXT: Record<string, string> = {
  agent_prompt_outdated: "prompt is out of date",
  agent_tools_changed: "tools were changed",
  agent_not_on_runner: "not on the runner",
  runner_environment_invalid: "runner environment is wrong",
  runner_host_key_not_pinned: "runner host key is not pinned",
  agent_not_runnable: "agent is paused or stopped",
};

/** One line for the agent's row: what it is, and which button applies. */
export function agentBadge(agent: SetupStatus["agents"][SetupRole]): AgentBadge {
  if (!agent) return { label: "Not created", tone: "off", action: "create" };
  if (agent.problem) return { label: "Needs update", tone: "warn", action: "update", detail: PROBLEM_TEXT[agent.problem] ?? agent.problem };
  if (agent.status === "verifying" || agent.status === "pending") return { label: "Verifying", tone: "warn", action: "update", detail: "Paperclip is checking the agent; press Update again in a minute if it stays here" };
  return { label: "Ready", tone: "ok", action: null };
}

/** Why the button cannot be pressed yet, or null. */
export function setupBlocker(agent: SetupStatus["agents"][SetupRole], hasKeyOnFile: boolean, typedKey: string): string | null {
  if (!agent && !hasKeyOnFile && !typedKey.trim()) return "Paste the Anthropic key first";
  return null;
}
