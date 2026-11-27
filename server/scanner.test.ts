import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { discoverReposInFolder } from "./scanner.ts";

describe("discoverReposInFolder", () => {
  it("finds nested git repos up to 3 levels deep and ignores subfolders inside git repos", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mgr-scan-"));
    try {
      const repoA = path.join(tmp, "work", "client-a", "api");
      const subPkg = path.join(repoA, "packages", "shared");
      const repoB = path.join(tmp, "personal", "notes-app");
      await fs.mkdir(path.join(repoA, ".git"), { recursive: true });
      await fs.mkdir(subPkg, { recursive: true });
      await fs.writeFile(path.join(subPkg, "package.json"), "{}", "utf8");
      await fs.mkdir(path.join(repoB, ".git"), { recursive: true });

      const found = await discoverReposInFolder(tmp);
      const names = found.map((f) => f.name).sort();
      assert.deepEqual(names, ["api", "notes-app"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
