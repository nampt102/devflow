import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { drSystems, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/secrets.js";
import { getConfiguredSecretProvider } from "../../secrets/configured-provider.js";
import { isOwnerOrAdmin } from "../roles/service.js";

// The catalog of systems (repositories) a company's requests can be about. The BA agent reads the repositories
// of the systems assigned to a request. Everything here ends up in a git command line, so each field is checked
// to be what git expects and nothing more (the database repeats the checks, migration 0359).

export const SYSTEM_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const DOCS_PATH = /^[A-Za-z0-9._\/ -]{0,200}$/;

const branch = z.string().trim().regex(BRANCH).refine((v) => !v.includes("..") && !v.endsWith("/") && !v.endsWith(".lock"), "Invalid branch name");
const docsPath = z.string().trim().regex(DOCS_PATH).refine((v) => !v.startsWith("/") && !v.split("/").includes(".."), "Docs path must stay inside the repository");
const repoUrl = z.string().trim().regex(GITHUB_REPO, "Use a plain https://github.com/<owner>/<repo> URL").transform((v) => v.replace(/\.git$/, ""));
const token = z.string().trim().min(1).max(500);
// agent Dev: the test command runs on the runner by the agent (bash -lc); forbidden paths are repo-relative globs
const testCommand = z.string().trim().min(1).max(500);
const forbiddenPath = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._\/*-]{1,200}$/)
  .refine((v) => !v.startsWith("/") && !v.split("/").includes(".."), "Forbidden paths are relative to the repository");

export const createSystemSchema = z
  .object({
    key: z.string().trim().regex(SYSTEM_KEY),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(""),
    repoUrl,
    defaultBranch: branch.default("main"),
    docsPath: docsPath.default("docs"),
    token: token.optional(),
  })
  .strict();

export const updateSystemSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000),
    defaultBranch: branch,
    docsPath,
    active: z.boolean(),
    // a string replaces the token, null removes it
    token: token.nullable(),
    // agent Dev (add-dev-stage)
    devEnabled: z.boolean(),
    writeToken: token.nullable(),
    testCommand: testCommand.nullable(),
    forbiddenPaths: z.array(forbiddenPath).max(50),
    allowUnprotected: z.boolean(),
  })
  .partial()
  .strict();

export type SystemDto = {
  id: string;
  key: string;
  name: string;
  description: string;
  repoUrl: string;
  defaultBranch: string;
  docsPath: string;
  active: boolean;
  hasToken: boolean;
  devEnabled: boolean;
  hasWriteToken: boolean;
  testCommand: string | null;
  forbiddenPaths: string[];
  allowUnprotected: boolean;
  updatedAt: Date;
};

type Row = typeof drSystems.$inferSelect;

/** The token secret id and any token value never leave the server. */
export const toDto = (row: Row): SystemDto => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  repoUrl: row.repoUrl,
  defaultBranch: row.defaultBranch,
  docsPath: row.docsPath,
  active: row.active,
  hasToken: row.tokenSecretId !== null,
  devEnabled: row.devEnabled,
  hasWriteToken: row.writeTokenSecretId !== null,
  testCommand: row.testCommand,
  forbiddenPaths: row.forbiddenPaths,
  allowUnprotected: row.allowUnprotected,
  updatedAt: row.updatedAt,
});

export type SecretDeps = {
  create(companyId: string, name: string, value: string, userId: string, kind?: "read" | "write"): Promise<string>;
  rotate(companyId: string, secretId: string, value: string, userId: string): Promise<void>;
  remove(secretId: string): Promise<void>;
  /** the secret exists and belongs to the company */
  exists(companyId: string, secretId: string): Promise<boolean>;
};

