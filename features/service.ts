import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { commandLock } from "../process.ts";
import { executable, privateDir, readWorkspace, replaceFile } from "../workspace.ts";
import { requirements, type PiHost } from "../sandbox.ts";
import { servicePlatform } from "./service-platform.ts";

export type ServiceRequest = { action: "start" | "status" | "logs" | "stop"; command?: string; preview?: boolean };
export type ServiceConfig = { root: string; pi: PiHost; command: string; preview: boolean };
export type ServiceState = { state: "starting" | "running" | "stopped" | "failed"; command?: string; url?: string; error?: string };

export function serviceText(state: ServiceState & {output?: string}) {
  return [`Service ${state.state}.`, state.url, state.error, state.output].filter(Boolean).join("\n");
}

export function socketPrefix(agent: string) {
  const prefix = join(realpathSync(agent), "pi-slice/sockets/s-");
  if (Buffer.byteLength(prefix + "XXXXXX/in/app") > 100)
    throw Error("Pi state path is too long for a preview socket. Use a shorter PI_CODING_AGENT_DIR.");
  return prefix;
}
export function record(path: string, value: unknown) {
  replaceFile(path, JSON.stringify(value) + "\n");
}

export function servicePaths(root: string, agent: string) {
  const label = "pi-slice-" + createHash("sha256").update(root).digest("hex").slice(0, 24);
  const dir = join(agent, "pi-slice/services", label);
  return {label, dir, state: join(dir, "state.json"), log: join(dir, "output.log"), config: join(dir, "config.json")};
}

function readState(file: string): ServiceState {
  if (!existsSync(file)) return {state: "stopped"};
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return {state: "failed", error: "Unreadable service state. Stop and start the service again."}; }
}

export async function serviceStatus(root: string, pi: PiHost): Promise<ServiceState> {
  const paths = servicePaths(root, pi.agentDir), state = readState(paths.state);
  if (state.state === "running" || state.state === "starting") {
    if (!await servicePlatform(root).active(paths.label)) return {...state, state: "stopped", url: undefined};
  }
  return state;
}

export async function savedServices(pi: PiHost) {
  const dir = join(pi.agentDir, "pi-slice/services");
  if (!existsSync(dir)) return [];
  const services: (ServiceState & {label: string; root?: string})[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isDirectory() || !/^pi-slice-[0-9a-f]{24}$/.test(entry.name)) continue;
    try {
      const config: ServiceConfig = JSON.parse(readFileSync(join(dir, entry.name, "config.json"), "utf8"));
      if (!isAbsolute(config.root) || servicePaths(config.root, pi.agentDir).label !== entry.name)
        throw Error("Invalid workspace path.");
      services.push({label: entry.name, root: config.root, ...await serviceStatus(config.root, pi)});
    } catch {
      services.push({label: entry.name, state: "failed", error: "Invalid service configuration. Repair config.json before stopping this entry from Pi."});
    }
  }
  return services;
}

export async function serviceAction(root: string, pi: PiHost, request: ServiceRequest, signal?: AbortSignal) {
  if (!["start", "status", "logs", "stop"].includes(request.action)) throw Error("Unknown service action.");
  if (request.action === "status") return serviceStatus(root, pi);
  if (request.action === "logs") {
    const paths = servicePaths(root, pi.agentDir);
    const output = existsSync(paths.log) ? readFileSync(paths.log, "utf8").slice(-32000) : "No service output yet.";
    return {...await serviceStatus(root, pi), output};
  }
  const found = request.action === "start" ? requirements(root, pi) : undefined;
  if (found) {
    root = found.root;
    readWorkspace(root);
    if (request.preview !== false) socketPrefix(pi.agentDir);
  }
  const paths = servicePaths(root, pi.agentDir), backend = servicePlatform(root);
  await backend.check();
  let flock: string | undefined;
  if (process.platform === "linux") {
    try { flock = executable("flock", root); }
    catch { flock = executable("/usr/bin/flock", root); }
  }
  const lock = commandLock(pi.agentDir, root + ":service",
    flock,
    process.platform === "darwin" ? executable("bun", root) : undefined);
  return lock(async () => {
    signal?.throwIfAborted();
    if (request.action === "stop") {
      if (await backend.active(paths.label)) await backend.stop(paths.label);
      const state: ServiceState = {...readState(paths.state), state: "stopped", url: undefined};
      if (existsSync(paths.state)) record(paths.state, state);
      return state;
    }
    const command = request.command?.trim();
    if (!command || command.includes("\0") || command.length > 16384) throw Error("Provide a foreground command, for example bun run server.ts.");
    if (await backend.active(paths.label)) {
      const state = readState(paths.state);
      if (state.state === "running" && state.command === command && !!state.url === (request.preview !== false)) return state;
      throw Error("A service is already running or starting here. Stop it before changing its configuration.");
    }
    privateDir(pi.agentDir, "services");
    if (lstatSync(paths.dir, {throwIfNoEntry: false}) && !lstatSync(paths.dir).isDirectory())
      throw Error("Unsafe service state directory.");
    mkdirSync(paths.dir, {recursive: true, mode: 0o700});
    const config: ServiceConfig = {root, pi, command, preview: request.preview !== false};
    record(paths.config, config);
    record(paths.state, {state: "starting", command});
    writeFileSync(paths.log, "", {mode: 0o600});
    try {
      await backend.start(paths.label, ["/usr/bin/env", "-i", "HOME=" + homedir(), "PATH=" + (process.env.PATH || ""),
        found!.tools.node, join(import.meta.dirname, "service-runner.ts"), paths.config], paths.dir);
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const state = readState(paths.state);
        if (state.state === "running") return state;
        if (state.state === "failed" || state.state === "stopped") throw Error(state.error || "Service exited before it was ready. Check /slice logs.");
        if (!await backend.active(paths.label)) throw Error("Service supervisor could not keep the runner alive. Check /slice logs.");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error("Service startup timed out. Preview servers must listen on the Unix socket in PI_SLICE_SOCKET; use preview:false for a worker.");
    } catch (error) {
      await backend.stop(paths.label).catch(() => {});
      record(paths.state, {state: "failed", command, error: error instanceof Error ? error.message : String(error)});
      throw error;
    }
  }, signal);
}
