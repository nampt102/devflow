import { and, eq } from "drizzle-orm";
import { pipelineCases, pipelineStages, type Db } from "@paperclipai/db";
import { userMayDecideAsRole } from "../services/pipeline-approver-roles.js";

/** Who is looking at a review screen: set by `staffViewer` from the request. */
export type Viewer = { userId: string; instanceAdmin?: boolean };

/**
 * What the review screens show about the viewer's right to decide (openspec change add-approver-roles, D6).
 * `requiredRoles` is empty when the case's stage does not use roles. The decision itself is always enforced by
 * the core `reviewCase`; this only lets the UI disable the buttons and say why. It uses the same
 * `userMayDecideAsRole` as the core check, so the screen and the 403 cannot disagree.
 */
export async function reviewAccess(
  db: Db,
  companyId: string,
  caseId: string,
  viewer: Viewer,
): Promise<{ canDecide: boolean; requiredRoles: string[] }> {
  const [row] = await db
    .select({ config: pipelineStages.config })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
    .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId)))
    .limit(1);
  const config = (row?.config ?? {}) as { requireApproval?: boolean; approver?: { kind?: string; id?: string; roles?: unknown } };
  if (config.requireApproval === false) return { canDecide: true, requiredRoles: [] };
  const approver = config.approver;
  if (approver?.kind === "role") {
    const roles = Array.isArray(approver.roles) ? approver.roles.filter((r): r is string => typeof r === "string") : [];
    return { canDecide: await userMayDecideAsRole(db, companyId, viewer, roles), requiredRoles: roles };
  }
  if (approver?.kind === "user") return { canDecide: approver.id === viewer.userId, requiredRoles: [] };
  if (approver?.kind === "agent") return { canDecide: false, requiredRoles: [] };
  return { canDecide: true, requiredRoles: [] };
}
