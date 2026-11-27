import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { detectVerifyCommand, discoverReposInFolder, installBastionIntoRepo } from "./scanner.ts";

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

  it("detects verify command from package.json and installs Bastion non-destructively", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mgr-bastion-"));
    try {
      await fs.writeFile(
        path.join(tmp, "package.json"),
        JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run", build: "vite build" } }),
        "utf8",
      );
      await fs.writeFile(path.join(tmp, "AGENTS.md"), "# Existing Custom Rules\n", "utf8");

      assert.equal(await detectVerifyCommand(tmp), "npm run lint && npm test && npm run build");
      const res = await installBastionIntoRepo(tmp);
      assert.equal(res.detectedVerifyCmd, "npm run lint && npm test && npm run build");
      const agentsContent = await fs.readFile(path.join(tmp, "AGENTS.md"), "utf8");
      assert.equal(agentsContent, "# Existing Custom Rules\n");
      const learnings = await fs.readFile(path.join(tmp, ".agents", "project-learnings.md"), "utf8");
      assert.ok(learnings.includes("npm run lint && npm test && npm run build"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
