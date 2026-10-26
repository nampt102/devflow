import { api } from "./client";

// What the Setup page shows (openspec change add-agent-setup-ui). Applying anything goes through the ordinary Paperclip APIs
// (see lib/agent-setup.ts); this only reads what is missing.

export type SetupRole = "ba" | "plan" | "dev" | "qa";

export interface SetupAgent {
  id: string;
  name: string;
  status: string;
  /** why DevFlow would refuse to run it (agent_prompt_outdated, agent_not_on_runner...), or null */
  problem: string | null;
}

export interface SetupStatus {
  agents: Record<SetupRole, SetupAgent | null>;
  pipeline: {
    exists: boolean;
    id: string | null;
    patches: Array<{ stageId: string; key: string; body: { config: Record<string, unknown> } }>;
    /** the full list to PUT, or null when nothing is missing */
    transitions: Array<{ fromStageKey: string; toStageKey: string; label?: string }> | null;
    transitionsMissing: number;
    /** present when the pipeline does not exist yet: what to create */
    definition?: { key: string; name: string; transitions: Array<{ fromStageKey: string; toStageKey: string; label?: string }> } & Record<string, unknown>;
  };
  runner: { environment: boolean; reachable: boolean };
  needsAttention: boolean;
}

export interface AgentSetupSpec {
  spec: {
    name: string;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
    runtimeConfig: Record<string, unknown>;
    metadata: Record<string, unknown>;
    instructions: string;
    promptVersion: string;
    runnerEnvironment?: string;
  };
  agent: SetupAgent | null;
}

export const devflowSetupApi = {
  status: (companyId: string) => api.get<SetupStatus>(`/companies/${companyId}/devflow/setup-status`),
  spec: (companyId: string, role: SetupRole) => api.get<AgentSetupSpec>(`/companies/${companyId}/devflow/${role}-agent`),
};
