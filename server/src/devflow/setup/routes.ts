import { lookup } from "node:dns/promises";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environments, pipelineStages, pipelineTransitions, pipelines } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { findBaAgent, unsafeBaAgentReason } from "../ba/agent.js";
import { devAgentProblem } from "../dev/agent.js";
import { RUNNER_ENVIRONMENT } from "../dev/runner-agent.js";
import { findPlanAgent, unsafePlanAgentReason } from "../plan/agent.js";
import { qaAgentProblem } from "../qa/agent.js";
import { isOwnerOrAdmin } from "../roles/service.js";
import { staffViewer } from "../staff.js";
import pipelineDefinition from "../dev-request-pipeline.json" with { type: "json" };
import { approverPatches, mergedTransitions, type DefinitionStage, type DefinitionTransition } from "./pipeline-sync.js";

type Env = Record<string, string | undefined>;
type AgentState = { id: string; name: string; status: string; problem: string | null } | null;

// imported (not read at run time): tsc copies an imported JSON file into dist, a file read by path is missing there
const definition = pipelineDefinition as unknown as {
  key: string;
  stages: DefinitionStage[];
  transitions: DefinitionTransition[];
};

/**
 * Read-only state for the Setup page: the four stage agents, the `dev-request` pipeline against its definition, and whether
 * the runner can be reached. Applying anything goes through the ordinary Paperclip APIs with the viewer's own permissions
 * (openspec change add-agent-setup-ui, design D1); this only says what is missing.
 */
export function setupRoutes(db: Db, env: Env = process.env, resolveHost: (host: string) => Promise<unknown> = lookup) {
  const router = Router();

  router.get("/companies/:companyId/devflow/setup-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const viewer = staffViewer(req, companyId, "see the setup");
    if (!(await isOwnerOrAdmin(db, companyId, viewer))) throw forbidden("Only a company owner or admin can see the setup");
    const root = env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;

    const ba = await findBaAgent(db, companyId);
    const plan = await findPlanAgent(db, companyId);
    const dev = await devAgentProblem(db, companyId, root);
    const qa = await qaAgentProblem(db, companyId, root);
    const state = (a: { id: string; name: string; status: string } | null | undefined, problem: string | null): AgentState =>
      a ? { id: a.id, name: a.name, status: a.status, problem } : null;
    const agents = {
      ba: state(ba, ba ? unsafeBaAgentReason(ba, root) : null),
      plan: state(plan, plan ? unsafePlanAgentReason(plan, root) : null),
      dev: state(dev.agent, dev.problem),
      qa: state(qa.agent, qa.problem),
    };

    const [pipeline] = await db.select().from(pipelines).where(and(eq(pipelines.companyId, companyId), eq(pipelines.key, definition.key)));
    let pipelineState: { exists: boolean; id: string | null; patches: unknown[]; transitions: unknown[] | null; transitionsMissing: number; definition?: unknown };
    if (!pipeline) {
      pipelineState = { exists: false, id: null, patches: [], transitions: null, transitionsMissing: 0, definition };
    } else {
      const stages = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id));
      const live = await db.select().from(pipelineTransitions).where(eq(pipelineTransitions.pipelineId, pipeline.id));
      const patches = approverPatches(definition.stages, stages);
      const transitions = mergedTransitions(definition.transitions, live, stages);
      pipelineState = { exists: true, id: pipeline.id, patches, transitions, transitionsMissing: transitions ? transitions.length - live.length : 0 };
    }

    const [environment] = await db.select({ id: environments.id }).from(environments).where(eq(environments.name, RUNNER_ENVIRONMENT));
    const reachable = await resolveHost(RUNNER_ENVIRONMENT).then(() => true, () => false);

    const needsAttention =
      Object.values(agents).some((a) => a !== null && a.problem !== null) ||
      (pipelineState.exists && (pipelineState.patches.length > 0 || pipelineState.transitions !== null));
    res.json({
      agents,
      pipeline: pipelineState,
      runner: { environment: Boolean(environment), reachable },
      needsAttention,
    });
  });

  return router;
}
