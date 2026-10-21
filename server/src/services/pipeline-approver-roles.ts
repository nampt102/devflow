import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, drMemberRoles } from "@paperclipai/db";

type AnyDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * DevFlow (openspec change add-approver-roles, ADR 0023): may this user decide at a stage whose approver is
 * `{ kind: "role", roles }`? Yes when the user holds at least one of the roles in this company, owns the
 * company, or is an instance admin (so a company that has not assigned roles yet is not locked out).
 *
 * One function for the server check (`assertActorCanApproveStageExit`) and for the `canDecide` the review
 * screens show, so the button state and the 403 cannot disagree.
 */
export async function userMayDecideAsRole(
  db: AnyDb,
  companyId: string,
  user: { userId: string; instanceAdmin?: boolean },
  roles: readonly string[],
): Promise<boolean> {
  if (user.instanceAdmin === true) return true;
  const [owner] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, user.userId),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
      ),
    )
    .limit(1);
  if (owner) return true;
  if (roles.length === 0) return false;
  const [held] = await db
    .select({ id: drMemberRoles.id })
    .from(drMemberRoles)
    .where(
      and(
        eq(drMemberRoles.companyId, companyId),
        eq(drMemberRoles.userId, user.userId),
        inArray(drMemberRoles.role, [...roles]),
      ),
    )
    .limit(1);
  return Boolean(held);
}
