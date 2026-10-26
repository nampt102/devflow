import { and, eq } from "drizzle-orm";
import { drSystems, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { githubClient, type GithubClient } from "./github.js";

type Row = Record<string, any>;

export type PrCloseDeps = {
  /** reads the token of a system's secret; null when the secret is gone */
  resolveToken?: (companyId: string, secretId: string) => Promise<string | null>;
  github?: (token: string) => GithubClient;
};

/**
 * After a reject (Code review or QA sign-off): close the draft pull requests with each system's write token. A failure is
 * recorded (`code.pr_close_failed`) and returned for a person to close by hand; it never undoes the decision. The branch stays.
 */
export async function closePullRequests(db: Db, deps: PrCloseDeps, companyId: string, caseId: string, userId: string, repos: readonly Row[]) {
  const github = deps.github ?? githubClient;
  const results: Array<{ system: string; prNumber: number; closed: boolean }> = [];
  for (const r of repos.filter((x) => x.prNumber)) {
    let closed = false;
    let kind = "close_failed";
    try {
      const [system] = await db
        .select({ repoUrl: drSystems.repoUrl, secretId: drSystems.writeTokenSecretId })
        .from(drSystems)
        .where(and(eq(drSystems.companyId, companyId), eq(drSystems.key, r.system)));
      const token = system?.secretId && deps.resolveToken ? await deps.resolveToken(companyId, system.secretId).catch(() => null) : null;
      if (!system || !token) {
        kind = "no_write_token";
      } else {
        await github(token).closePr(system.repoUrl, r.prNumber);
        closed = true;
      }
    } catch (err) {
      kind = (err as { kind?: string }).kind ?? "close_failed";
      logger.warn({ kind }, "devflow review: pull request not closed");
    }
    results.push({ system: r.system, prNumber: r.prNumber, closed });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: closed ? "code.pr_closed" : "code.pr_close_failed",
      entityType: "pipeline_case",
      entityId: caseId,
      details: { system: r.system, prNumber: r.prNumber, ...(closed ? {} : { kind }) },
    }).catch(() => undefined);
  }
  return results;
}
