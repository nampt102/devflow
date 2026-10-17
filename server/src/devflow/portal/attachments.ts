import { basename } from "node:path";
import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, drAttachments } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { assetService } from "../../services/index.js";
import { notFound, unprocessable } from "../../errors.js";
import type { RequesterContext } from "./requester-guard.js";

// Limits for requester uploads (openspec/changes/add-intake-portal, "Submit request").
export const MAX_FILES_PER_REQUEST = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type UploadedFile = { originalname: string; mimetype: string; buffer: Buffer };

const OOXML = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const OLE = ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"];
const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT = ["text/plain", "text/csv"];
export const PORTAL_ALLOWED_TYPES: readonly string[] = [...IMAGES, "application/pdf", ...OOXML, ...OLE, ...TEXT];

const hasPrefix = (b: Buffer, bytes: number[], at = 0) => bytes.every((v, i) => b[at + i] === v);

/** The declared MIME type is client-controlled, so the leading bytes must agree with it. */
function contentMatchesType(type: string, b: Buffer): boolean {
  if (type === "image/png") return hasPrefix(b, [0x89, 0x50, 0x4e, 0x47]);
  if (type === "image/jpeg") return hasPrefix(b, [0xff, 0xd8, 0xff]);
  if (type === "image/gif") return hasPrefix(b, [0x47, 0x49, 0x46, 0x38]);
  if (type === "image/webp") return hasPrefix(b, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(b, [0x57, 0x45, 0x42, 0x50], 8);
  if (type === "application/pdf") return b.subarray(0, 1024).includes("%PDF-");
  if (OOXML.includes(type)) return hasPrefix(b, [0x50, 0x4b, 0x03, 0x04]);
  if (OLE.includes(type)) return hasPrefix(b, [0xd0, 0xcf, 0x11, 0xe0]);
  if (TEXT.includes(type)) return !b.subarray(0, 8000).includes(0);
  return false;
}

export function cleanFilename(raw: string | undefined): string {
  const base = basename((raw ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f"<>|:*?]/g, "").trim();
  return (base || "tep-dinh-kem").slice(0, 150);
}

export function checkFiles(files: UploadedFile[], alreadyAttached = 0): Array<{ file: UploadedFile; contentType: string }> {
  if (files.length + alreadyAttached > MAX_FILES_PER_REQUEST) {
    throw unprocessable(`At most ${MAX_FILES_PER_REQUEST} files per request`, { code: "too_many_files" });
  }
  return files.map((file) => {
    const declared = (file.mimetype || "").toLowerCase();
    const contentType = declared === "image/jpg" ? "image/jpeg" : declared;
    if (!PORTAL_ALLOWED_TYPES.includes(contentType)) {
      throw unprocessable(`Unsupported file type: ${declared || "unknown"}`, { code: "unsupported_type" });
    }
    if (file.buffer.length === 0) throw unprocessable("File is empty", { code: "empty_file" });
    if (file.buffer.length > MAX_FILE_BYTES) throw unprocessable("File is larger than 10 MB", { code: "file_too_large" });
    if (!contentMatchesType(contentType, file.buffer)) {
      throw unprocessable("File content does not match its type", { code: "content_mismatch" });
    }
    return { file, contentType };
  });
}

export type AttachmentDto = { id: string; filename: string; contentType: string; byteSize: number; createdAt: string };

export function portalAttachments(db: Db, storage: StorageService) {
  const assetSvc = assetService(db);

  return {
    /** Writes validated files to storage and creates their assets. Call checkFiles first. */
    async storeFiles(ctx: RequesterContext, checked: ReturnType<typeof checkFiles>): Promise<string[]> {
      const ids: string[] = [];
      try {
        for (const { file, contentType } of checked) {
          const stored = await storage.putFile({
            companyId: ctx.companyId,
            namespace: "portal/requests",
            originalFilename: cleanFilename(file.originalname),
            contentType,
            body: file.buffer,
          });
          const asset = await assetSvc.create(ctx.companyId, {
            provider: stored.provider,
            objectKey: stored.objectKey,
            contentType: stored.contentType,
            byteSize: stored.byteSize,
            sha256: stored.sha256,
            originalFilename: stored.originalFilename,
            createdByUserId: ctx.userId,
          });
          ids.push(asset.id);
        }
      } catch (err) {
        await this.discardAssets(ctx, ids);
        throw err;
      }
      return ids;
    },

    /** Links assets to a case. The DB does not tie assets to a company (ADR 0010), so check it here. */
    async attach(tx: Db, ctx: RequesterContext, caseId: string, assetIds: string[]) {
      if (assetIds.length === 0) return;
      const owned = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(inArray(assets.id, assetIds), eq(assets.companyId, ctx.companyId)));
      if (owned.length !== assetIds.length) throw unprocessable("Attachment belongs to another company", { code: "asset_company_mismatch" });
      await tx.insert(drAttachments).values(
        assetIds.map((assetId) => ({
          companyId: ctx.companyId,
          caseId,
          assetId,
          uploadedByRequesterId: ctx.requesterId,
          uploadedByUserId: ctx.userId,
        })),
      );
    },

    async countFor(ctx: RequesterContext, caseId: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(drAttachments)
        .where(and(eq(drAttachments.companyId, ctx.companyId), eq(drAttachments.caseId, caseId)));
      return Number(row?.n ?? 0);
    },

    async list(ctx: RequesterContext, caseId: string): Promise<AttachmentDto[]> {
      const rows = await db
        .select({
          id: drAttachments.id,
          filename: assets.originalFilename,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          createdAt: drAttachments.createdAt,
        })
        .from(drAttachments)
        .innerJoin(assets, eq(assets.id, drAttachments.assetId))
        .where(and(eq(drAttachments.companyId, ctx.companyId), eq(drAttachments.caseId, caseId)))
        .orderBy(drAttachments.createdAt);
      return rows.map((r) => ({
        id: r.id,
        filename: r.filename ?? "tep-dinh-kem",
        contentType: r.contentType,
        byteSize: r.byteSize,
        createdAt: r.createdAt.toISOString(),
      }));
    },

    async open(ctx: RequesterContext, caseId: string, attachmentId: string) {
      const [row] = await db
        .select({ objectKey: assets.objectKey, contentType: assets.contentType, filename: assets.originalFilename, byteSize: assets.byteSize })
        .from(drAttachments)
        .innerJoin(assets, eq(assets.id, drAttachments.assetId))
        .where(and(eq(drAttachments.id, attachmentId), eq(drAttachments.caseId, caseId), eq(drAttachments.companyId, ctx.companyId)));
      if (!row) throw notFound("Attachment not found");
      const object = await storage.getObject(ctx.companyId, row.objectKey);
      return { stream: object.stream, contentType: row.contentType, filename: row.filename ?? "tep-dinh-kem", byteSize: row.byteSize };
    },

    /** Best effort: removes assets (and stored objects) that never got linked to a case. */
    async discardAssets(ctx: RequesterContext, assetIds: string[]) {
      if (assetIds.length === 0) return;
      const rows = await db
        .select({ id: assets.id, objectKey: assets.objectKey })
        .from(assets)
        .where(and(inArray(assets.id, assetIds), eq(assets.companyId, ctx.companyId)));
      await db.delete(assets).where(and(inArray(assets.id, assetIds), eq(assets.companyId, ctx.companyId))).catch(() => undefined);
      await Promise.all(rows.map((r) => storage.deleteObject(ctx.companyId, r.objectKey).catch(() => undefined)));
    },
  };
}
