import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentBranch,
  ensureBranch,
  gitSetup,
  isInsideGitRepo,
  remoteUrl,
  setupLocalRepository,
} from "../src/git.ts";
import { buildContext } from "../src/context.ts";
import type { Context } from "../src/types.ts";
import { silenceConsole, tempDir } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// All git state lives in a temp HOME/global config. `https://gitlab.test/`
// is rewritten to a local directory holding a bare `g/p.git` remote with a
// `main` and a `feature` branch.
let home: string;
let remotes: string;

before(() => {
  home = realpathSync(tempDir());
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");

  remotes = join(home, "remotes");
  const seed = join(home, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(seed, "branch", "feature");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "main only");
  execFileSync("git", ["clone", "-q", "--bare", seed, join(remotes, "g", "p.git")]);
  git(home, "config", "--global", `url.file://${remotes}/.insteadOf`, "https://gitlab.test/");
});

beforeEach(silenceConsole);

const context = (env: Record<string, string> = {}): Context => ({
  ...buildContext({
    CI_SERVER_HOST: "gitlab.test",
    AI_PROJECT_PATH: "g/p",
    AI_BRANCH: "feature",
    GITLAB_TOKEN: "secret",
    AI_GITLAB_USERNAME: "bot",
    AI_GITLAB_EMAIL: "bot@example.com",
    ...env,
  }),
  checkoutDir: join(tempDir(), "repo"),
});

describe("remoteUrl", () => {
  it("builds the HTTPS clone URL", () => {
    assert.equal(remoteUrl(context()), "https://gitlab.test/g/p.git");
  });
});

describe("gitSetup", () => {
  it("configures identity, credentials and pull/push defaults", () => {
    gitSetup(context());
    assert.equal(git(home, "config", "--global", "user.name"), "bot");
    assert.equal(git(home, "config", "--global", "user.email"), "bot@example.com");
    assert.equal(git(home, "config", "--global", "credential.helper"), "store");
    assert.equal(git(home, "config", "--global", "push.autoSetupRemote"), "true");
    assert.equal(git(home, "config", "--global", "pull.rebase"), "true");
    assert.equal(readFileSync(join(home, ".git-credentials"), "utf8").trim(), "https://bot:secret@gitlab.test");
  });
});

describe("isInsideGitRepo / currentBranch", () => {
  it("detects a work tree", () => {
    const dir = tempDir();
    process.chdir(dir);
    assert.equal(isInsideGitRepo(), false);
    execFileSync("git", ["init", "-q", "-b", "trunk", dir]);
    assert.equal(isInsideGitRepo(), true);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    assert.equal(currentBranch(), "trunk");
  });
});

describe("setupLocalRepository", () => {
  it("clones, checks out the branch and points origin at GitLab", () => {
    const ctx = context();
    setupLocalRepository(ctx);
    assert.equal(realpathSync(process.cwd()), realpathSync(ctx.checkoutDir));
    assert.equal(currentBranch(), "feature");
    assert.equal(git(".", "log", "-1", "--format=%s"), "init");
    assert.equal(git(".", "config", "--get", "remote.origin.url"), "https://gitlab.test/g/p.git");
  });

  it("reuses an existing checkout", () => {
    const ctx = context();
    setupLocalRepository(ctx);
    git(".", "checkout", "-q", "main");
    process.chdir(home);
    setupLocalRepository(ctx);
    assert.equal(realpathSync(process.cwd()), realpathSync(ctx.checkoutDir));
    assert.equal(currentBranch(), "feature");
  });
});

describe("ensureBranch", () => {
  it("creates a branch that doesn't exist remotely yet without failing", () => {
    setupLocalRepository(context());
    const ctx = context({ AI_BRANCH: "new-branch" });
    assert.doesNotThrow(() => ensureBranch(ctx));
    assert.equal(currentBranch(), "new-branch");
  });

  it("resets to the remote branch when the pull can't rebase", () => {
    const ctx = context();
    setupLocalRepository(ctx);
    // Staged changes make `pull --rebase` refuse to run.
    writeFileSync("file", "x");
    git(".", "add", "file");
    ensureBranch(ctx);
    assert.equal(git(".", "log", "-1", "--format=%s"), "init");
    assert.equal(git(".", "status", "--porcelain"), "");
  });
});
