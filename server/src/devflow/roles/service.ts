import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { companyMemberships, drMemberRoles, type Db } from "@paperclipai/db";
import { PIPELINE_APPROVER_ROLES } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";

// Business roles of company staff (openspec change add-approver-roles, ADR 0023). A person can hold several.
// The role list is the one the stage approver validator uses (PIPELINE_APPROVER_ROLES), so a role you can
// grant is a role a stage can require.

export const ROLES = PIPELINE_APPROVER_ROLES;
export type MemberRole = (typeof ROLES)[number];

// The shape is checked by validate() (400); which strings are real roles is checked here so a bad role is a 422.
export const setRolesSchema = z.strictObject({ roles: z.array(z.string().max(50)).max(20) });

type Viewer = { userId: string; instanceAdmin?: boolean };
type Row = Record<string, any>;

export function memberRolesService(db: Db) {
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];

  /** Owner of the company (active membership) or instance admin: the people who may change roles. */
  async function canManage(companyId: string, viewer: Viewer): Promise<boolean> {
    if (viewer.instanceAdmin === true) return true;
    const [owner] = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, viewer.userId),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "owner"),
        ),
      )
      .limit(1);
    return Boolean(owner);
  }

  /** Active staff of the company with their roles, for the Roles screen. */
  async function list(companyId: string, viewer: Viewer) {
    const members = await rows(sql`
      select u.id, u.name, u.email, m.membership_role as role
      from company_memberships m join "user" u on u.id = m.principal_id
      where m.company_id = ${companyId} and m.principal_type = 'user' and m.status = 'active'
      order by lower(u.name), u.email`);
    const granted = await db
      .select({ userId: drMemberRoles.userId, role: drMemberRoles.role })
      .from(drMemberRoles)
      .where(eq(drMemberRoles.companyId, companyId));
    const rolesOf = new Map<string, string[]>();
    for (const g of granted) rolesOf.set(g.userId, [...(rolesOf.get(g.userId) ?? []), g.role]);
    return {
      availableRoles: [...ROLES],
      canManage: await canManage(companyId, viewer),
      items: members.map((m) => ({
        userId: m.id as string,
        name: m.name as string,
        email: m.email as string,
        membershipRole: (m.role as string | null) ?? null,
        // owners (and instance admins) pass every role stage without a role; the screen says so
        alwaysApproves: m.role === "owner",
        roles: ROLES.filter((r) => (rolesOf.get(m.id) ?? []).includes(r)),
      })),
    };
  }

  /**
   * Replaces the whole role list of one person in one transaction: grant and revoke are the same operation,
   * so an error cannot leave half a change. Idempotent; the audit row is written only when something changed.
   */
  async function setRoles(companyId: string, actor: Viewer, targetUserId: string, requested: readonly string[]) {
    if (!(await canManage(companyId, actor))) throw forbidden("Only the company owner can change roles");
    const unknown = requested.filter((r) => !(ROLES as readonly string[]).includes(r));
    if (unknown.length) throw unprocessable(`Unknown role: ${unknown.join(", ")}`, { code: "validation", allowed: [...ROLES] });
    const wanted = ROLES.filter((r) => requested.includes(r));

    return db.transaction(async (tx) => {
      const [member] = await tx
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, targetUserId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .limit(1);
      if (!member) throw unprocessable("That person is not an active member of this company", { code: "not_a_member" });

      const current = await tx
        .select({ role: drMemberRoles.role })
        .from(drMemberRoles)
        .where(and(eq(drMemberRoles.companyId, companyId), eq(drMemberRoles.userId, targetUserId)));
      const before = ROLES.filter((r) => current.some((c) => c.role === r));
      const added = wanted.filter((r) => !before.includes(r));
      const removed = before.filter((r) => !wanted.includes(r));

      for (const role of removed) {
        await tx.delete(drMemberRoles).where(and(eq(drMemberRoles.companyId, companyId), eq(drMemberRoles.userId, targetUserId), eq(drMemberRoles.role, role)));
      }
      if (added.length) {
        await tx
          .insert(drMemberRoles)
          .values(added.map((role) => ({ companyId, userId: targetUserId, role, grantedByUserId: actor.userId })))
          .onConflictDoNothing();
      }
      if (added.length || removed.length) {
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "devflow.roles_changed",
          entityType: "user",
          entityId: targetUserId,
          details: { targetUserId, before, after: wanted, added, removed },
        });
      }
      return { userId: targetUserId, roles: wanted, changed: added.length > 0 || removed.length > 0 };
    });
  }

  return { list, setRoles, canManage };
}
