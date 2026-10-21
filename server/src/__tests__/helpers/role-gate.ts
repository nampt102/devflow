import { and, eq } from "drizzle-orm";
import { companyMemberships, drMemberRoles, pipelineStages, type createDb } from "@paperclipai/db";

type TestDb = ReturnType<typeof createDb>;

/** Make a review stage ask for one of `roles` (openspec change add-approver-roles) instead of any human. */
export async function requireRoles(db: TestDb, pipelineId: string, stageKey: string, roles: string[]) {
  const [stage] = await db.select().from(pipelineStages).where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.key, stageKey)));
  await db
    .update(pipelineStages)
    .set({ config: { ...(stage!.config as Record<string, unknown>), approver: { kind: "role", roles } } })
    .where(eq(pipelineStages.id, stage!.id));
}

export async function grantRoles(db: TestDb, companyId: string, userId: string, roles: string[]) {
  await db.insert(drMemberRoles).values(roles.map((role) => ({ companyId, userId, role })));
}

export async function makeOwner(db: TestDb, companyId: string, userId: string) {
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
}