export function defaultSecretDeps(db: Db): SecretDeps {
  const svc = secretService(db);
  return {
    async create(companyId, name, value, userId, kind = "read") {
      const created = await svc.create(companyId, { name, provider: getConfiguredSecretProvider(), value, description: kind === "write" ? "GitHub write token for the DevFlow Dev agent (branches devflow/* and draft PRs)" : "GitHub read-only token (DevFlow system)" }, { userId, agentId: null });
      return created.id;
    },
    async rotate(_companyId, secretId, value, userId) {
      await svc.rotate(secretId, { value }, { userId, agentId: null });
    },
    async remove(secretId) {
      await svc.remove(secretId);
    },
    async exists(companyId, secretId) {
      const found = await svc.getById(secretId);
      return Boolean(found && found.companyId === companyId && found.status !== "deleted");
    },
  };
}

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && ((error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505");

export function systemsService(db: Db, secrets: SecretDeps = defaultSecretDeps(db)) {
  const find = async (companyId: string, systemId: string): Promise<Row> => {
    const [row] = await db.select().from(drSystems).where(and(eq(drSystems.id, systemId), eq(drSystems.companyId, companyId)));
    if (!row) throw notFound("System not found");
    return row;
  };

  return {
    async list(companyId: string): Promise<SystemDto[]> {
      const rows = await db.select().from(drSystems).where(eq(drSystems.companyId, companyId)).orderBy(asc(drSystems.name), asc(drSystems.key));
      return rows.map(toDto);
    },

    async create(companyId: string, userId: string, input: z.infer<typeof createSystemSchema>): Promise<SystemDto> {
      let tokenSecretId: string | null = null;
      if (input.token) tokenSecretId = await secrets.create(companyId, `devflow-system-${input.key}-${Date.now().toString(36)}`, input.token, userId);
      try {
        const [row] = await db
          .insert(drSystems)
          .values({
            companyId,
            key: input.key,
            name: input.name,
            description: input.description,
            repoUrl: input.repoUrl,
            defaultBranch: input.defaultBranch,
            docsPath: input.docsPath,
            tokenSecretId,
          })
          .returning();
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "system.created",
          entityType: "system",
          entityId: row!.id,
          details: { key: row!.key, repoUrl: row!.repoUrl, hasToken: tokenSecretId !== null },
        });
        return toDto(row!);
      } catch (error) {
        // the secret was stored before the row; do not leave an orphan behind
        if (tokenSecretId) await secrets.remove(tokenSecretId).catch(() => undefined);
        if (isUniqueViolation(error)) throw conflict("A system with this key already exists");
        throw error;
      }
    },

    async update(companyId: string, userId: string, systemId: string, input: z.infer<typeof updateSystemSchema>, instanceAdmin = false): Promise<SystemDto> {
      const current = await find(companyId, systemId);
      const { token: newToken, writeToken: newWriteToken, ...fields } = input;
      // accepting an unprotected default branch is a risk decision: owner or instance admin only
      if (input.allowUnprotected === true && !current.allowUnprotected && !(await isOwnerOrAdmin(db, companyId, { userId, instanceAdmin }))) {
        throw forbidden("Only the company owner can allow Dev on an unprotected branch");
      }
      const hasWriteTokenAfter = newWriteToken === null ? false : typeof newWriteToken === "string" ? true : current.writeTokenSecretId !== null;
      if ((input.devEnabled ?? current.devEnabled) && !hasWriteTokenAfter) {
        throw unprocessable("Enabling the Dev agent needs a write token");
      }
      const set: Partial<typeof drSystems.$inferInsert> = { ...fields, updatedAt: new Date() };
      const removeSecretIds: string[] = [];
      if (typeof newToken === "string") {
        if (current.tokenSecretId && (await secrets.exists(companyId, current.tokenSecretId))) {
          await secrets.rotate(companyId, current.tokenSecretId, newToken, userId);
        } else {
          set.tokenSecretId = await secrets.create(companyId, `devflow-system-${current.key}-${Date.now().toString(36)}`, newToken, userId);
        }
      } else if (newToken === null && current.tokenSecretId) {
        set.tokenSecretId = null;
        removeSecretIds.push(current.tokenSecretId);
      }
      if (typeof newWriteToken === "string") {
        if (current.writeTokenSecretId && (await secrets.exists(companyId, current.writeTokenSecretId))) {
          await secrets.rotate(companyId, current.writeTokenSecretId, newWriteToken, userId);
        } else {
          set.writeTokenSecretId = await secrets.create(companyId, `devflow-system-${current.key}-write-${Date.now().toString(36)}`, newWriteToken, userId, "write");
        }
      } else if (newWriteToken === null && current.writeTokenSecretId) {
        set.writeTokenSecretId = null;
        removeSecretIds.push(current.writeTokenSecretId);
      }
      const [row] = await db
        .update(drSystems)
        .set(set)
        .where(and(eq(drSystems.id, systemId), eq(drSystems.companyId, companyId)))
        .returning();
      if (!row) throw notFound("System not found");
      for (const id of removeSecretIds) await secrets.remove(id).catch(() => undefined);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: input.active === false ? "system.deactivated" : "system.updated",
        entityType: "system",
        entityId: systemId,
        // field names only, never the token
        details: { key: current.key, fields: Object.keys(input) },
      });
      return toDto(row);
    },
  };
}
