import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { drRequestCounters, drRequests, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import type { StorageService } from "../../storage/types.js";
import { checkFiles, portalAttachments, type AttachmentDto, type UploadedFile } from "./attachments.js";
import { notFound, tooManyRequests, unprocessable } from "../../errors.js";
import type { PipelineActor } from "../../services/pipelines.js";
import type { RequesterContext } from "./requester-guard.js";
import { DEV_REQUEST_PIPELINE_KEY, statusLabelVi } from "./status-labels.js";

export const MAX_REQUESTS_PER_HOUR = 10;

export type SubmitInput = { title: string; description: string; businessImpact?: string | null };

/** Explicit allowlist: the only shape a requester ever sees. Never return case rows or events. */
export type RequestDto = {
  code: string;
  number: number;
  title: string;
  description: string;
  businessImpact: string | null;
  statusLabel: string;
  createdAt: string;
  updatedAt: string;
  attachments?: AttachmentDto[];
};

type IngestCase = (input: {
  companyId: string;
  pipelineId: string;
  caseKey: string;
  title: string;
  stageKey: string;
  actor: PipelineActor;
}) => Promise<{ case: { id: string } }>;

export function portalService(db: Db, deps: { ingestCase: IngestCase; storage: StorageService }) {
  const files = portalAttachments(db, deps.storage);
  const baseSelect = () =>
    db
      .select({
        caseId: drRequests.caseId,
        number: drRequests.requestNumber,
        title: pipelineCases.title,
        description: drRequests.description,
        businessImpact: drRequests.businessImpact,
        stageKey: pipelineStages.key,
        createdAt: drRequests.createdAt,
        updatedAt: pipelineCases.updatedAt,
      })
      .from(drRequests)
      .innerJoin(
        pipelineCases,
        and(eq(pipelineCases.id, drRequests.caseId), eq(pipelineCases.companyId, drRequests.companyId)),
      )
      .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId));

  const toDto = (r: Awaited<ReturnType<ReturnType<typeof baseSelect>["limit"]>>[number]): RequestDto => ({
    code: `REQ-${r.number}`,
    number: r.number,
    title: r.title,
    description: r.description,
    businessImpact: r.businessImpact,
    statusLabel: statusLabelVi(r.stageKey),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });

  const own = (ctx: RequesterContext) =>
    and(eq(drRequests.companyId, ctx.companyId), eq(drRequests.requesterId, ctx.requesterId));

  return {
    async submit(ctx: RequesterContext, input: SubmitInput, uploads: UploadedFile[] = []): Promise<RequestDto> {
      const checked = checkFiles(uploads); // refuse bad files before anything is created
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const [{ recent }] = await db
        .select({ recent: sql<number>`count(*)::int` })
        .from(drRequests)
        .where(and(own(ctx), gte(drRequests.createdAt, since)));
      if (recent >= MAX_REQUESTS_PER_HOUR) {
        throw tooManyRequests("Too many requests submitted; try again later");
      }

      const [pipeline] = await db
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.companyId, ctx.companyId), eq(pipelines.key, DEV_REQUEST_PIPELINE_KEY)));
      if (!pipeline) throw unprocessable("Request pipeline is not set up for this company", { code: "pipeline_missing" });

      // (a) number; gaps are acceptable if a later step fails
      const [{ n }] = await db
        .insert(drRequestCounters)
        .values({ companyId: ctx.companyId, lastNumber: 1 })
        .onConflictDoUpdate({
          target: drRequestCounters.companyId,
          set: { lastNumber: sql`${drRequestCounters.lastNumber} + 1`, updatedAt: sql`now()` },
        })
        .returning({ n: drRequestCounters.lastNumber });

      // (b) the case, created as the requester so events name them; stage is fixed server-side
      const { case: created } = await deps.ingestCase({
        companyId: ctx.companyId,
        pipelineId: pipeline.id,
        caseKey: `REQ-${n}`,
        title: input.title,
        stageKey: "triage",
        actor: { type: "user", userId: ctx.userId },
      });

      // (c) files, business row, activity; compensate by removing the case if this fails (ingestCase owns its transaction)
      let assetIds: string[] = [];
      try {
        assetIds = await files.storeFiles(ctx, checked);
        await db.transaction(async (tx) => {
          await tx.insert(drRequests).values({
            caseId: created.id,
            companyId: ctx.companyId,
            requestNumber: n,
            requesterId: ctx.requesterId,
            description: input.description,
            businessImpact: input.businessImpact ?? null,
            source: "portal",
          });
          await files.attach(tx as unknown as Db, ctx, created.id, assetIds);
          await logActivity(tx as unknown as Db, {
            companyId: ctx.companyId,
            actorType: "user",
            actorId: ctx.userId,
            action: "portal.request_submitted",
            entityType: "pipeline_case",
            entityId: created.id,
            details: { requestNumber: n, attachments: assetIds.length },
          });
        });
      } catch (err) {
        await files.discardAssets(ctx, assetIds);
        await db.delete(pipelineCases).where(eq(pipelineCases.id, created.id));
        throw err;
      }
      return this.get(ctx, n);
    },

    async list(ctx: RequesterContext, opts: { limit?: number; offset?: number } = {}): Promise<RequestDto[]> {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
      const rows = await baseSelect()
        .where(own(ctx))
        .orderBy(desc(drRequests.requestNumber))
        .limit(limit)
        .offset(Math.max(opts.offset ?? 0, 0));
      return rows.map(toDto);
    },

    async get(ctx: RequesterContext, number: number): Promise<RequestDto> {
      const [row] = await baseSelect()
        .where(and(own(ctx), eq(drRequests.requestNumber, number)))
        .limit(1);
      if (!row) throw notFound("Request not found");
      return { ...toDto(row), attachments: await files.list(ctx, row.caseId) };
    },

    /** Adds files to one of the requester's own requests (5 files in total per request). */
    async addAttachments(ctx: RequesterContext, number: number, uploads: UploadedFile[]): Promise<RequestDto> {
      const [row] = await baseSelect().where(and(own(ctx), eq(drRequests.requestNumber, number))).limit(1);
      if (!row) throw notFound("Request not found");
      const checked = checkFiles(uploads, await files.countFor(ctx, row.caseId));
      const assetIds = await files.storeFiles(ctx, checked);
      try {
        await db.transaction(async (tx) => {
          await files.attach(tx as unknown as Db, ctx, row.caseId, assetIds);
          await logActivity(tx as unknown as Db, {
            companyId: ctx.companyId,
            actorType: "user",
            actorId: ctx.userId,
            action: "portal.attachments_added",
            entityType: "pipeline_case",
            entityId: row.caseId,
            details: { requestNumber: number, attachments: assetIds.length },
          });
        });
      } catch (err) {
        await files.discardAssets(ctx, assetIds);
        throw err;
      }
      return this.get(ctx, number);
    },

    async openAttachment(ctx: RequesterContext, number: number, attachmentId: string) {
      const [row] = await baseSelect().where(and(own(ctx), eq(drRequests.requestNumber, number))).limit(1);
      if (!row) throw notFound("Request not found");
      return files.open(ctx, row.caseId, attachmentId);
    },
  };
}
