import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound, unauthorized, unprocessable } from "../../errors.js";
import type { StorageService } from "../../storage/types.js";
import { assertCompanyAccess } from "../../routes/authz.js";
import { MAX_FILES_PER_REQUEST, MAX_FILE_BYTES, cleanFilename, type UploadedFile } from "./attachments.js";
import { pipelineService } from "../../services/pipelines.js";
import { INVITE_TOKEN_PATTERN, portalInvites } from "./invites.js";
import { portalService } from "./portal-service.js";
import { ipRateLimit } from "./rate-limit.js";
import { requireRequester } from "./requester-guard.js";

// Unknown keys (stageKey, priority, fields...) are stripped: a requester cannot set internal data.
const submitSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8_000),
  businessImpact: z.string().trim().max(4_000).nullish(),
});
const inviteSchema = z.object({ label: z.string().trim().max(200).nullish() });
// Same password bounds as better-auth (8 to 128); the password is never trimmed.
const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().max(254).email(),
  password: z.string().min(8).max(128),
});
export type PortalRouteOptions = { rateLimit?: { max: number; windowMs: number } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Company staff who may issue portal invitations: board members who are not viewers. */
function assertInviteManager(req: Request, companyId: string): string {
  assertCompanyAccess(req, companyId);
  const actor = req.actor;
  if (actor.type !== "board") throw forbidden("Board access required");
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return actor.userId ?? "local-board";
  const membership = actor.memberships?.find((m) => m.companyId === companyId && m.status === "active");
  if (!membership || membership.membershipRole === "viewer" || !actor.userId) {
    throw forbidden("Not allowed to manage portal invitations");
  }
  return actor.userId;
}

/** /api/portal/* for requesters and /api/companies/:id/portal/invites for staff (openspec/decisions/0011). */
export function portalRoutes(db: Db, storage: StorageService, options: PortalRouteOptions = {}) {
  const router = Router();
  const attemptLimit = ipRateLimit(options.rateLimit ?? { max: 10, windowMs: 60_000 });
  const service = portalService(db, { ingestCase: (input) => pipelineService(db).ingestCase(input), storage });
  const invites = portalInvites(db);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST } });
  // multipart only when the client sends it; JSON bodies are already parsed. Field name: "files".
  const readFiles: RequestHandler = (req, res, next) => {
    if (!req.is("multipart/form-data")) return next();
    upload.array("files", MAX_FILES_PER_REQUEST)(req, res, (err: unknown) => {
      if (!(err instanceof multer.MulterError)) return next(err as Error | undefined);
      if (err.code === "LIMIT_FILE_SIZE") return next(unprocessable("File is larger than 10 MB", { code: "file_too_large" }));
      if (err.code === "LIMIT_FILE_COUNT") return next(unprocessable("Too many files", { code: "too_many_files" }));
      return next(badRequest(err.message));
    });
  };
  const filesOf = (req: Request) => ((req as Request & { files?: UploadedFile[] }).files ?? []) as UploadedFile[];
  const guard = requireRequester(db);

  // ---- invitations: staff side ------------------------------------------------------------------
  router.post("/companies/:companyId/portal/invites", async (req, res) => {
    const companyId = String(req.params.companyId);
    const actorId = assertInviteManager(req, companyId);
    const parsed = inviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Invalid invitation", parsed.error.flatten());
    res.status(201).json(await invites.create(companyId, actorId, parsed.data));
  });

  router.get("/companies/:companyId/portal/invites", async (req, res) => {
    const companyId = String(req.params.companyId);
    assertInviteManager(req, companyId);
    res.json({ items: await invites.list(companyId) });
  });

  router.post("/companies/:companyId/portal/invites/:inviteId/revoke", async (req, res) => {
    const companyId = String(req.params.companyId);
    const actorId = assertInviteManager(req, companyId);
    const inviteId = String(req.params.inviteId);
    if (!UUID.test(inviteId)) throw notFound("Invitation not found or no longer pending");
    res.json(await invites.revoke(companyId, actorId, inviteId));
  });

  // ---- invitations: the invited person (any signed-in user; this is how they become a requester) ---
  // Creates the account and the requester in one step, so it works while public sign-up is closed.
  // No session needed: the single-use token is the credential. The client signs in afterwards.
  router.post("/portal/invites/:token/register", attemptLimit, async (req, res) => {
    const token = String(req.params.token);
    if (!INVITE_TOKEN_PATTERN.test(token)) throw notFound("Invalid invitation link");
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid registration", parsed.error.flatten());
    res.status(201).json(await invites.register({ token, ...parsed.data }));
  });

  router.post("/portal/invites/:token/accept", attemptLimit, async (req, res) => {
    const actor = req.actor;
    if (!actor || actor.type !== "board" || actor.source !== "session" || !actor.userId) {
      throw unauthorized("Sign in to accept the invitation");
    }
    const token = String(req.params.token);
    if (!INVITE_TOKEN_PATTERN.test(token)) throw notFound("Invalid invitation link");
    res.json(await invites.accept(actor.userId, token));
  });

  // ---- requester API ----------------------------------------------------------------------------
  router.get("/portal/me", guard, (_req, res) => {
    const { companyId, requesterId } = res.locals.requester!;
    res.json({ companyId, requesterId });
  });

  router.post("/portal/requests", guard, readFiles, async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request", parsed.error.flatten());
    res.status(201).json(await service.submit(res.locals.requester!, parsed.data, filesOf(req)));
  });

  router.get("/portal/requests", guard, async (req, res) => {
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset);
    res.json({
      items: await service.list(res.locals.requester!, {
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      }),
    });
  });

  router.get("/portal/requests/:number", guard, async (req, res) => {
    const number = Number(req.params.number);
    if (!Number.isInteger(number) || number < 1) throw badRequest("Invalid request number");
    res.json(await service.get(res.locals.requester!, number));
  });

  router.post("/portal/requests/:number/attachments", guard, readFiles, async (req, res) => {
    const number = Number(req.params.number);
    if (!Number.isInteger(number) || number < 1) throw badRequest("Invalid request number");
    const uploads = filesOf(req);
    if (uploads.length === 0) throw badRequest("Missing files");
    res.status(201).json(await service.addAttachments(res.locals.requester!, number, uploads));
  });

  router.get("/portal/requests/:number/attachments/:attachmentId", guard, async (req, res) => {
    const number = Number(req.params.number);
    const attachmentId = String(req.params.attachmentId);
    if (!Number.isInteger(number) || number < 1 || !/^[0-9a-f-]{36}$/i.test(attachmentId)) throw badRequest("Invalid id");
    const file = await service.openAttachment(res.locals.requester!, number, attachmentId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(file.byteSize));
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(cleanFilename(file.filename)));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    file.stream.on("error", () => res.destroy());
    file.stream.pipe(res);
  });

  return router;
}
