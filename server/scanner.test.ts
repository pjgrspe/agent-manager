import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { discoverReposInFolder } from "./scanner.ts";

describe("discoverReposInFolder", () => {
  it("finds nested git repos and non-git project folders up to 3 levels deep", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mgr-scan-"));
    try {
      const nestedGit = path.join(tmp, "work", "client-a", "api");
      const nonGitProj = path.join(tmp, "personal", "notes-app");
      await fs.mkdir(path.join(nestedGit, ".git"), { recursive: true });
      await fs.mkdir(nonGitProj, { recursive: true });
      await fs.writeFile(path.join(nonGitProj, "package.json"), "{}", "utf8");

      const found = await discoverReposInFolder(tmp);
      const names = found.map((f) => f.name).sort();
      assert.deepEqual(names, ["api", "notes-app"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
