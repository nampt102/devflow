// Shared core of setup-ba-agent.mjs and setup-plan-agent.mjs: creates or updates a stage agent of a company so it is
// exactly what DevFlow expects (read-only tools, its own workspace folder, a spend limit per run, current
// instructions). Safe to run again.
//
// Env (local only; see docker/.env.example):
//   PAPERCLIP_URL                          default http://localhost:3100
//   DEVFLOW_TEST_ADMIN_EMAIL/PASSWORD      a board user with access to the company (staff)
//   DEVFLOW_AGENT_ANTHROPIC_API_KEY        the Anthropic key the agents use; stored as one company secret shared by
//                                          every stage agent (needed the first time, and to replace the key)
// What the agent should look like comes from the server (GET /api/companies/:id/devflow/<stage>-agent), so these
// scripts never drift from the code.

/** The Anthropic key secret, shared by BA and Planner (its name predates the Planner). */
const SECRET_NAME = "devflow-ba-anthropic";

/**
 * @param {{ script: string, label: string, setupPath: string, title: string, capabilities: string }} stage
 */
export async function setupStageAgent(stage) {
  const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
  const args = process.argv.slice(2);
  const companyId = args[args.indexOf("--company") + 1];
  if (!companyId || companyId.startsWith("--")) {
    console.error(`Usage: ${stage.script} --company <companyId>`);
    process.exit(2);
  }
  const need = (name) => {
    const v = process.env[name];
    if (!v) {
      console.error(`Missing env ${name}`);
      process.exit(2);
    }
    return v;
  };

  let cookie = "";
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  const must = (r, what) => {
    if (r.status >= 300) {
      console.error(`${what} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      process.exit(1);
    }
    return r.body;
  };
  const setupUrl = `/api/companies/${companyId}/devflow/${stage.setupPath}`;

  must(await call("POST", "/api/auth/sign-in/email", { email: need("DEVFLOW_TEST_ADMIN_EMAIL"), password: need("DEVFLOW_TEST_ADMIN_PASSWORD") }), "sign-in");
  const state = must(await call("GET", setupUrl), `read ${stage.label} agent setup`);
  const { spec } = state;

  // The Anthropic key, as a company secret the agent refers to (a plain value in the agent config is refused).
  const secretList = must(await call("GET", `/api/companies/${companyId}/secrets`), "list secrets");
  const secrets = Array.isArray(secretList) ? secretList : secretList.items ?? [];
  let secret = secrets.find((s) => s.name === SECRET_NAME && s.status !== "deleted");
  const key = process.env.DEVFLOW_AGENT_ANTHROPIC_API_KEY;
  if (!secret) {
    if (!key) {
      console.error("The agent needs an Anthropic key: set DEVFLOW_AGENT_ANTHROPIC_API_KEY and run again.");
      process.exit(2);
    }
    secret = must(await call("POST", `/api/companies/${companyId}/secrets`, { name: SECRET_NAME, value: key, description: "Anthropic key for the DevFlow stage agents" }), "create secret");
    console.log("stored the Anthropic key as a company secret");
  } else if (key) {
    must(await call("POST", `/api/secrets/${secret.id}/rotate`, { value: key }), "rotate secret");
    console.log("replaced the stored Anthropic key");
  }

  // The Dev agent runs only on the runner: bind it to the Paperclip SSH environment of the runner (setup-dev-runner.mjs).
  let environmentFields = {};
  if (spec.runnerEnvironment) {
    const envs = must(await call("GET", `/api/companies/${companyId}/environments`), "list environments");
    const runner = (Array.isArray(envs) ? envs : envs.items ?? []).find((e) => e.name === spec.runnerEnvironment);
    if (!runner) {
      console.error(`The runner environment "${spec.runnerEnvironment}" does not exist: run scripts/devflow/setup-dev-runner.mjs first.`);
      process.exit(2);
    }
    environmentFields = { defaultEnvironmentId: runner.id };
  }

  const adapterConfig = { ...spec.adapterConfig, env: { ...(spec.adapterConfig.env ?? {}), ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } } };
  let agentId = state.agent?.id;
  if (!agentId) {
    const created = must(
      await call("POST", `/api/companies/${companyId}/agents`, {
        name: spec.name,
        role: "general",
        title: stage.title,
        capabilities: stage.capabilities,
        adapterType: spec.adapterType,
        ...environmentFields,
        adapterConfig,
        runtimeConfig: spec.runtimeConfig,
        metadata: spec.metadata,
        instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": spec.instructions } },
      }),
      "create agent",
    );
    agentId = created.id;
    console.log(`created agent ${agentId}`);
    // a new agent is verified first (about a minute) and may start paused; DevFlow only runs agents that are on
    if (created.status && created.status !== "idle") {
      let on = await call("PATCH", `/api/agents/${agentId}`, { status: "idle" });
      for (let i = 0; i < 12 && on.status === 409; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const now = await call("GET", `/api/agents/${agentId}`);
        if (now.body?.status === "idle") break;
        on = await call("PATCH", `/api/agents/${agentId}`, { status: "idle" });
      }
      if (on.status >= 300 && on.status !== 409) must(on, "switch the agent on");
    }
  } else {
    // merge, never replace: Paperclip keeps the binding of the instructions file in the same config
    must(await call("PATCH", `/api/agents/${agentId}`, { adapterConfig, runtimeConfig: spec.runtimeConfig, metadata: spec.metadata, ...environmentFields, status: "idle" }), "update agent");
    const file = must(await call("GET", `/api/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`), "read instructions");
    if (file.content !== spec.instructions) {
      must(await call("PUT", `/api/agents/${agentId}/instructions-bundle/file`, { path: "AGENTS.md", content: spec.instructions, baseHash: file.contentHash ?? null }), "update instructions");
      console.log("updated the instructions");
    }
    console.log(`updated agent ${agentId}`);
  }

  // an agent whose instructions are not bound to it ignores them (an earlier version of this script could drop the binding)
  const current = must(await call("GET", `/api/agents/${agentId}`), "read the agent");
  if (!current.adapterConfig?.instructionsFilePath) {
    must(await call("PATCH", `/api/agents/${agentId}/instructions-bundle`, { mode: "managed", entryFile: "AGENTS.md" }), "bind the instructions");
    console.log("bound the instructions file to the agent");
  }

  const after = must(await call("GET", setupUrl), `check ${stage.label} agent`);
  if (after.agent?.problem) {
    console.error(`The agent is set up but DevFlow would still refuse to run it: ${after.agent.problem}`);
    process.exit(1);
  }
  console.log(`${stage.label} agent ready (prompt ${spec.promptVersion}).`);
}
