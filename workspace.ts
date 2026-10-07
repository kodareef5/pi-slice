import {
  constants, accessSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export type Workspace = { version: 1; id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
export const inside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
export const resolvePath = (root: string, path: string) =>
  resolve(root, path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

export function readWorkspace(root: string): Workspace {
  const path = join(root, ".pi-work");
  if (!lstatSync(path).isFile()) throw Error(".pi-work must be a plain file.");
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw Error("Invalid .pi-work JSON.");
  }
  if (
    !config ||
    config.version !== 1 ||
    typeof config.id !== "string" ||
    !uuid.test(config.id) ||
    Object.keys(config).some((key) => !["version", "id"].includes(key))
  ) {
    throw Error("Unsupported .pi-work configuration.");
  }
  return config;
}

// Replace the directory entry; never truncate an archived hardlink or follow a symlink.
function replaceFile(path: string, contents: string, mode = 0o600) {
  const temp = join(dirname(path), ".pi-work-" + randomUUID());
  try {
    writeFileSync(temp, contents, { flag: "wx", mode });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function writeWorkspace(root: string, config: Workspace) {
  replaceFile(join(root, ".pi-work"), JSON.stringify(config) + "\n");
}

export function ignoreRuntime(root: string) {
  const path = join(root, ".gitignore"),
    stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw Error(".gitignore must be a plain file.");
  const text = stat ? readFileSync(path, "utf8") : "";
  if (!text.split(/\r?\n/).includes(".pi-runtime/"))
    replaceFile(
      path,
      text + (text && !text.endsWith("\n") ? "\n" : "") + ".pi-runtime/\n",
      stat ? stat.mode & 0o777 : 0o600,
    );
}

export function privateDir(agent: string, name: string) {
  const base = join(agent, "pi-work"),
    dir = join(base, name);
  for (const path of [base, dir]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw Error("Unsafe pi-work state directory.");
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function staging(agent: string) {
  const base = privateDir(agent, "staging");
  for (const entry of readdirSync(base)) {
    const match = /^(\d+)-[0-9a-f-]{36}-[A-Za-z0-9]+$/.exec(entry);
    if (!match) continue;
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        rmSync(join(base, entry), { recursive: true, force: true });
    }
  }
  return mkdtempSync(join(base, process.pid + "-" + randomUUID() + "-"));
}

export function executable(name: string, root?: string) {
  const path = (process.env.PATH || "")
    .split(":")
    .map((dir) => resolve(dir, name))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    });
  if (!path) throw Error(`Missing ${name}. Install it and add it to PATH.`);
  const real = realpathSync(path);
  if (root && inside(real, root)) throw Error(`${name} must be installed outside the workspace.`);
  return real;
}
