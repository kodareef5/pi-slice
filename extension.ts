import { constants, createWriteStream, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  VERSION, getAgentDir, getPackageDir, createLocalBashOperations, createBashToolDefinition,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createMcpExtension, loadSkills, parseArgs, SessionManager,
  type ExtensionAPI, type ExtensionContext, type BashOperations, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { Type } from "@earendil-works/pi-ai";
import { executable, ignoreRuntime, inside, quote, readWorkspace, resolvePath, writeWorkspace } from "./workspace.ts";
import { commandLock, exited, terminate } from "./process.ts";
import { present, requirements as inspectRequirements, prepareRuntime, policy, probeCode } from "./sandbox.ts";
import { savedServices, serviceAction, serviceStatus, serviceText, socketPrefix } from "./features/service.ts";
import { servicePlatform } from "./features/service-platform.ts";
import { enterProfile } from "./features/launch.ts";
import { parseProfile, profilePath, readProfile, saveProfile } from "./features/profile.ts";

const packageRoot = import.meta.dirname;
const toolNames = ["read", "bash", "edit", "write", "slice_service"];
const piHost = () => ({ version: VERSION, agentDir: getAgentDir(), packageDir: getPackageDir() });
const requirements = (cwd: string) => inspectRequirements(cwd, piHost());

const marked = (cwd: string) => present(join(cwd, ".pi-slice"));

function imageType(data: Buffer) {
  const hex = data.subarray(0, 8).toString("hex"),
    ascii = data.subarray(0, 12).toString("ascii");
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex === "89504e470d0a1a0a") return "image/png";
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.endsWith("WEBP")) return "image/webp";
  if (ascii.startsWith("BM")) return "image/bmp";
  return null;
}

