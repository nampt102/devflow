import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTransferProgress, streamSshToLocalFile } from "./ssh.js";

// A large stream from `ssh` must reach the local file whole (found by the DevFlow Dev stage: the git history export of a 34 MB
// repository ended at about 23 MB, so `git fetch` of the bundle died with "early EOF"). The fake `ssh` below writes a known
// amount as fast as it can, like a runner on the same network; the progress counter sits between the pipe and the file.
const SIZE = 60 * 1024 * 1024;

describe("streamSshToLocalFile", () => {
  let dir: string;
  let oldPath: string | undefined;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-ssh-"));
    await fs.writeFile(path.join(dir, "ssh"), `#!/bin/sh\nhead -c ${SIZE} /dev/zero\n`, { mode: 0o755 });
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
  });

  afterAll(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const spec = { host: "h", port: 22, username: "u", remoteWorkspacePath: "/w", privateKey: null, knownHosts: null, strictHostKeyChecking: false };

  it("writes every byte when progress is reported", async () => {
    for (let i = 0; i < 5; i++) {
      const file = path.join(dir, `out-${i}.bin`);
      const progress = createTransferProgress({ onProgress: () => undefined, phase: "Exporting git history", direction: "from", totalBytes: null, estimated: false });
      await streamSshToLocalFile({ spec, remoteScript: "true", localFile: file, progress });
      await progress.finish();
      expect((await fs.stat(file)).size, `run ${i}`).toBe(SIZE);
    }
  });

  it("writes every byte without progress too", async () => {
    const file = path.join(dir, "plain.bin");
    await streamSshToLocalFile({ spec, remoteScript: "true", localFile: file });
    expect((await fs.stat(file)).size).toBe(SIZE);
  });

  it("fails, and does not claim success, when ssh exits with an error", async () => {
    await fs.writeFile(path.join(dir, "ssh"), `#!/bin/sh\nhead -c 1000 /dev/zero\necho boom >&2\nexit 7\n`, { mode: 0o755 });
    await expect(streamSshToLocalFile({ spec, remoteScript: "true", localFile: path.join(dir, "bad.bin") })).rejects.toThrow(/boom/);
    await fs.writeFile(path.join(dir, "ssh"), `#!/bin/sh\nhead -c ${SIZE} /dev/zero\n`, { mode: 0o755 });
  });
});
