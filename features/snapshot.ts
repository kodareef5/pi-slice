import {
  closeSync, constants, copyFileSync, cpSync, lstatSync, mkdirSync, openSync,
  readdirSync, realpathSync, rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import * as tar from "tar";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exited } from "../process.ts";
import { executable, ignoreRuntime, inside, quote, readWorkspace, resolvePath, staging, writeWorkspace } from "../workspace.ts";

export function captureCommand(bun: string) {
  const list = `const fs=require('node:fs'),p=require('node:path'),root=process.cwd();
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
if(['.pi-runtime','node_modules'].includes(e.name)||e.name.endsWith('.slice'))continue;
const path=p.join(dir,e.name),s=fs.lstatSync(path);if(s.isSymbolicLink()){const link=fs.readlinkSync(path);if(p.isAbsolute(link))throw Error('Absolute symlink: '+path+'. Use a relative project link.');const target=p.resolve(p.dirname(path),link);if(target!==root&&!target.startsWith(root+'/'))continue;}
else if(!s.isDirectory()&&!s.isFile())continue;
process.stdout.write(path+'\\0');if(s.isDirectory())walk(path);}}walk('.');`;
  return `set -o pipefail; ${quote(bun)} --no-env-file --config=/dev/null -e ${quote(list)} | tar --null --no-recursion -T - -cf -`;
}

export async function validate(file: string) {
  let invalid = "";
  const seen = new Set<string>(), links = new Map<string, { target: string; hard: boolean }>();
  await tar.t({ file, strict: true, onReadEntry(entry) {
    const path = posix.normalize(entry.path).replace(/\/$/, "");
    if (isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split("/").includes("..") || seen.has(path))
      invalid = "Unsafe or duplicate archive path.";
    seen.add(path);
    if ((path === "." || path === "") && entry.type !== "Directory") invalid = "Unsupported archive root entry.";
    if (!["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(entry.type))
      invalid = "Unsupported archive entry.";
    if (path.split("/").some(part => [".pi-runtime", "node_modules"].includes(part)))
      invalid = "Runtime files do not belong in a snapshot.";
    if (entry.type === "SymbolicLink" || entry.type === "Link") {
      if (!entry.linkpath || posix.isAbsolute(entry.linkpath) || entry.linkpath.includes("\\"))
        invalid = "Archive link leaves the workspace.";
      links.set(path, { target: entry.linkpath || "", hard: entry.type === "Link" });
    }
  }});
  if (invalid) throw Error(invalid);
  for (const path of links.keys()) {
    const remaining = path.split("/"), resolved: string[] = [];
    const hard = links.get(path)!.hard;
    let followed = 0;
    while (remaining.length) {
      const part = remaining.shift()!;
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!resolved.pop()) throw Error("Archive link leaves the workspace: " + path);
        continue;
      }
      resolved.push(part);
      const link = links.get(resolved.join("/"));
      if (link) {
        if (hard && !link.hard) throw Error("Unsupported archive hardlink to symlink: " + path);
        if (++followed > 40) throw Error("Archive link cycle: " + path);
        if (link.hard) resolved.length = 0; else resolved.pop();
        remaining.unshift(...link.target.split("/"));
      }
    }
  }
}

export async function extract(file: string, cwd: string) {
  await validate(file);
  await tar.x({ file, cwd, strict: true, preservePaths: false, preserveOwner: false, chmod: true,
    filter(_path, entry) { if (entry.mode !== undefined) entry.mode &= 0o777; return true; },
  });
}

export async function unpack(file: string, temp: string, destination: string) {
  if (lstatSync(destination, { throwIfNoEntry: false })) throw Error("Choose a new destination directory.");
  const project = join(temp, "project");
  mkdirSync(project, { mode: 0o700 });
  await extract(file, project);
  const config = readWorkspace(project);
  writeWorkspace(project, { ...config, id: randomUUID() });
  ignoreRuntime(project);
  mkdirSync(destination, { mode: 0o700 });
  try {
    for (const name of readdirSync(project)) cpSync(join(project, name), join(destination, name), {
      recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true,
    });
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

async function crypt(ctx: ExtensionContext, age: string, args: string[], input: string, output: string) {
  const source = openSync(input, "r");
  let target: number | undefined;
  try {
    target = openSync(output, "wx", 0o600);
    const code = await ctx.ui.custom<number | null>(async (tui, _theme, _keys, done) => {
      const interrupt = () => {}; // Ctrl-C cancels age, while Pi stays alive.
      process.on("SIGINT", interrupt);
      tui.stop();
      try {
        done(
          await exited(
            spawn(age, args, {
              stdio: [source, target, "inherit"],
              env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: process.env.TERM },
            }),
          ),
        );
      } finally {
        tui.start();
        process.removeListener("SIGINT", interrupt);
        tui.requestRender(true);
      }
      return { render: () => [], invalidate() {} };
    });
    if (code !== 0) throw Error("Snapshot encryption/decryption failed or was cancelled.");
  } finally {
    closeSync(source);
    if (target !== undefined) closeSync(target);
  }
}

export async function snapshot(
  ctx: ExtensionContext, agent: string, bun: string,
  capture: (command: string, file: string) => Promise<void>, output?: string,
) {
  if (ctx.mode !== "tui") throw Error("Snapshots need interactive Pi for age's masked password prompt.");
  const age = executable("age", ctx.cwd), target = resolvePath(ctx.cwd, output || join("..", basename(ctx.cwd) + ".slice"));
  if (inside(join(realpathSync(dirname(target)), basename(target)), realpathSync(ctx.cwd)))
    throw Error("Save snapshots outside the workspace.");
  if (lstatSync(target, { throwIfNoEntry: false })) throw Error("Choose a new snapshot file.");
  const temp = staging(agent);
  try {
    const contents = join(temp, "workspace.tar"), encrypted = join(temp, "snapshot.slice");
    await capture(captureCommand(bun), contents);
    await validate(contents);
    await crypt(ctx, age, ["-p"], contents, encrypted);
    copyFileSync(encrypted, target, constants.COPYFILE_EXCL);
    return target;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export async function restore(ctx: ExtensionContext, agent: string, input: string, destination: string) {
  if (ctx.mode !== "tui") throw Error("Restore needs interactive Pi for age's masked password prompt.");
  const age = executable("age"), temp = staging(agent);
  try {
    const decrypted = join(temp, "workspace.tar");
    await crypt(ctx, age, ["-d"], resolvePath(ctx.cwd, input), decrypted);
    await unpack(decrypted, temp, destination);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
