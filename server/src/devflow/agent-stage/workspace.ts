import fs from "node:fs/promises";
import path from "node:path";
import type { cloneSystem } from "../systems/workspace.js";
import { claudeTranscriptsDir, stageWorkspaceDir, type StageRole } from "./agent.js";
import { StageFailure } from "./failure.js";

// The folder a stage agent works in: `repos/<system key>/` (shallow clones) and `.devflow/request.md`. It is emptied,
// together with Claude Code's transcripts of it, before and after every run: only the request being worked on is
// ever on disk.

export type WorkspaceSystem = { key: string; repoUrl: string; branch: string; docsPath: string; tokenSecretId: string | null };
export type ClonedSystem = { key: string; docsPath: string; sha: string };

export function stageWorkspace(opts: {
  role: StageRole;
  root: string;
  claudeHome: string;
  clone: typeof cloneSystem;
  /** reads the token of a system's secret; null when the secret is gone */
  resolveToken: (companyId: string, secretId: string) => Promise<string | null>;
}) {
  const dir = stageWorkspaceDir(opts.role, opts.root);
  const transcripts = claudeTranscriptsDir(dir, opts.claudeHome);

  async function reset() {
    try {
      await fs.rm(transcripts, { recursive: true, force: true });
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.join(dir, ".devflow"), { recursive: true });
      await fs.mkdir(path.join(dir, "repos"), { recursive: true });
    } catch {
      throw new StageFailure("workspace_failed");
    }
  }

  async function cloneAll(companyId: string, systems: readonly WorkspaceSystem[]): Promise<ClonedSystem[]> {
    const out: ClonedSystem[] = [];
    for (const s of systems) {
      let token: string | null = null;
      if (s.tokenSecretId) {
        token = await opts.resolveToken(companyId, s.tokenSecretId).catch(() => null);
        if (!token) throw new StageFailure("system_missing_token");
      }
      try {
        const { sha } = await opts.clone({ repoUrl: s.repoUrl, branch: s.branch, dest: path.join(dir, "repos", s.key), token });
        out.push({ key: s.key, docsPath: s.docsPath, sha });
      } catch (err) {
        throw new StageFailure((err as Error).message === "clone_timeout" ? "clone_timeout" : "clone_failed");
      }
    }
    return out;
  }

  async function writeRequest(text: string) {
    await fs.writeFile(path.join(dir, ".devflow", "request.md"), text, "utf8").catch(() => {
      throw new StageFailure("workspace_failed");
    });
  }

  async function clear() {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(transcripts, { recursive: true, force: true }).catch(() => undefined);
  }

  return { dir, reset, cloneAll, writeRequest, clear };
}
