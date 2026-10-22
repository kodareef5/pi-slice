import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { SandboxManager as manager } from "@anthropic-ai/sandbox-runtime";
import { requirements, prepareRuntime, policy, probeCode } from "../sandbox.ts";
import { privateDir, quote, readWorkspace } from "../workspace.ts";
import { exited, terminate } from "../process.ts";
import { record, servicePaths, socketPrefix, type ServiceConfig } from "./service.ts";

const config: ServiceConfig = JSON.parse(readFileSync(process.argv[2], "utf8"));
const paths = servicePaths(config.root, config.pi.agentDir);
const runtime = join(paths.dir, "runtime");
let child: ChildProcess | undefined, bridge = "", logSize = 0, initialized = false;
let ending: Promise<void> | undefined;
const sockets = new Set<Socket>();
const server = createServer();
const logTail = () => readFileSync(paths.log, "utf8").slice(-1500);
const note = (text: string | Buffer) => {
  appendFileSync(paths.log, text, {mode: 0o600});
  logSize += Buffer.byteLength(text);
  if (logSize > 128000) {
    const bytes = readFileSync(paths.log);
    let start = bytes.length - 64000;
    while ((bytes[start] & 0xc0) === 0x80) start++; // Skip UTF-8 continuation bytes.
    const tail = bytes.subarray(start);
    writeFileSync(paths.log, tail);
    logSize = tail.length;
  }
};
const stopChild = async () => {
  if (process.platform === "linux") return terminate(child);
  if (!child) return;
  // Close inherited pipes so descendants cannot stall launchd's group cleanup.
  try {
    if (child.pid && child.exitCode === null && !child.signalCode) {
      const done = exited(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
      try { await done; } finally { clearTimeout(timer); }
    }
  } finally {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
};
function finish(error?: string) {
  return ending ??= (async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await stopChild();
    if (initialized) await manager.reset();
    if (bridge) rmSync(bridge, {recursive: true, force: true});
    record(paths.state, {state: error ? "failed" : "stopped", command: config.command, ...(error ? {error} : {})});
  })();
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => { void finish().finally(() => process.exit(0)); });

async function launch(command: string, env: Record<string, string>) {
  const wrapped = await manager.wrapWithSandbox(
    `umask 077; export HOME=${quote(env.HOME)} TMPDIR=${quote(env.TMPDIR)}; ${command}`, "/bin/bash",
  );
  if (ending) throw Error("Service stopped during startup.");
  child = spawn("/bin/bash", ["-c", wrapped], {
    cwd: config.root, env, detached: process.platform === "linux", stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", note);
  child.stderr!.on("data", note);
  // Keep completion inside an object so awaiting launch only waits for spawning.
  return {done: exited(child, process.platform === "darwin" ? "exit" : "close")
    .finally(() => manager.cleanupAfterCommand())};
}

function forward(socketPath: string) {
  const allowed = (req: IncomingMessage) => {
    const port = (server.address() as {port: number}).port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const navigation = req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    return hosts.includes(req.headers.host || "") && (req.headers["sec-fetch-site"] !== "cross-site" || navigation) &&
      (!req.headers.origin || hosts.some(host => req.headers.origin === "http://" + host));
  };
  server.maxConnections = 64;
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("request", (req, res) => {
    if (!allowed(req)) { res.writeHead(403).end("Local preview only."); return; }
    const upstream = httpRequest({socketPath, method: req.method, path: req.url, headers: req.headers}, response => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Service unavailable."); });
    upstream.setTimeout(30000, () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    if (!allowed(req)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const upstream = httpRequest({socketPath, method: req.method, path: req.url, headers: req.headers});
    upstream.on("upgrade", (response, peer, pending) => {
      peer.setTimeout(0);
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
        response.rawHeaders.reduce((text, value, i, list) => i % 2 ? text : text + value + ": " + list[i + 1] + "\r\n", "") + "\r\n");
      if (head.length) peer.write(head);
      if (pending.length) socket.write(pending);
      peer.pipe(socket); socket.pipe(peer);
      socket.on("close", () => peer.destroy()); peer.on("close", () => socket.destroy());
      peer.on("error", () => socket.destroy());
    });
    upstream.on("response", () => { upstream.destroy(); socket.destroy(); });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.end();
  });
}

try {
  process.umask(0o077);
  const version = JSON.parse(readFileSync(join(config.pi.packageDir, "package.json"), "utf8")).version;
  const found = requirements(config.root, {...config.pi, version});
  if (found.root !== config.root) throw Error("Workspace path changed; start the service again.");
  readWorkspace(found.root);
  const env = prepareRuntime(runtime, found.tools);
  const settings = policy(found.root, found.tools, config.pi.agentDir);
  settings.filesystem.allowRead.push(runtime);
  settings.filesystem.allowWrite = [runtime];
  let appSocket = "", backend = "";
  if (config.preview) {
    const prefix = socketPrefix(config.pi.agentDir);
    privateDir(config.pi.agentDir, "sockets");
    bridge = mkdtempSync(prefix);
    const inbox = join(bridge, "in");
    appSocket = join(inbox, "app"); backend = join(bridge, "app");
    mkdirSync(inbox, {mode: 0o700});
    settings.filesystem.allowRead.push(inbox);
    settings.filesystem.allowWrite.push(inbox);
    settings.network.allowUnixSockets = [inbox];
    env.PI_SLICE_SOCKET = appSocket;
  }
  // Keep service deny placeholders separate from Pi's command cleanup.
  process.chdir(runtime);
  await manager.initialize(settings);
  initialized = true;
  const readonlyProbe = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(found.root, ".pi-slice-service-probe"))},'bad'),e=>['EPERM','EACCES','EROFS'].includes(e.code));`;
  const probe = probeCode(env, found.nodeVersion, config.pi.agentDir);
  if (await (await launch(`${quote(found.tools.bun)} --no-env-file --config=/dev/null -e ${quote(probe)} && ${quote(found.tools.bun)} --no-env-file --config=/dev/null -e ${quote(readonlyProbe)}`, env)).done !== 0)
    throw Error("Background sandbox startup probe failed. " + logTail());
  logSize = 0;
  writeFileSync(paths.log, "", {mode: 0o600});
  let ended = false;
  const launched = await launch(config.command, env);
  const done = launched.done.then(code => { ended = true; return code; });
  void done.catch(() => { ended = true; });
  const deadline = Date.now() + 15000;
  while (!ended && !ending) {
    if (!config.preview || lstatSync(appSocket, {throwIfNoEntry: false})) break;
    if (Date.now() >= deadline) throw Error("Preview must listen on PI_SLICE_SOCKET (Bun.serve({ unix: process.env.PI_SLICE_SOCKET, fetch })). Use preview:false for a worker.");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (ended || ending) throw Error("Service exited before startup completed. " + logTail());
  let url: string | undefined;
  if (config.preview) {
    // Take the socket out of the app's control before validating and connecting.
    renameSync(appSocket, backend);
    if (!lstatSync(backend).isSocket()) throw Error("PI_SLICE_SOCKET must be a Unix socket, not a file or link.");
    forward(backend);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({socketPath: backend, path: "/", headers: {host: new URL(url!).host}}, res => { res.resume(); resolve(); });
      req.setTimeout(3000, () => req.destroy(Error("Preview did not answer HTTP.")));
      req.on("error", reject); req.end();
    });
  } else await new Promise(resolve => setTimeout(resolve, 250));
  if (ended || ending) throw Error("The foreground service command stopped during startup.");
  record(paths.state, {state: "running", command: config.command, ...(url ? {url} : {})});
  const code = await done;
  await finish(code ? "Service exited with code " + code + ". Check /slice logs." : undefined);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  note(message + "\n");
  await finish(message);
  process.exitCode = 1;
}
