import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { drAgentOutputs, type Db } from "@paperclipai/db";

type Row = Record<string, any>;

/**
 * What a reviewer approved at a stage: `data.approved` of the newest accepted or overridden proposal, or null. Later stages
 * (Dev, QA) are fed from this and never from an agent's draft.
 */
export async function loadApproved(db: Db, companyId: string, caseId: string, stageKey: string): Promise<Row | null> {
  const [found] = await db
    .select({ data: drAgentOutputs.data })
    .from(drAgentOutputs)
    .where(
      and(
        eq(drAgentOutputs.companyId, companyId),
        eq(drAgentOutputs.caseId, caseId),
        eq(drAgentOutputs.stageKey, stageKey),
        inArray(drAgentOutputs.status, ["accepted", "overridden"]),
        isNotNull(drAgentOutputs.decidedAt),
      ),
    )
    .orderBy(desc(drAgentOutputs.decidedAt))
    .limit(1);
  const a = (found?.data as Row | undefined)?.approved;
  return a && typeof a === "object" ? (a as Row) : null;
}