export default function slice(pi: ExtensionAPI) {
  pi.registerFlag("slice", {type: "boolean", description: "Restart with this workspace's minimal Slice configuration"});
  const profile = enterProfile(packageRoot);
  const profileRoot = profile ? realpathSync(process.cwd()) : undefined;
  const configuration = profile ? "Slice" : "normal Pi";
  const extraTools = profile?.tools ?? [];
  const mcpEnabled = !!profile && !parseArgs(process.argv.slice(2)).noMcp && Object.keys(profile.mcpServers).length > 0;
  const mcpPrefixes = mcpEnabled ? Object.keys(profile!.mcpServers).map(name => "mcp__" + name.replaceAll("-", "_") + "__") : [];
  const allowed = (name: string) => toolNames.includes(name) || extraTools.includes(name) ||
    mcpPrefixes.some(prefix => name.startsWith(prefix)) ||
    (mcpEnabled && ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name));
  let ready = false,
    root = "",
    failure = "Sandbox is not ready.",
    runtime = "not initialized",
    manager: typeof SandboxManager | undefined;
  let operations: BashOperations | undefined;
  let capture: ((command: string, file: string) => Promise<void>) | undefined;
  let lock: ReturnType<typeof commandLock> | undefined;
  const shutdown = new AbortController();
  const protectedContext = (ctx: ExtensionContext) => !!root || marked(ctx.cwd);
  const check = (ctx: ExtensionContext) => {
    if (!ready || realpathSync(ctx.cwd) !== root)
      throw Error(`pi-slice: ${ready ? "Workspace changed; restart Pi." : failure}`);
  };
  pi.on("project_trust", (_event, ctx) => ({ trusted: marked(ctx.cwd) ? "no" : "undecided" }));
  if (profile) pi.on("session_before_switch", (event, ctx) => {
    if (event.reason === "resume" && event.targetSessionFile && realpathSync(SessionManager.open(event.targetSessionFile).getCwd()) !== profileRoot) {
      ctx.ui.notify("This session belongs to another workspace. Start pi --slice in that directory to use its configuration.", "warning");
      return {cancel: true};
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!ready || realpathSync(ctx.cwd) !== root) return;
    event.systemPromptOptions.sections.pi_slice = `You are in a Pi Slice workspace: ${root}.
Pi keeps normal auth and sessions. Your read, bash, edit and write tools run inside an OS sandbox.
Configuration: ${configuration}. Additional tools explicitly enabled by the user, including MCP servers, have their own permissions outside this sandbox.
Bash, Bun (including TypeScript and bun:sqlite), Node/npm (including node:sqlite), Git and rg are available. Check other tools such as Python before relying on them.
Default to Bun and TypeScript for new scripts and web projects: Bun.serve, Bun.file, bun run and bun add when dependencies are needed. Follow an existing project's stack or the user's preference.
Match the requested scope. A basic HTML dashboard usually needs only index.html and a tiny server.ts, without framework scaffolding, custom APIs or a test harness. Inspect relevant project files; skip routine host/tool inventories. Do not assume Git is initialized.${process.platform === "darwin" ? " On macOS, new Git repositories must be initialized by the user in the host terminal; protected hooks/config prevent sandboxed git init. Git add/commit work for existing repositories." : ""}
Project secrets remain readable; writes are limited to the workspace. Homes and Pi state are hidden; other host paths are generally read-only. Internet and local/LAN services are reachable through proxies. Linux permits Unix sockets on visible paths.
HOME, caches and scratch files live under .pi-runtime. ${process.platform === "linux" ? "Background processes end with each shell command; run a server and its checks in the same command. Sandbox localhost is separate from the host browser." : "Local network binding is restricted."} Use git add <paths>; sandbox placeholders can break git add -A.
Use slice_service to start, inspect, read logs or stop one background service for this workspace when the user asks. It survives Pi/terminal exit, using systemd on Linux or launchd on macOS; unsupported hosts get an explanation. No automatic restart after reboot.
For a browser preview, configure Bun.serve({ unix: process.env.PI_SLICE_SOCKET, fetch }) and call slice_service with action:"start", command:"bun run server.ts". Return its localhost URL. Use preview:false for a worker. Keep the command in the foreground; do not use &, nohup or PM2. Starting the service is enough; the user need not keep a terminal open.
Background services read project files but write only to their private HOME/cache/TMPDIR/XDG_DATA_HOME. Install dependencies and build assets with normal tools first. Service runtime data stays on this machine and is not exported. Existing service code changes may need stop/start. Do not bypass an unavailable supervisor by running project code unsandboxed.
These are user commands entered in Pi, not shell commands:
/slice — status; /slice doctor — requirements and diagnostics; /slice init [new] — initialize (new resets identity; first setup exits Pi for restart).
/slice export [file.slice] — encrypted assets and Git, excluding runtime/dependencies; no Pi account or conversation collection.
/slice import <file.slice> <new-directory> — restore assets with a fresh workspace ID. Both transfer commands require the user's interactive password prompt.
/slice run <command> — start a Unix-socket preview; /slice run --background <command> — start a worker; /slice logs and /slice stop — service controls.
/slice services — user-only inventory; /slice stop <service-id> also works from unmarked Pi to stop a deleted workspace's service.
/slice config — user-only editor for this workspace's extensions, skills, prompts, extra tools and MCP servers. Configuration changes require restarting pi --slice.
You can build and test TypeScript/Bun dashboards. Cloudflare publishing or sharing needs a separate authenticated setup; Pi Slice provides no deployment or sharing command. Guide the user through host-side authentication without copying credentials into the workspace.
Pi documentation and skill paths listed elsewhere may be hidden. Use this section for Pi Slice help instead of searching host directories.`;
  });
  pi.on("tool_call", (event, ctx) => {
    if (protectedContext(ctx) && (!ready || !allowed(event.toolName) || realpathSync(ctx.cwd) !== root))
      return { block: true, reason: `pi-slice: ${ready ? "Only read, bash, edit, write, slice_service and explicitly configured tools are allowed." : failure}` };
  });
  pi.on("user_bash", (_event, ctx) => {
    if (!protectedContext(ctx)) return;
    try {
      check(ctx);
      return { operations: operations! };
    } catch (error) {
      return { result: { output: String(error), exitCode: 1, cancelled: false, truncated: false } };
    }
  });
  pi.on("session_shutdown", async () => {
    ready = false;
    shutdown.abort();
    if (manager && lock) await lock(() => manager!.reset());
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!profile && !marked(ctx.cwd)) return;
    root = ctx.cwd;
    try {
      if (profile && realpathSync(ctx.cwd) !== profileRoot)
        throw Error("Slice configuration belongs to another workspace. Restart pi --slice in this directory.");
      const found = requirements(ctx.cwd);
      root = found.root;
      runtime = `Bun ${found.bunVersion} / Node ${found.nodeVersion}`;
      readWorkspace(root);
      lock = commandLock(getAgentDir(), root, found.tools.flock,
        process.platform === "darwin" ? found.tools.bun : undefined);
      const env = await lock(async () => {
        const env = prepareRuntime(join(root, ".pi-runtime"), found.tools);
        manager = (await import("@anthropic-ai/sandbox-runtime")).SandboxManager;
        const rules = policy(root, found.tools, getAgentDir());
        if (profile) for (const skill of loadSkills({cwd: root, agentDir: getAgentDir(),
          skillPaths: parseArgs(process.argv.slice(2)).skills ?? [], includeDefaults: false}).skills) {
          // Selected skills need their instructions and bundled assets. Loose
          // Markdown files grant access only to that file, not its parent.
          rules.filesystem.allowRead.push(realpathSync(basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath));
        }
        await manager.initialize(rules);
        return env;
      });
      const run = <T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
        const combined = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
        return lock!(async () => {
          try {
            return await work(combined);
          } finally {
            manager!.cleanupAfterCommand();
          }
        }, combined);
      };
      const local = createLocalBashOperations({ shellPath: "/bin/bash" });
      // Reapply HOME/TMPDIR inside the sandbox: its runtime may set its own temporary directory.
      // Sandbox-runtime resolves its mandatory denies against process.cwd().
      let wrapping: Promise<unknown> = Promise.resolve();
      const wrap = (command: string, signal?: AbortSignal) => {
        const result = wrapping.then(async () => {
          const before = process.cwd();
          try {
            process.chdir(root);
            return await manager!.wrapWithSandbox(
              `umask 077; export HOME=${quote(env.HOME!)} TMPDIR=${quote(env.TMPDIR!)}; ${command}`,
              "/bin/bash", undefined, signal,
            );
          } finally { process.chdir(before); }
        });
        wrapping = result.catch(() => {});
        return result;
      };
      const execute = (command: string, options: {input?: string; file?: string; signal?: AbortSignal} = {}) =>
        run(async signal => {
          const child = spawn("/bin/bash", ["-c", await wrap(command, signal)], {
            cwd: root, env, detached: true, stdio: "pipe",
          });
          const done = exited(child), chunks: Buffer[] = [];
          void done.catch(() => {});
          let stderr = "", size = 0;
          const abort = () => { void terminate(child); };
          const timer = options.file ? undefined : setTimeout(abort, 10000);
          signal.addEventListener("abort", abort, {once: true});
          if (signal.aborted) abort();
          const output = options.file
            ? pipeline(child.stdout, createWriteStream(options.file, {flags: "wx", mode: 0o600}))
            : Promise.resolve(child.stdout.on("data", data => {
                size += data.length;
                if (size > 64 * 1024 * 1024) abort(); else chunks.push(data);
              }));
          child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
          child.stdin.on("error", () => {});
          child.stdin.end(options.input);
          try {
            const [code] = await Promise.all([done, output]);
            signal.throwIfAborted();
            if (code === 0 && size <= 64 * 1024 * 1024) return Buffer.concat(chunks);
            let detail: {message?: string; code?: string} = {};
            try { detail = JSON.parse(stderr); } catch {}
            throw Object.assign(Error(detail.message || stderr.trim() || "Sandbox command failed."), {code: detail.code});
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            await terminate(child);
          }
        }, options.signal);
      capture = async (command, file) => { await execute(command, {file}); };
      operations = {
        exec(command, cwd, options) {
          if (realpathSync(cwd) !== root) throw Error("Workspace changed; restart Pi.");
          return run(
            async (signal) => local.exec(await wrap(command, signal), root, { ...options, signal, env }),
            options.signal,
          );
        },
      };
      const bun = `${quote(found.tools.bun)} --no-env-file --config=/dev/null`;
      const smoke = probeCode(env, found.nodeVersion, getAgentDir());
      let output = "";
      const probe = await operations.exec(`${bun} -e ${quote(smoke)}`, root, {
        onData: (data) => {
          output += data;
        },
        timeout: 10,
      });
      if (probe.exitCode !== 0 || output.trim() !== "PI_SLICE_OK")
        throw Error("Sandbox startup probe failed. " + output.slice(-1200));

      // File I/O runs inside the sandbox. JSON stdin keeps file contents out of shell arguments.
      const ioScript = `try {
const[op,path,data]=JSON.parse(await Bun.stdin.text()),fs=require('node:fs');
let result;
if(op==='signature'){const fd=fs.openSync(path,'r');try{result=Buffer.alloc(12);result=result.subarray(0,fs.readSync(fd,result,0,12,0));}finally{fs.closeSync(fd);}}
else result=fs[op](path,data ?? undefined);
if(Buffer.isBuffer(result))process.stdout.write(result);
}catch(e){process.stderr.write(JSON.stringify({code:e.code,message:e.message}));process.exitCode=1;}`;
      const io = (op: string, path: string, data: unknown, signal?: AbortSignal) =>
        execute(`${bun} -e ${quote(ioScript)}`, {input: JSON.stringify([op, path, data]), signal});
      const files = (signal?: AbortSignal, edit = false) => ({
        readFile: (path: string) => io("readFileSync", path, undefined, signal),
        writeFile: async (path: string, data: string) => {
          await io("writeFileSync", path, data, signal);
        },
        mkdir: async (path: string) => {
          await io("mkdirSync", path, { recursive: true, mode: 0o700 }, signal);
        },
        access: async (path: string) => {
          await io("accessSync", path, edit ? constants.R_OK | constants.W_OK : constants.R_OK, signal);
        },
        detectImageMimeType: async (path: string) => imageType(await io("signature", path, undefined, signal)),
      });
      const definitions: ((signal?: AbortSignal) => ToolDefinition<any, any>)[] = [
        () => createBashToolDefinition(root, { operations, exposeSessionEnvironment: false }),
        ...[createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition].map(
          (create) => (signal?: AbortSignal) =>
            create(root, { operations: files(signal, create === createEditToolDefinition) }),
        ),
      ];
      for (const definition of definitions)
        pi.registerTool({
          ...definition(),
          async execute(id, params, signal, update, ctx) {
            check(ctx);
            return definition(signal).execute(id, params as never, signal, update as never, ctx);
          },
        });
      pi.registerTool({
        name: "slice_service",
        label: "Workspace service",
        description: "Manage this workspace's sandboxed background service. Start only when the user asks to run/host an app or worker. Preview apps must listen on the Unix socket in PI_SLICE_SOCKET; Bun.serve({unix: process.env.PI_SLICE_SOCKET, fetch}) works. Project code is read-only; HOME, TMPDIR and XDG_DATA_HOME are writable private runtime. Use preview:false for workers. No host commands or credentials are exposed.",
        promptSnippet: "Start, inspect, read logs or stop a sandboxed service that survives Pi exiting.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("logs"), Type.Literal("stop")]),
          command: Type.Optional(Type.String({description: "Foreground shell command; required to start."})),
          preview: Type.Optional(Type.Boolean({description: "Default true: expose a localhost HTTP preview via PI_SLICE_SOCKET. False for a worker."})),
        }),
        async execute(_id, params, signal, _update, ctx) {
          check(ctx);
          const result = await serviceAction(root, piHost(), params, signal);
          return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
        },
      });
      pi.setActiveTools([...toolNames, ...extraTools, ...pi.getActiveTools().filter(name => mcpPrefixes.some(prefix => name.startsWith(prefix)))]);
      ready = true;
      ctx.ui.setStatus("pi-slice", `🔒 Sandbox active · ${configuration} configuration`);
      if (!profile) ctx.ui.notify("Slice sandbox active; using your normal Pi configuration. Other extensions may operate outside the sandbox. Run pi --slice for this workspace's minimal configuration.", "warning");
    } catch (error) {
      ready = false;
      failure = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus("pi-slice", "⛔ Pi Slice · tools blocked");
      ctx.ui.notify(`pi-slice: ${failure} Tools are blocked. Run /slice doctor.`, "error");
    }
  });

  pi.registerCommand("slice", {
    description: "Workspace status, init, config, doctor, run, logs, stop, services, export, import",
    async handler(args, ctx) {
      try {
        const run = /^run(?:\s+(--background))?\s+([\s\S]+)$/.exec(args.trim());
        if (run) {
          check(ctx);
          const result = await serviceAction(root, piHost(), {action: "start", command: run[2], preview: !run[1]}, ctx.signal);
          ctx.ui.notify(serviceText(result), "info");
          return;
        }
        const words = args.match(/"[^"]*"|'[^']*'|[^\s"']+/g) || [];
        const [command = "", ...values] = words.map(word => word.replace(/^["']|["']$/g, ""));
        const limits: Record<string, number> = { "": 0, init: 1, config: 0, doctor: 0, logs: 0, stop: 1, services: 0, export: 1, import: 2 };
        if (!Object.hasOwn(limits, command) || values.length > limits[command])
          throw Error("Use /slice, init [new], config, doctor, run [--background] <command>, logs, stop [service-id], services, export [file.slice], or import <file.slice> <new-directory>.");
        if (command === "config") {
          const found = requirements(ctx.cwd), current = readProfile(found.root, getAgentDir());
          const path = profilePath(found.root, getAgentDir());
          saveProfile(found.root, getAgentDir(), current, true);
          if (ctx.mode !== "tui") {
            ctx.ui.notify(`Slice configuration: ${path}\nEdit this file from your host terminal, then restart pi --slice.`, "info");
            return;
          }
          const text = await ctx.ui.editor("Slice configuration — added tools and MCP servers have their own permissions", JSON.stringify(current, null, 2));
          if (text === undefined) return;
          saveProfile(found.root, getAgentDir(), parseProfile(JSON.parse(text)));
          ctx.ui.notify("Slice configuration saved. Restart pi --slice to apply it.", "info");
          return;
        }
        if (command === "services" || (command === "stop" && values.length)) {
          const saved = await savedServices(piHost());
          if (command === "services") {
            ctx.ui.notify("Services\n" + (saved.map(s => `${s.label}\n${s.root || "Workspace unavailable"}\n${serviceText(s)}`).join("\n\n") || "None saved."), "info");
          } else {
            const service = saved.find(s => s.label === values[0]);
            if (!service) throw Error("Unknown service ID. Use /slice services.");
            if (!service.root) throw Error(service.error);
            ctx.ui.notify(serviceText(await serviceAction(service.root, piHost(), {action: "stop"}, ctx.signal)), "info");
          }
          return;
        }
        if (command === "logs" || command === "stop") {
          const result = await serviceAction(root || realpathSync(ctx.cwd), piHost(), {action: command}, ctx.signal);
          ctx.ui.notify(serviceText(result), "info");
          return;
        }
        if (command === "" || command === "doctor") {
          const isMarked = marked(ctx.cwd);
          let identity = isMarked ? "invalid marker" : "unmarked";
          // A broken marker must not hide a still-running service.
          if (isMarked) { try { identity = readWorkspace(ctx.cwd).id; } catch {} }
          const status = ready ? "healthy" : protectedContext(ctx) ? failure : "off; run /slice init";
          const available = (name: string) => {
            try { executable(name, ctx.cwd); return "available"; } catch { return "missing"; }
          };
          let text = `pi-slice\nsandbox    ${status}\nconfig     ${configuration}\nworkspace  ${identity}\nruntime    ${runtime}\nexport     age ${available("age")}; tar ${available("tar")}`;
          if (ready || isMarked) {
            const service = await serviceStatus(realpathSync(ctx.cwd), piHost());
            text += `\nservice    ${service.state}${service.url ? " · " + service.url : ""}${service.error ? " · " + service.error : ""}`;
          }
          if (command === "doctor") {
            const found = requirements(ctx.cwd);
            text += `\nPi ${VERSION}; Node ${found.nodeVersion}; Bun ${found.bunVersion}: OK.\n` +
              "Git: use git add <paths>; runtime placeholders can prevent git add -A. Configure name/email on the host.\n" +
              "Files are private (0600/0700). Linux background processes end with each command; macOS restricts local binding." +
              (process.platform === "darwin" ? "\nNew Git repositories: run git init in the host terminal; protected hooks/config prevent sandboxed initialization." : "");
            try { const backend = servicePlatform(found.root); await backend.check(); text += `\nBackground service: ${backend.name} available. Project read-only; private runtime writable. Survives Pi/terminal exit; logout behavior follows the user service manager. Not started automatically after reboot.`; }
            catch (error) { text += "\n" + String(error); }
            try { socketPrefix(getAgentDir()); }
            catch (error) { text += "\n" + (error instanceof Error ? error.message : String(error)); }
          }
          ctx.ui.notify(text, "info");
          return;
        }
        if (command === "import") {
          if (values.length !== 2) throw Error("Use /slice import <file.slice> <new-directory>.");
          const cwd = realpathSync(ctx.cwd), path = resolvePath(cwd, values[1]);
          const destination = join(realpathSync(dirname(path)), basename(path));
          for (const trusted of [getAgentDir(), getPackageDir(), packageRoot, ...(marked(cwd) ? [cwd] : [])]) {
            if (inside(destination, realpathSync(trusted)) || inside(realpathSync(trusted), destination))
              throw Error("Import outside this workspace and trusted Pi state/code.");
          }
          await (await import("./features/snapshot.ts")).restore(ctx, getAgentDir(), values[0], destination);
          ctx.ui.notify(`Restored ${destination}.\ncd ${quote(destination)} && pi --slice`, "info");
          return;
        }
        const found = requirements(ctx.cwd);
        if (command === "init") {
          if (values[0] && values[0] !== "new") throw Error("Use /slice init [new].");
          const existing = marked(found.root);
          if (existing) readWorkspace(found.root);
          await (lock || commandLock(getAgentDir(), found.root, found.tools.flock,
            process.platform === "darwin" ? found.tools.bun : undefined))(async () => {
            if (!existing || values[0]) writeWorkspace(found.root, { version: 1, id: randomUUID() });
            if (!existing) {
              prepareRuntime(join(found.root, ".pi-runtime"), found.tools);
              ignoreRuntime(found.root);
            }
            saveProfile(found.root, getAgentDir(), parseProfile({}), true);
          });
          if (ready) { ctx.ui.notify("This workspace is already isolated.", "info"); return; }
          if (!existing) {
            root = found.root;
            failure = "Workspace initialized. Pi is closing. Run pi again with --slice for sandboxed tools and a minimal configuration.";
            ctx.ui.notify(failure, "info");
            ctx.shutdown();
            return;
          }
          ctx.ui.notify(failure, "warning");
          return;
        }
        check(ctx);
        executable("tar", root);
        const file = await (await import("./features/snapshot.ts")).snapshot(
          ctx, getAgentDir(), found.tools.bun, capture!, values[0],
        );
        ctx.ui.notify("Saved " + file, "info");
      } catch (error) {
        ctx.ui.notify(`pi-slice: ${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });
  if (mcpEnabled) {
    for (const [name, config] of Object.entries(profile!.mcpServers))
      pi.registerMcpServer(name, {exposure: "direct", ...config});
    createMcpExtension({loadConfig: () => ({servers: [], errors: [], autoEnableCodemode: false})})(pi);
  }
}
