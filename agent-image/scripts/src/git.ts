import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import logger from "./logger.ts";
import type { Context } from "./types.ts";

function git(args: string[], input?: string): string {
  return execFileSync("git", args, { encoding: "utf8", input });
}

export function remoteUrl(context: Context): string {
  return `https://${context.host}/${context.projectPath}.git`;
}

export function gitSetup(context: Context): void {
  // Set credential helper to store credentials
  git(["config", "--global", "credential.helper", "store"]);

  // Set author info if provided in context
  if (context.username && context.email) {
    logger.info(`Configuring git user as ${context.username} <${context.email}>`);
    git(["config", "--global", "user.name", context.username]);
    git(["config", "--global", "user.email", context.email]);
  }

  // Prepare credential approval input
  const credentialInput = [
    "protocol=https",
    `host=${context.host}`,
    `username=${context.username}`,
    `password=${context.gitlabToken}`,
    "",
  ].join("\n");

  logger.info(`Configured git for host ${context.host} as user ${context.username}`);

  // Approve credentials for git
  git(["credential", "approve"], credentialInput);

  // Set additional git settings
  git(["config", "--global", "push.autoSetupRemote", "true"]);
  git(["config", "--global", "pull.rebase", "true"]);
}

export function currentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

export function ensureBranch(context: Context): void {
  const branch = context.branch ?? "";
  const cur = currentBranch();
  if (cur !== branch) {
    logger.info(`Checking out branch '${branch}' (was '${cur}')`);
    // Start from the remote branch if there is one. Branching off the current
    // HEAD (the default branch after a clone) and then pulling with rebase
    // would carry the default branch's newer commits into the MR branch.
    const start = fetchBranch(context) ? ["FETCH_HEAD"] : [];
    git(["checkout", "-B", branch, ...start]);
  }

  pullWithToken(context);
}

// False when the branch doesn't exist remotely yet (e.g. a new one for an issue).
function fetchBranch(context: Context): boolean {
  try {
    execFileSync("git", ["fetch", remoteUrl(context), context.branch ?? ""], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function pullWithToken(context: Context): void {
  const url = remoteUrl(context);
  const branch = context.branch ?? "";
  logger.start(`Pulling latest changes from ${context.host}/${context.projectPath}...`);
  try {
    // Use rebase strategy to handle divergent branches
    git(["pull", "--rebase", url, branch]);
    setRemote(context);
  } catch {
    logger.warn("Pull with rebase failed, trying fetch and reset...");
    try {
      // Fetch the remote branch
      git(["fetch", url, branch]);
      // Reset to the remote branch (this will lose local commits, but that's ok for an agent)
      git(["reset", "--hard", "FETCH_HEAD"]);
      setRemote(context);
      logger.info("Successfully synced with remote branch");
    } catch {
      logger.warn("All pull strategies failed, branch might not exist remotely yet");
    }
  }
}

function setRemote(context: Context): void {
  // Set default remote and branch for push
  const url = remoteUrl(context);
  try {
    execFileSync("git", ["remote", "remove", "origin"], { encoding: "utf8", stdio: "ignore" });
  } catch {
    // No origin yet
  }
  logger.info(`Setting remote 'origin' to ${url}`);
  git(["remote", "add", "origin", url]);
}

export function isInsideGitRepo(): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

export function cloneRepository(cloneUrl: string, targetDir: string): void {
  logger.start(`Cloning repository into ${targetDir}...`);
  execFileSync("git", ["clone", cloneUrl, targetDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  logger.success("Clone completed");
}

export function setupLocalRepository(context: Context): void {
  const targetDir = path.resolve(context.checkoutDir);

  if (existsSync(path.join(targetDir, ".git"))) {
    process.chdir(targetDir);
    logger.info(`Using existing checkout at ${targetDir}`);
  } else {
    cloneRepository(remoteUrl(context), targetDir);
    process.chdir(targetDir);
  }

  ensureBranch(context);
}
