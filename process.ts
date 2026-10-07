import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { privateDir } from "./workspace.ts";

export function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

export async function terminate(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  const done = exited(child);
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {}
  };
  kill("SIGTERM");
  const timer = setTimeout(() => kill("SIGKILL"), 3000);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}

export function commandLock(agent: string, root: string, flock?: string, macBun?: string) {
  const path = (flock || macBun) && join(privateDir(agent, "locks"), createHash("sha256").update(root).digest("hex"));
  return async function locked<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!path) return work();
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      // The inherited fd shares our open file description: the lock survives
      // flock's exit and lasts until close(fd), including on process death.
      // macOS has flock(2), but no flock CLI. Bun calls the same fd-based lock.
      const child = flock
        ? spawn(flock, ["--exclusive", "3"], { stdio: ["ignore", "ignore", "pipe", fd] })
        : spawn(macBun!, ["--no-env-file", "--config=/dev/null", "-e",
            `import {dlopen} from 'bun:ffi';const lib=dlopen('/usr/lib/libSystem.B.dylib',{flock:{args:['i32','i32'],returns:'i32'}});process.exit(lib.symbols.flock(3,2)===0?0:1);`],
          { cwd: "/", env: {}, stdio: ["ignore", "ignore", "pipe", fd] });
      const done = exited(child),
        abort = () => {
          child.kill("SIGKILL");
        };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        if ((await done) !== 0) throw Error("Workspace lock acquisition failed.");
        signal?.throwIfAborted();
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      return await work();
    } finally {
      closeSync(fd);
    }
  };
}
