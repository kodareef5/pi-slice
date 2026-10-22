import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, get } from "node:http";
import { createServer as socketServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  copyFileSync,
  linkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { EventEmitter, on } from "node:events";
import { randomUUID } from "node:crypto";
import { Header } from "tar";
import { serviceAction, servicePaths } from "../features/service.ts";
import { servicePlatform } from "../features/service-platform.ts";
import { requirements } from "../sandbox.ts";
import { parseProfile, profilePath, readProfile, saveProfile } from "../features/profile.ts";
import { normalizeSliceFlag } from "../features/launch.ts";

const packageRoot = dirname(import.meta.dirname);
const pi = realpathSync(
  process.env.PATH.split(":")
    .map((dir) => join(dir, "pi"))
    .find(existsSync),
);
const base = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-slice-")));
let root, home, agent, project, plain, outside, visible, env;
const mark = (path) => writeFileSync(join(path, ".pi-slice"), JSON.stringify({ version: 1, id: randomUUID() }));
const settings = {
  extensions: [join(packageRoot, "test/driver.ts")],
  quietStartup: true,
  defaultProvider: "openai",
  defaultModel: "gpt-6-astra",
};
beforeEach(() => {
  root = mkdtempSync(join(base, "case-"));
  home = join(root, "h");
  agent = join(root, "agent");
  project = join(home, "p");
  plain = join(home, "plain");
  outside = join(home, "private.txt");
  visible = join(root, "public.txt");
  for (const path of [
    agent,
    project,
    plain,
    join(project, ".pi"),
    join(project, ".git/hooks"),
    join(project, ".pi-runtime"),
  ])
    mkdirSync(path, { recursive: true });
  writeFileSync(outside, "host secret");
  writeFileSync(visible, "read only");
  mark(project);
  writeFileSync(join(home, ".gitconfig"), "[user]\nname = Test Author\nemail = author@example.com\n");
  for (const path of [".pi/sentinel", ".git/hooks/sentinel"]) writeFileSync(join(project, path), "protected");
  writeFileSync(join(project, ".git/config"), "[core]\n");
  writeFileSync(join(project, ".gitignore"), ".pi-runtime/\n");
  writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }), {
    mode: 0o600,
  });
  env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agent,
    PI_SLICE_TEST_SECRET: "fixture",
    GH_TOKEN: "fixture-github",
    AWS_SECRET_ACCESS_KEY: "fixture-aws",
    OPENAI_API_KEY: "fixture-provider",
    JAVA_TOOL_OPTIONS: "-Dpi.slice.host=secret",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "HOST_INJECTION",
  };
  delete env.PI_CODING_AGENT_SESSION_DIR;
});
after(() => rmSync(base, { recursive: true, force: true }));

test("Pi qualification accepts stable upgrades without an exact version pin", () => {
  const host = { agentDir: agent, packageDir: packageRoot };
  for (const version of ["1.4.0", "1.4.1", "1.5.0"])
    assert.doesNotThrow(() => requirements(project, { ...host, version }));
  for (const version of ["1.0.4", "1.3.0", "1.4.0-beta", "unknown"])
    assert.throws(() => requirements(project, { ...host, version }), /Pi 1\.4\.0 or newer required/);
});

test("Slice flags preserve prompts, option values and literal arguments", () => {
  assert.deepEqual(normalizeSliceFlag(["--slice", "hello"]), ["--slice=true", "hello"]);
  assert.deepEqual(normalizeSliceFlag(["--system-prompt", "--slice", "--slice", "hello"]), ["--system-prompt", "--slice", "--slice=true", "hello"]);
  assert.deepEqual(normalizeSliceFlag(["--", "--slice"]), ["--", "--slice"]);
});

async function start(t, cwd = project, { args = [], environment = env } = {}) {
  const child = spawn(process.execPath, [pi, "--mode", "rpc", "--offline", ...args], { cwd, env: environment });
  const events = new EventEmitter(),
    notices = [];
  let stderr = "",
    nextId = 0;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "extension_ui_request" && event.method === "notify") notices.push(event.message);
    events.emit(event.type, event);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const receive = async (type, match) => {
    try {
      for await (const [event] of on(events, type, { signal: AbortSignal.timeout(60000) }))
        if (match(event)) return event;
    } catch (error) {
      throw Error(stderr + notices.join("\n"), { cause: error });
    }
  };
  const client = {
    notices,
    child,
    exited,
    receive,
    async request(command) {
      const id = String(++nextId),
        reply = receive("response", (event) => event.id === id);
      child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
      const response = await reply;
      assert.equal(response.success, true, JSON.stringify(response));
      return response.data;
    },
    async command(message, prefix = "FIXTURE:") {
      const reply = receive(
        "extension_ui_request",
        (event) => event.method === "notify" && event.message.startsWith(prefix),
      );
      await this.request({ type: "prompt", message });
      return (await reply).message;
    },
    async fixture(request) {
      const { result, error } = JSON.parse((await this.command("/fixture " + JSON.stringify(request))).slice(8));
      if (error) throw Error(error);
      return result;
    },
    tool(tool, params) {
      return this.fixture({ op: "tool", tool, params });
    },
    bash(command) {
      return this.request({ type: "bash", command });
    },
    async close() {
      child.kill();
      await exited;
    },
  };
  t.after(() => client.close());
  client.state = await client.request({ type: "get_state" });
  return client;
}

async function blocked(client, reason) {
  const shell = await client.bash("echo MUST_NOT_RUN");
  assert.equal(shell.exitCode, 1);
  assert.match(shell.output, reason);
  for (const tool of ["read", "write", "edit", "bash", "slice_service", "fixture-host"])
    await assert.rejects(client.tool(tool, {}), reason);
}

test("unmarked directories keep ordinary Pi, auth, environment and tools", async (t) => {
  const original = readFileSync(join(agent, "auth.json"), "utf8"),
    client = await start(t, plain);
  const info = await client.fixture({ op: "info" });
  assert.equal(info.home, home);
  assert.equal(info.agent, agent);
  assert.equal(info.secret, true);
  assert.equal(info.umask, process.umask());
  assert.deepEqual(info.overridden, []);
  assert.ok(info.tools.includes("bash"));
  assert.match((await client.bash(`cat '${outside}'`)).output, /host secret/);
  assert.equal(existsSync(join(plain, ".pi-runtime")), false);
  assert.equal(client.state.model.provider, "openai");
  assert.equal(readFileSync(join(agent, "auth.json"), "utf8"), original);
});

test("--slice restarts into a minimal session without changing accounts or settings", {timeout: 15000}, async t => {
  mkdirSync(join(agent, "extensions"));
  const factory = join(root, "factory-ran"), started = join(root, "hook-ran");
  writeFileSync(join(agent, "extensions/noisy.ts"), `import {writeFileSync} from 'node:fs'; export default pi => {
    writeFileSync(${JSON.stringify(factory)}, 'yes');
    pi.on('session_start', () => writeFileSync(${JSON.stringify(started)}, 'yes'));
    pi.registerCommand('noise', {handler(){}});
  };`);
  mkdirSync(join(agent, "prompts"));
  writeFileSync(join(agent, "prompts/noisy.md"), "Global prompt");
  mkdirSync(join(agent, "skills/noisy"), {recursive: true});
  writeFileSync(join(agent, "skills/noisy/SKILL.md"), "---\nname: noisy\ndescription: Fixture\n---\nGlobal skill");
  const mcpStarted = join(root, "global-mcp-ran");
  writeFileSync(join(agent, "mcp.json"), JSON.stringify({mcpServers: {global: {
    command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(mcpStarted)},'yes')`],
  }}}));
  const savedSettings = readFileSync(join(agent, "settings.json"), "utf8");
  const savedAuth = readFileSync(join(agent, "auth.json"), "utf8");
  const client = await start(t, project, {args: ["--slice"]});
  assert.deepEqual((await client.request({type: "get_commands"})).commands.map(c => c.name), ["slice"]);
  assert.equal(existsSync(started), false);
  assert.equal(existsSync(mcpStarted), false);
  assert.match(await client.command("/slice doctor", "pi-slice\n"), /sandbox    healthy\nconfig     Slice/);
  assert.ok(!client.notices.some(text => text.includes("using your normal Pi configuration")));
  assert.equal(client.state.model.provider, "openai");
  assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), savedSettings);
  assert.equal(readFileSync(join(agent, "auth.json"), "utf8"), savedAuth);
  const path = profilePath(project, agent);
  assert.ok(existsSync(path));
  assert.equal((await client.bash(`cat '${path}'`)).exitCode, 1);
  assert.equal((await client.bash("printf slice-ok > slice.txt")).exitCode, 0);
  assert.equal(readFileSync(join(project, "slice.txt"), "utf8"), "slice-ok");
});

test("normal Pi keeps the sandbox and explains which configuration is loaded", async t => {
  const client = await start(t);
  assert.ok(client.notices.some(text => text.includes("Slice sandbox active; using your normal Pi configuration")));
  assert.match(await client.command("/slice", "pi-slice\n"), /sandbox    healthy\nconfig     normal Pi/);
  assert.notEqual((await client.bash(`cat '${outside}'`)).exitCode, 0);
});

test("Slice configuration is private, per directory and opt-in", async t => {
  saveProfile(project, agent, parseProfile({tools: ["fixture_extra"], contextFiles: false}));
  copyFileSync(join(project, ".pi-slice"), join(plain, ".pi-slice"));
  assert.deepEqual(readProfile(plain, agent), parseProfile({}));
  const path = profilePath(project, agent);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const client = await start(t);
  assert.match(await client.command("/slice config", "Slice configuration:"), /restart pi --slice/);
  assert.throws(() => parseProfile({extensions: "bad"}), /array/);
  assert.throws(() => parseProfile({mcpServers: {"bad name": {url: "https://example.com"}}}), /server name/);
});

test("Slice loads selected resources and executes opted-in tools and MCP", {timeout: 20000}, async t => {
  const requests = [], calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    requests.push(data);
    const call = data.messages.at(-1).role === "tool" ? undefined : calls.shift();
    const delta = call ? {role: "assistant", tool_calls: [{index: 0, id: "call-" + requests.length,
      type: "function", function: {name: call.name, arguments: JSON.stringify(call.args)}}]} : {content: "Done."};
    response.writeHead(200, {"content-type": "text/event-stream"});
    response.end(`data: ${JSON.stringify({id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{index: 0, delta, finish_reason: call ? "tool_calls" : "stop"}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const addon = join(home, "chosen.ts"), skill = join(home, "chosen-skill"), prompt = join(home, "chosen-prompt.md");
  mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), "---\nname: chosen-skill\ndescription: Selected skill\n---\nSELECTED_SKILL_CONTENT");
  writeFileSync(join(skill, "asset.txt"), "SELECTED_SKILL_ASSET");
  writeFileSync(prompt, "Selected prompt");
  writeFileSync(join(agent, "AGENTS.md"), "GLOBAL_CONTEXT_SENTINEL");
  writeFileSync(join(agent, "SYSTEM.md"), "GLOBAL_SYSTEM_SENTINEL");
  writeFileSync(join(agent, "APPEND_SYSTEM.md"), "GLOBAL_APPEND_SENTINEL");
  writeFileSync(addon, `import {Type} from '@earendil-works/pi-ai'; export default pi => {
    pi.registerProvider('slice-fixture', {baseUrl: 'http://127.0.0.1:${server.address().port}/v1',
      apiKey: 'fixture-only', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture',
      contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]});
    for (const name of ['fixture_extra', 'fixture_blocked']) pi.registerTool({name, label: name, description: name,
      parameters: Type.Object({}), async execute(){return {content:[{type:'text',text:'OPTED_IN_TOOL_OK'}],details:{}}}});
    pi.registerCommand('chosen', {handler(args, ctx){ctx.ui.notify('CHOSEN:' + JSON.stringify({
      tools: pi.getActiveTools(), prompt: ctx.getSystemPromptOptions()}), 'info')}});
  };`);
  const mcp = join(home, "mcp.mjs"), mcpCalls = join(home, "mcp-calls");
  writeFileSync(mcp, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
    createInterface({input: process.stdin}).on('line', line => {
      const r = JSON.parse(line); if (r.id === undefined) return;
      let result;
      if (r.method === 'initialize') result = {protocolVersion: r.params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name:'fixture', version:'1'}};
      else if (r.method === 'tools/list') result = {tools: [{name:'ping', description:'Fixture ping', inputSchema:{type:'object',properties:{}}}]};
      else if (r.method === 'tools/call') {appendFileSync(${JSON.stringify(mcpCalls)}, r.params.name + '\\n'); result = {content:[{type:'text',text:'MCP_PONG'}]};}
      else result = {};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result}) + '\\n');
    });`);
  saveProfile(project, agent, parseProfile({extensions: [addon], skills: [skill], prompts: [prompt],
    tools: ["fixture_extra"], mcpServers: {chosen: {command: process.execPath, args: [mcp]}}}));
  const client = await start(t, project, {args: ["--slice", "--model", "slice-fixture/fixture"]});
  const commands = (await client.request({type: "get_commands"})).commands.map(c => c.name);
  for (const name of ["slice", "chosen", "chosen-prompt", "skill:chosen-skill", "mcp"]) assert.ok(commands.includes(name), commands.join(", "));
  const info = JSON.parse((await client.command("/chosen", "CHOSEN:")).slice(7));
  assert.ok(info.tools.includes("fixture_extra"));
  assert.ok(!info.tools.includes("fixture_blocked"), JSON.stringify({info, notices: client.notices}));
  assert.doesNotMatch(JSON.stringify(info.prompt), /GLOBAL_(CONTEXT|SYSTEM|APPEND)_SENTINEL/);
  assert.deepEqual(info.prompt.skills.map(s => s.name), ["chosen-skill"]);
  const turn = async (name, args = {}) => {
    calls.push({name, args});
    const done = client.receive("agent_end", () => true);
    await client.request({type: "prompt", message: "Run the fixture tool."});
    await done;
    assert.equal(calls.length, 0);
    return requests.at(-1).messages.at(-1).content;
  };
  assert.match(await turn("fixture_extra"), /OPTED_IN_TOOL_OK/);
  assert.match(await turn("mcp__chosen__ping"), /MCP_PONG/);
  assert.equal(readFileSync(mcpCalls, "utf8"), "ping\n");
  assert.match(await turn("read", {path: join(skill, "SKILL.md")}), /SELECTED_SKILL_CONTENT/);
  assert.equal((await client.bash(`cat '${join(skill, "asset.txt")}'`)).output.trim(), "SELECTED_SKILL_ASSET");
  assert.notEqual((await client.bash(`echo overwrite > '${join(skill, "SKILL.md")}'`)).exitCode, 0);
  assert.notEqual((await client.bash(`cat '${outside}'`)).exitCode, 0);
  await client.close();
});

test("--slice rejects missing or invalid setup instead of starting a normal session", () => {
  const run = (cwd, args) => spawnSync(process.execPath, [pi, "--offline", "--mode", "rpc", ...args], {
    cwd, env, input: "", encoding: "utf8", timeout: 10000,
  });
  const missing = run(plain, ["--slice"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /initialized workspace/);
  const approved = run(project, ["--slice", "--approve"]);
  assert.notEqual(approved.status, 0);
  assert.match(approved.stdout + approved.stderr, /cannot be combined/);
  const path = saveProfile(project, agent, parseProfile({}));
  writeFileSync(path, '{"extensions":"bad"}');
  const invalid = run(project, ["--slice"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout + invalid.stderr, /array of nonempty strings/);
  assert.equal(run(plain, ["--slice", "--help"]).status, 0);
});

test("a Slice session cannot switch to a different workspace's profile", async t => {
  const other = await start(t, plain);
  await other.fixture({op: "persist"});
  const target = other.state.sessionFile;
  await other.close();
  const client = await start(t, project, {args: ["--slice"]});
  const state = client.state;
  const switched = await client.request({type: "switch_session", sessionPath: target});
  assert.equal(switched.cancelled, true);
  assert.equal((await client.request({type: "get_state"})).sessionId, state.sessionId);
  assert.ok(client.notices.some(n => n.includes("belongs to another workspace")));
  assert.notEqual((await client.bash(`cat '${outside}'`)).exitCode, 0);
});

test("pi install discovers /slice without a /work alias and isolates after restart", { timeout: 20000 }, async (t) => {
  const packageAgent = join(root, "package-agent");
  mkdirSync(packageAgent);
  writeFileSync(join(packageAgent, "settings.json"), JSON.stringify({ ...settings, extensions: [] }));
  copyFileSync(join(agent, "auth.json"), join(packageAgent, "auth.json"));
  const environment = { ...env, PI_CODING_AGENT_DIR: packageAgent };
  const installed = spawnSync(process.execPath, [pi, "install", packageRoot], {
    cwd: plain, env: environment, encoding: "utf8", timeout: 10000,
  });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const client = await start(t, plain, { environment });
  const { commands } = await client.request({ type: "get_commands" });
  assert.ok(commands.some(command => command.name === "slice" && command.sourceInfo.origin === "package"));
  assert.ok(!commands.some(command => command.name === "work"));
  await client.command("/slice init", "Workspace initialized.");
  await client.request({ type: "get_state" });
  assert.equal(await client.exited, 0);
  assert.ok(existsSync(join(plain, ".pi-slice")));
  const restarted = await start(t, plain, { environment });
  assert.match(await restarted.command("/slice doctor", "pi-slice\n"), /sandbox    healthy/);
  const denied = await restarted.bash(`cat '${outside}'`);
  assert.notEqual(denied.exitCode, 0);
  assert.doesNotMatch(denied.output, /host secret/);
});

test("init creates scratch and exits cleanly; restarting activates isolation", { timeout: 10000 }, async (t) => {
  for (const path of [".pi-slice", ".git", ".pi", ".pi-runtime", ".gitignore"])
    rmSync(join(project, path), { recursive: true, force: true });
  const client = await start(t);
  const auth = readFileSync(join(agent, "auth.json"), "utf8");
  assert.match(await client.command("/slice init", "Workspace initialized."), /pi --slice/);
  // RPC checks deferred shutdown on its next input after async commands.
  await client.request({ type: "get_state" });
  assert.equal(await client.exited, 0);
  const config = JSON.parse(readFileSync(join(project, ".pi-slice"), "utf8"));
  assert.equal(config.version, 1);
  assert.match(config.id, /^[0-9a-f-]{36}$/);
  assert.equal(readFileSync(join(project, ".gitignore"), "utf8"), ".pi-runtime/\n");
  assert.equal(existsSync(join(project, ".git")), false);
  assert.equal(readFileSync(join(agent, "auth.json"), "utf8"), auth);
  const restarted = await start(t);
  assert.match(await restarted.command("/slice", "pi-slice\n"), /sandbox    healthy/);
  await assert.rejects(restarted.tool("read", { path: outside }));
  assert.equal(existsSync(join(home, ".pi/slice")), false);
});

async function probe({ outside, visible, agent, port, nodeVersion, npmVersion }) {
  const fs = require("node:fs"),
    assert = require("node:assert/strict");
  const denied = (fn) => assert.throws(fn, (error) => ["EPERM", "EACCES", "ENOENT", "EROFS"].includes(error.code));
  assert.equal(process.env.HOME, process.cwd() + "/.pi-runtime/home");
  assert.equal(process.env.TMPDIR, process.cwd() + "/.pi-runtime/tmp");
  for (const name of [
    "PI_SLICE_TEST_SECRET",
    "GH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "OPENAI_API_KEY",
    "PI_CODING_AGENT_DIR",
    "PI_SESSION_FILE",
  ])
    assert.equal(process.env[name], undefined, name);
  assert.doesNotMatch(process.env.JAVA_TOOL_OPTIONS || "", /pi.slice.host|secret/);
  assert.doesNotMatch(
    JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_CONFIG_")))),
    /HOST_INJECTION/,
  );
  const scratch = process.env.TMPDIR + "/probe.txt";
  fs.writeFileSync(scratch, "ok");
  assert.equal(fs.statSync(scratch).mode & 0o777, 0o600);
  const { Database } = require("bun:sqlite"),
    db = new Database(":memory:");
  assert.equal(db.query("select 1 as v").get().v, 1);
  db.close();
  assert.equal(fs.readFileSync(visible, "utf8"), "read only");
  denied(() => fs.writeFileSync(visible, "escape"));
  for (const path of [outside, agent + "/auth.json", agent + "/settings.json"]) {
    denied(() => fs.readFileSync(path));
    if (process.platform === "linux") {
      try {
        fs.writeFileSync(path, "disposable");
        fs.unlinkSync(path);
      } catch (e) {
        assert.ok(["EPERM", "EACCES", "ENOENT", "EROFS"].includes(e.code));
      }
    } else denied(() => fs.writeFileSync(path, "escape"));
  }
  fs.writeFileSync(".git/config", "[core]\n");
  for (const path of [".pi-slice", ".pi/sentinel", ".git/hooks/sentinel", "/tmp/claude/pi-slice-test"])
    denied(() => fs.writeFileSync(path, "escape"));
  const link = ".pi-runtime/link-" + process.pid;
  fs.symlinkSync(outside, link);
  denied(() => fs.readFileSync(link));
  fs.unlinkSync(link);
  for (const tool of ["node", "npm", "git", "rg"]) assert.equal(Bun.spawnSync([tool, "--version"]).exitCode, 0, tool);
  assert.equal(Bun.spawnSync(["node", "--version"]).stdout.toString().trim(), nodeVersion);
  assert.equal(Bun.spawnSync(["npm", "--version"]).stdout.toString().trim(), npmVersion);
  const sqlite = Bun.spawnSync([
    "node",
    "--no-warnings",
    "-e",
    "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');if(d.prepare('select 1 as v').get().v!==1)throw Error('SQLite');d.close();console.log('OK')",
  ]);
  assert.equal(sqlite.exitCode, 0, sqlite.stderr.toString());
  assert.equal(sqlite.stdout.toString().trim(), "OK");
  assert.notEqual(Bun.spawnSync(["node", "-e", `require('fs').readFileSync(${JSON.stringify(outside)})`]).exitCode, 0);
  const net = require("node:net");
  process.env.NO_PROXY = process.env.no_proxy = "";
  assert.equal(
    await (await fetch(`http://127.0.0.1:${port}/`, { proxy: process.env.HTTP_PROXY })).text(),
    "proxy works",
  );
  const nodeFetch = Bun.spawnSync(
    ["node", "--no-warnings", "-e", `fetch('http://127.0.0.1:${port}/').then(r=>r.text()).then(console.log)`],
    { env: { ...process.env, NO_PROXY: "", no_proxy: "" } },
  );
  assert.equal(nodeFetch.exitCode, 0, nodeFetch.stderr.toString());
  assert.equal(nodeFetch.stdout.toString().trim(), "proxy works");
  const direct = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
  assert.equal(direct, false);
  console.log("PASS");
}

test("model and user shells confine files, subprocesses, credentials and network", async (t) => {
  for (const dir of [".pi", ".git/hooks"]) mkdirSync(join(project, dir), { recursive: true });
  for (const path of [".pi/sentinel", ".git/config", ".git/hooks/sentinel"])
    writeFileSync(join(project, path), "protected");
  const originals = [outside, join(agent, "auth.json"), join(agent, "settings.json")].map((path) => [
    path,
    readFileSync(path, "utf8"),
  ]);
  const server = createServer((_req, res) => res.end("proxy works"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = await start(t);
  const config = {
    outside,
    visible,
    agent,
    port: server.address().port,
    nodeVersion: spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim(),
    npmVersion: spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim(),
  };
  writeFileSync(join(project, ".pi-runtime/probe.mjs"), `await (${probe.toString()})(${JSON.stringify(config)});`);
  const command = "bun --no-env-file .pi-runtime/probe.mjs";
  const user = await client.bash(command),
    model = (await client.tool("bash", { command })).structuredContent;
  for (const result of [{ exitCode: model.exit_code, output: model.output }, user]) {
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.output.trim(), "PASS");
  }
  const info = await client.fixture({ op: "info" });
  assert.equal(info.home, home);
  assert.equal(info.secret, true);
  assert.deepEqual(info.tools.sort(), ["bash", "edit", "read", "slice_service", "write"]);
  assert.ok(client.state.sessionFile.startsWith(join(agent, "sessions") + "/"));
  for (const [path, original] of originals) assert.equal(readFileSync(path, "utf8"), original);
});

test("file tools preserve text, edits and images without exposing host files", async (t) => {
  const client = await start(t),
    content = "literal $(touch /tmp/pi-slice-must-not-run) ' quotes\n" + "x".repeat(150000);
  await client.tool("write", { path: "large.txt", content });
  assert.equal(readFileSync(join(project, "large.txt"), "utf8"), content);
  await client.tool("edit", { path: "large.txt", edits: [{ oldText: "literal", newText: "edited" }] });
  assert.match((await client.tool("read", { path: "large.txt", limit: 1 })).content[0].text, /^edited/);
  symlinkSync(outside, join(project, "host-link"));
  symlinkSync(visible, join(project, "visible-link"));
  for (const path of [outside, join(agent, "auth.json"), "host-link"])
    await assert.rejects(client.tool("read", { path }));
  assert.match((await client.tool("read", { path: "visible-link" })).content[0].text, /read only/);
  await client.tool("write", { path: ".git/config", content: "[core]\n\tbare = false\n" });
  await client.tool("edit", { path: ".git/config", edits: [{ oldText: "false", newText: "true" }] });
  assert.match(readFileSync(join(project, ".git/config"), "utf8"), /bare = true/);
  for (const path of [".pi-slice", ".pi/sentinel", ".git/hooks/sentinel", visible, "visible-link"]) {
    await assert.rejects(client.tool("write", { path, content: "escape" }), /EPERM|EACCES|EROFS|ENOENT/);
    await assert.rejects(client.tool("edit", { path, edits: [{ oldText: "protected", newText: "escape" }] }));
  }
  // Linux masks hidden paths with disposable copies.
  try {
    await client.tool("write", { path: "host-link", content: "escape" });
  } catch (error) {
    assert.match(String(error), /EPERM|EACCES|EROFS|ENOENT/);
  }
  await assert.rejects(client.tool("read", { path: "host-link" }));
  assert.equal(readFileSync(outside, "utf8"), "host secret");
  assert.equal(readFileSync(visible, "utf8"), "read only");
  await assert.rejects(client.tool("fixture-host", {}), /Only read, bash, edit, write/);
  writeFileSync(
    join(project, "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  assert.ok((await client.tool("read", { path: "pixel.png" })).content.some((block) => block.type === "image"));
});

test("project extensions cannot run even with saved trust", async (t) => {
  const sentinel = join(root, "project-extension-ran");
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ extensions: ["bad.ts"] }));
  writeFileSync(
    join(project, ".pi/bad.ts"),
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'unsafe');export default()=>{};`,
  );
  writeFileSync(join(agent, "trust.json"), JSON.stringify({ [project]: true }));
  t.after(() => {
    rmSync(join(project, ".pi/settings.json"));
    rmSync(join(project, ".pi/bad.ts"));
  });
  const client = await start(t);
  assert.equal(existsSync(sentinel), false);
  assert.equal((await client.fixture({ op: "info" })).trusted, false);
  assert.equal((await client.bash("echo PASS")).exitCode, 0);
});

test("continue and resume keep native sessions and auth", async (t) => {
  const before = readFileSync(join(agent, "auth.json"), "utf8"),
    client = await start(t);
  const file = client.state.sessionFile;
  await client.fixture({ op: "persist" });
  await client.bash("echo NATIVE_SESSION");
  await client.close();
  for (const args of [["-c"], ["--session", file], ["--slice", "-c"], ["--slice", "--session", file]]) {
    const resumed = await start(t, project, { args });
    assert.equal(resumed.state.sessionFile, file);
    assert.equal(resumed.state.model.provider, "openai");
    const shell = await resumed.bash("echo PASS");
    assert.equal(shell.exitCode, 0, JSON.stringify({args, shell, notices: resumed.notices}));
    await resumed.close();
  }
  assert.equal(readFileSync(join(agent, "auth.json"), "utf8"), before);
  assert.equal(existsSync(join(home, ".pi/slice")), false);
});

test("session switching follows ctx.cwd and restores unmarked directories", async (t) => {
  const other = join(home, "q");
  mkdirSync(other);
  mark(other);
  writeFileSync(join(other, "which.txt"), "second workspace");
  for (const dir of [".git/hooks", ".vscode", "vendor/x/.git/hooks"]) mkdirSync(join(other, dir), { recursive: true });
  writeFileSync(join(other, ".git/config"), "[core]\n");
  writeFileSync(join(other, "vendor/x/.git/hooks/existing"), "protected");
  const target = await start(t, other),
    targetFile = target.state.sessionFile;
  await target.fixture({ op: "persist" });
  await target.close();
  const ordinary = await start(t, plain),
    plainFile = ordinary.state.sessionFile;
  await ordinary.fixture({ op: "persist" });
  await ordinary.close();
  const first = await start(t), firstFile = first.state.sessionFile;
  await first.fixture({ op: "persist" }); await first.close();
  const client = await start(t, plain);
  await client.request({ type: "switch_session", sessionPath: firstFile });
  assert.equal((await client.fixture({ op: "info" })).processCwd, plain);
  await client.request({ type: "switch_session", sessionPath: targetFile });
  assert.equal((await client.fixture({ op: "info" })).cwd, other);
  assert.equal((await client.fixture({ op: "info" })).processCwd, plain);
  await client.tool("write", { path: ".git/config", content: "[core]\n" });
  for (const path of [".git/hooks/new", ".vscode/tasks.json", "vendor/x/.git/hooks/new"])
    await assert.rejects(client.tool("write", { path, content: "escape" }));
  assert.match((await client.tool("read", { path: "which.txt" })).content[0].text, /second workspace/);
  await assert.rejects(client.tool("read", { path: join(project, "large.txt") }));
  assert.equal((await client.bash("pwd")).output.trim(), other);
  assert.equal((await client.fixture({ op: "info" })).processCwd, plain);
  await client.request({ type: "switch_session", sessionPath: plainFile });
  const info = await client.fixture({ op: "info" });
  assert.equal(info.cwd, plain);
  assert.equal(info.processCwd, plain);
  assert.deepEqual(info.overridden, []);
  assert.match((await client.bash(`cat '${outside}'`)).output, /host secret/);
});

test(
  "Linux hides home and runtime sockets but permits project and /tmp sockets",
  { skip: process.platform !== "linux" },
  async (t) => {
    const visible = [join(project, ".pi-runtime/visible.sock"), join(root, "host.sock")],
      hidden = [join(home, "hidden.sock")];
    for (const base of ["/run", "/var/run"]) {
      const dir = mkdtempSync(join(base, process.getuid() === 0 ? "" : `user/${process.getuid()}`, "pi-slice-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      hidden.push(join(dir, "host.sock"));
    }
    for (const path of [...visible, ...hidden]) {
      const server = socketServer((socket) => socket.end("OK"));
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      t.after(() => new Promise((resolve) => server.close(resolve)));
    }
    const client = await start(t);
    async function sockets({ visible, hidden }) {
      const net = require("node:net"),
        assert = require("node:assert/strict"),
        fs = require("node:fs");
      const connect = (path) =>
        new Promise((resolve, reject) => {
          const s = net.connect(path);
          let text = "";
          s.setTimeout(3000, () => s.destroy(Error("timeout")));
          s.on("data", (data) => (text += data));
          s.on("end", () => resolve(text));
          s.on("error", reject);
        });
      for (const path of visible) assert.equal(await connect(path), "OK");
      for (const path of hidden) {
        await assert.rejects(connect(path), /ENOENT|EACCES|EPERM/);
        fs.symlinkSync(path, ".pi-runtime/socket-link");
        await assert.rejects(connect(".pi-runtime/socket-link"), /ENOENT|EACCES|EPERM/);
        fs.unlinkSync(".pi-runtime/socket-link");
      }
      console.log("PASS");
    }
    writeFileSync(
      join(project, ".pi-runtime/sockets.mjs"),
      `await (${sockets.toString()})(${JSON.stringify({ visible, hidden })});`,
    );
    const command = "bun --no-env-file .pi-runtime/sockets.mjs",
      user = await client.bash(command),
      model = (await client.tool("bash", { command })).structuredContent;
    for (const result of [user, { exitCode: model.exit_code, output: model.output }]) {
      assert.equal(result.exitCode, 0, result.output);
      assert.equal(result.output.trim(), "PASS");
    }
  },
);

test("dependency drift and an unconfined runtime block every tool", async (t) => {
  const isolated = join(root, "package"),
    runtime = join(isolated, "node_modules/@anthropic-ai/sandbox-runtime");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(join(isolated, "test"));
  mkdirSync(join(isolated, "features"));
  for (const file of ["extension.ts", "sandbox.ts", "workspace.ts", "process.ts", "features/service.ts", "features/service-platform.ts", "features/launch.ts", "features/profile.ts", "test/driver.ts"])
    copyFileSync(join(packageRoot, file), join(isolated, file));
  writeFileSync(join(isolated, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(runtime, "index.js"),
    "export const SandboxManager={initialize:async()=>{},wrapWithSandbox:async command=>command,cleanupAfterCommand(){},reset:async()=>{}};",
  );
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ ...settings, extensions: [join(isolated, "test/driver.ts")] }),
  );
  t.after(() => writeFileSync(join(agent, "settings.json"), JSON.stringify(settings)));
  for (const version of ["0.0.77", "0.0.78"]) {
    writeFileSync(
      join(runtime, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", version, type: "module", main: "index.js" }),
    );
    const client = await start(t);
    await blocked(
      client,
      version === "0.0.77" ? /Unsupported sandbox-runtime version/ : /Sandbox startup probe failed/,
    );
    await client.close();
  }
});

test("removing the marker cannot disable a running sandbox", async (t) => {
  const client = await start(t);
  rmSync(join(project, ".pi-slice"));
  t.after(() => mark(project));
  assert.match((await client.bash("echo $HOME")).output, /\.pi-runtime\/home/);
  await assert.rejects(client.tool("read", { path: outside }));
  await assert.rejects(client.tool("fixture-host", {}), /Only read, bash, edit, write/);
});

test("Node version rejection precedes missing Bun and workspace mutation", async (t) => {
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  for (const [index, script] of [
    "echo v22.19.0",
    "echo invalid",
    "echo v24.0.0; exit 1",
    "echo v24.0.0-rc.1",
  ].entries()) {
    writeFileSync(join(bin, "node"), "#!/bin/sh\n" + script + "\n", { mode: 0o755 });
    const folder = join(home, "version-" + index);
    mkdirSync(folder);
    const environment = { ...env, PATH: bin };
    let client = await start(t, folder, { environment });
    await client.command("/slice init", "pi-slice: node >=24.0.0 required.");
    assert.equal(existsSync(join(folder, ".pi-runtime")), false);
    assert.equal(existsSync(join(folder, ".pi-slice")), false);
    assert.equal(existsSync(join(agent, "pi-slice")), false);
    await client.close();
    mark(folder);
    client = await start(t, folder, { environment });
    assert.equal(existsSync(join(folder, ".pi-runtime")), false);
    await blocked(client, /node >=24.0.0 required/);
    await client.close();
  }
});

test("Pi's own Node runtime is checked before external dependencies", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  try {
    Object.defineProperty(process.versions, "node", {value: "22.23.4"});
    assert.throws(() => requirements(plain, {version: "1.4.0", agentDir: agent, packageDir: packageRoot}),
      /Run Pi with Node 24 LTS or newer \(current: 22\.23\.4\)/);
  } finally {
    Object.defineProperty(process.versions, "node", descriptor);
  }
});

test("missing Bun explains how to install the sandbox helper runtime", async t => {
  const bin = join(root, "node-only");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const environment = {...env, PATH: bin};
  const client = await start(t, plain, {environment});
  const message = await client.command("/slice init", "pi-slice: Missing bun.");
  assert.match(message, /sandbox helpers require Bun >=1\.4\.3/);
  assert.match(message, /npm install -g bun, then restart Pi/);
  assert.equal(existsSync(join(plain, ".pi-slice")), false);
  assert.equal(existsSync(join(plain, ".pi-runtime")), false);
  assert.equal(existsSync(join(agent, "pi-slice")), false);
  await client.close();
  await blocked(await start(t, project, {environment}), /Missing bun/);
});

test("invalid markers block tools before creating runtime state", async (t) => {
  for (const [index, text] of [
    "{",
    "null",
    '{"version":2}',
    '{"version":1,"allowRead":["/"]}',
    '{"version":1,"id":"../other"}',
    '{"version":1,"profile":"unknown"}',
  ].entries()) {
    const folder = join(home, "marker-" + index);
    mkdirSync(folder);
    writeFileSync(join(folder, ".pi-slice"), text);
    const client = await start(t, folder);
    await blocked(client, /pi-slice:/);
    await client.command("/slice init", "pi-slice:");
    assert.equal(existsSync(join(folder, ".pi-runtime")), false);
    assert.equal(readFileSync(join(folder, ".pi-slice"), "utf8"), text);
    await client.close();
  }
});

test("doctor and repeated init preserve project and Pi settings", async (t) => {
  const before = readFileSync(join(agent, "settings.json"), "utf8"),
    client = await start(t);
  assert.match(await client.command("/slice doctor", "pi-slice\n"), /sandbox    healthy/);
  await client.command("/slice init", "This workspace is already isolated.");
  assert.match(await client.command("/slice", "pi-slice\n"), /sandbox    healthy/);
  assert.equal(readFileSync(join(project, ".gitignore"), "utf8"), ".pi-runtime/\n");
  assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), before);
});

test("Node without SQLite fails the startup probe", async (t) => {
  const bin = join(root, "no-sqlite");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), '#!/bin/sh\nif [ "$1" = --version ]; then echo v24.0.0; else exit 1; fi\n', {
    mode: 0o755,
  });
  await blocked(
    await start(t, project, { environment: { ...env, PATH: bin + ":" + env.PATH } }),
    /Sandbox startup probe failed/,
  );
});

test("unsafe runtime symlinks and workspaces inside Pi state block tools", async (t) => {
  const folder = join(home, "unsafe-runtime");
  mkdirSync(folder);
  mark(folder);
  symlinkSync(agent, join(folder, ".pi-runtime"));
  const nested = join(agent, "unsafe-workspace");
  mkdirSync(nested);
  mark(nested);
  for (const cwd of [folder, nested]) {
    await blocked(await start(t, cwd), /Unsafe runtime path|outside trusted Pi state/);
    assert.equal(existsSync(join(agent, "bin")), false);
  }
});

test("snapshots carry only workspace assets and Git with fresh identity", async (t) => {
  const source = join(home, "assets"),
    destination = join(home, "imported");
  mkdirSync(source);
  mark(source);
  const client = await start(t, source);
  await client.command("/slice init", "This workspace is already isolated.");
  for (const path of ["src", ".git", "node_modules", ".pi-runtime/data"])
    mkdirSync(join(source, path), { recursive: true });
  for (const [path, content] of [
    ["src/run.sh", "#!/bin/sh\necho portable\n"],
    [".git/config", "[core]\n"],
    [".env", "PROJECT_SECRET=asset"],
    ["node_modules/omit", "cache"],
    [".pi-runtime/data/omit", "runtime"],
  ])
    writeFileSync(join(source, path), content, { mode: path.endsWith(".sh") ? 0o751 : 0o600 });
  symlinkSync("src/run.sh", join(source, "internal-link"));
  symlinkSync("../private.txt", join(source, "external-link"));
  await client.fixture({ op: "persist", text: "PORTABLE_CONVERSATION" });
  const file = await client.fixture({ op: "pack" });
  await client.fixture({ op: "unpack", file, destination });
  assert.equal(readFileSync(join(destination, "src/run.sh"), "utf8"), readFileSync(join(source, "src/run.sh"), "utf8"));
  const { statSync, readlinkSync } = await import("node:fs");
  assert.equal(statSync(join(destination, "src/run.sh")).mode & 0o777, 0o751);
  assert.equal(readlinkSync(join(destination, "internal-link")), "src/run.sh");
  assert.equal(readFileSync(join(destination, ".env"), "utf8"), "PROJECT_SECRET=asset");
  assert.equal(readFileSync(join(destination, ".git/config"), "utf8"), "[core]\n");
  for (const path of ["node_modules", ".pi-runtime", "external-link"])
    assert.equal(existsSync(join(destination, path)), false);
  const config = JSON.parse(readFileSync(join(destination, ".pi-slice"), "utf8"));
  assert.deepEqual(Object.keys(config).sort(), ["id", "version"]);
  assert.notEqual(config.id, JSON.parse(readFileSync(join(source, ".pi-slice"), "utf8")).id);
  assert.equal(existsSync(join(destination, ".pi-history")), false);
  assert.doesNotMatch(readFileSync(file, "utf8"), /PORTABLE_CONVERSATION|fixture-key|fixture-github/);
  await assert.rejects(client.fixture({ op: "unpack", file, destination }), /new destination/);
  const imported = await start(t, destination);
  assert.notEqual(imported.state.sessionId, client.state.sessionId);
  assert.equal((await imported.bash("echo PASS")).output.trim(), "PASS");
});

test("archive extraction rejects traversal, escaping links, special files and duplicates", async (t) => {
  const client = await start(t);
  for (const [index, entries] of [
    [{ path: "../escape", type: "File", data: "bad" }],
    [{ path: "/tmp/escape", type: "File", data: "bad" }],
    [{ path: "link", type: "SymbolicLink", linkpath: "../escape" }],
    [{ path: "fifo", type: "FIFO" }],
    [{ path: ".", type: "SymbolicLink", linkpath: "sub" }],
    [{ path: "root", type: "SymbolicLink", linkpath: "." }, { path: "escape", type: "SymbolicLink", linkpath: "root/../outside" }],
    [{ path: "a", type: "SymbolicLink", linkpath: "b" }, { path: "b", type: "SymbolicLink", linkpath: "a" }],
    [{ path: "sym", type: "SymbolicLink", linkpath: "asset" }, { path: "hard", type: "Link", linkpath: "sym" }],
    [
      { path: "same", type: "File", data: "first" },
      { path: "same", type: "File", data: "second" },
    ],
    [
      { path: "dir", type: "SymbolicLink", linkpath: "inside" },
      { path: "dir/file", type: "File", data: "bad" },
    ],
  ].entries()) {
    const blocks = [];
    for (const entry of entries) {
      const body = Buffer.from(entry.data || ""),
        header = new Header({ ...entry, size: body.length, mode: 0o600 });
      header.encode();
      blocks.push(header.block, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    const file = join(root, "malicious-" + index + ".tar");
    writeFileSync(file, Buffer.concat([...blocks, Buffer.alloc(1024)]));
    await assert.rejects(client.fixture({ op: "extract", file }), /Unsafe|Archive link|Unsupported|symbolic link/);
  }
  assert.equal(existsSync(join(root, "escape")), false);
});

test("ordinary Git clones and nested init use standard metadata in both session modes", async (t) => {
  const source = join(project, "upstream");
  mkdirSync(source);
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: source, encoding: "utf8",
      env: {PATH: env.PATH, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"},
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "--template="]);
  writeFileSync(join(source, "hello.txt"), "cloned fixture\n");
  git(["add", "hello.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "fixture"]);
  git(["update-server-info"]);
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    try { response.end(readFileSync(join(source, ".git", path))); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const normal = await start(t);
  const minimal = await start(t, project, {args: ["--slice"]});
  for (const [name, run] of [
    ["user", command => normal.bash(command)],
    ["model", async command => {
      const result = (await normal.tool("bash", {command})).structuredContent;
      return {exitCode: result.exit_code, output: result.output};
    }],
    ["minimal", command => minimal.bash(command)],
  ]) {
    const result = await run(`export NO_PROXY= no_proxy=; git clone '${url}' ${name}-clone && git init ${name}-new && ` +
      `git -C ${name}-clone config slice.fixture yes && git -C ${name}-clone status --porcelain`);
    assert.equal(result.exitCode, 0, result.output);
    for (const dir of [`${name}-clone`, `${name}-new`]) {
      assert.equal(statSync(join(project, dir, ".git")).isDirectory(), true);
      assert.equal(existsSync(join(project, dir, ".git/hooks/commit-msg.sample")), false);
    }
    assert.equal(readFileSync(join(project, `${name}-clone/hello.txt`), "utf8"), "cloned fixture\n");
    assert.match(readFileSync(join(project, `${name}-clone/.git/config`), "utf8"), /fixture = yes/);
  }
  await assert.rejects(normal.tool("write", {path: "user-clone/.git/hooks/pre-commit", content: "blocked"}));
});

test("fresh Git initialization and commits use only host name/email", async (t) => {
  rmSync(join(project, ".git"), { recursive: true });
  const client = await start(t);
  if (process.platform === "darwin") {
    // Seatbelt pins .git at the workspace root, even before it exists.
    const denied = await client.bash("git init");
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.output, /Operation not permitted|Permission denied/);
    assert.equal(existsSync(join(project, ".git")), false);
    const init = spawnSync("git", ["init", "--template=", project], {encoding: "utf8"});
    assert.equal(init.status, 0, init.stderr);
  }
  const result = await client.bash(
    (process.platform === "linux" ? "git init && " : "") +
    "echo hello > hello.txt && git add hello.txt && git commit -m first && git log -1 --format='%an <%ae>'",
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /Test Author <author@example.com>/);
  await assert.rejects(client.tool("write", { path: ".git/hooks/pre-commit", content: "escape" }));
});

test(
  "same-workspace commands serialize cleanup; cancelled work releases the lock",
  { timeout: 10000 },
  async (t) => {
    const a = await start(t),
      b = await start(t);
    const first = a.bash(
      "echo started > .pi-runtime/started; sleep 1; test ! -e .pi-runtime/second; " +
      (process.platform === "linux" ? "test -e .vscode; " : "") + "echo FIRST",
    );
    while (!existsSync(join(project, ".pi-runtime/started"))) await new Promise((r) => setTimeout(r, 20));
    const second = b.bash("touch .pi-runtime/second; mkdir .vscode 2>/dev/null; echo escape > .vscode/tasks.json");
    assert.equal((await first).exitCode, 0);
    assert.notEqual((await second).exitCode, 0);
    assert.equal(existsSync(join(project, ".vscode/tasks.json")), false);
    const tool = a.fixture({ op: "cancel", command: "echo started > .pi-runtime/cancel; sleep 20; touch late" });
    assert.match(await tool, /abort|cancel/i);
    const after = await b.bash("echo RELEASED");
    assert.equal(after.output.trim(), "RELEASED");
    assert.equal(existsSync(join(project, "late")), false);
  },
);

test("export rejects absolute links and restores metadata without truncating hardlinked assets", async (t) => {
  const client = await start(t);
  writeFileSync(join(project, "asset"), "ORIGINAL");
  symlinkSync(join(project, "asset"), join(project, "absolute-link"));
  await assert.rejects(client.fixture({ op: "pack" }), /Absolute symlink: absolute-link/);
  rmSync(join(project, "absolute-link"));
  symlinkSync(".", join(project, "root-link"));
  symlinkSync("root-link/../outside", join(project, "indirect-link"));
  await assert.rejects(client.fixture({ op: "pack" }), /Archive link leaves/);
  rmSync(join(project, "root-link")); rmSync(join(project, "indirect-link"));
  writeFileSync(join(project, ".gitignore"), "# original\n");
  linkSync(join(project, ".pi-slice"), join(project, "marker-copy"));
  linkSync(join(project, ".gitignore"), join(project, "ignore-copy"));
  const marker = readFileSync(join(project, "marker-copy"), "utf8"),
    ignore = readFileSync(join(project, "ignore-copy"), "utf8");
  const file = await client.fixture({ op: "pack" }),
    destination = join(home, "restored-links");
  await client.fixture({ op: "unpack", file, destination });
  assert.equal(readFileSync(join(destination, "asset"), "utf8"), "ORIGINAL");
  assert.equal(readFileSync(join(destination, "marker-copy"), "utf8"), marker);
  assert.equal(readFileSync(join(destination, "ignore-copy"), "utf8"), ignore);

});

test("unmarked Pi reaches the real import prompt without creating a sandbox", async (t) => {
  const client = await start(t, plain);
  await client.command("/slice import ../missing.slice ../new", "pi-slice: Restore needs interactive Pi");
  assert.equal(existsSync(join(plain, ".pi-runtime")), false);
  for (const command of ["web", "share", "snapshot", "restore", "doctor export", "doctor arbitrary", "init gold"])
    await client.command("/slice " + command, "pi-slice: Use /slice");
});

test(
  "unavailable workspace locking fails closed before runtime preparation",
  async (t) => {
    const bin = join(root, "no-lock"),
      folder = join(home, "no-lock");
    mkdirSync(bin);
    mkdirSync(folder);
    mark(folder);
    writeFileSync(join(bin, process.platform === "linux" ? "flock" : "bun"),
      process.platform === "linux" ? "#!/bin/sh\nexit 1\n" :
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.3; else exit 1; fi\n',
      { mode: 0o700 });
    const client = await start(t, folder, { environment: { ...env, PATH: bin + ":" + env.PATH } });
    await blocked(client, /lock acquisition failed/);
    assert.equal(existsSync(join(folder, ".pi-runtime")), false);
  },
);

test("owner death terminates an active Linux sandbox command", { skip: process.platform !== "linux" }, async (t) => {
  const client = await start(t);
  client.child.stdin.write(
    JSON.stringify({
      id: "orphan",
      type: "bash",
      command: "touch .pi-runtime/running; sleep 2; touch .pi-runtime/orphan",
    }) + "\n",
  );
  while (!existsSync(join(project, ".pi-runtime/running"))) await new Promise((resolve) => setTimeout(resolve, 20));
  client.child.kill("SIGKILL");
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(existsSync(join(project, ".pi-runtime/orphan")), false);
  const next = await start(t);
  assert.equal((await next.bash("echo RECOVERED")).output.trim(), "RECOVERED");
});


test("status is read-only in both unmarked and marked Pi", async t => {
  for (const cwd of [plain, project]) {
    const client = await start(t, cwd), before = readdirSync(cwd);
    const text = await client.command("/slice", "pi-slice\n");
    assert.match(text, cwd === plain ? /unmarked/ : /sandbox    healthy/);
    assert.deepEqual(readdirSync(cwd), before);
    assert.equal(existsSync(join(agent, "pi-slice", JSON.parse(readFileSync(join(project,".pi-slice"),"utf8")).id)), false);
  }
});

const nativeServices = process.platform === "linux"
  ? spawnSync("systemctl", ["--user", "show-environment"], {stdio: "ignore"}).status === 0
  : process.platform === "darwin" && spawnSync("launchctl", ["print", "gui/" + process.getuid()], {stdio: "ignore"}).status === 0;
const serviceSkip = nativeServices ? false : "Native service tests need a systemd user manager or launchd GUI session.";
if (serviceSkip) console.warn("WARNING: " + serviceSkip + " Service integration coverage is skipped.");
if (process.env.PI_SLICE_REQUIRE_SERVICES === "1")
  assert.ok(nativeServices, "Native service tests are required here; refusing to skip them.");
const service = async (client, params) => JSON.parse((await client.tool("slice_service", params)).content[0].text);
function cleanupService(t) {
  const backend = servicePlatform(project), {label} = servicePaths(project, agent);
  t.after(async () => { if (await backend.active(label)) await backend.stop(label); });
}

test("a sandboxed preview survives Pi, permits edits and keeps its boundary after command cleanup", {skip: serviceSkip}, async t => {
  cleanupService(t);
  writeFileSync(join(project, "index.html"), "FIRST");
  writeFileSync(join(project, "server.ts"), `
import fs from 'node:fs'; import assert from 'node:assert/strict';
function check(){
 for(const p of ${JSON.stringify([outside, join(agent, "auth.json")])}) assert.throws(()=>fs.readFileSync(p));
 for(const p of ['.pi-slice','.git/config','.git/hooks/sentinel','asset-write']) assert.throws(()=>fs.writeFileSync(p,'bad'));
 for(const k of ['GH_TOKEN','OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','PI_SLICE_TEST_SECRET']) assert.equal(process.env[k],undefined,k);
 assert.doesNotMatch(process.env.JAVA_TOOL_OPTIONS||'',/pi.slice.host|secret/);
 assert.doesNotMatch(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('GIT_CONFIG_')))),/HOST_INJECTION/);
 fs.writeFileSync(process.env.XDG_DATA_HOME+'/state','private runtime');
 return 'PASS';
}
Bun.serve({unix:process.env.PI_SLICE_SOCKET,fetch(req,server){
 const p=new URL(req.url).pathname;
 if(p==='/ws'&&server.upgrade(req))return;
 return new Response(p==='/check'?check():Bun.file('index.html'));
},websocket:{message(ws,message){ws.send(message)}}});
console.log('PREVIEW_READY');`);
  const client = await start(t), other = await start(t);
  const [state, same] = await Promise.all([client, other].map(c => service(c, {action: "start", command: "bun run server.ts"})));
  assert.equal(state.state, "running"); assert.equal(same.url, state.url);
  assert.match(state.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await (await fetch(state.url)).text(), "FIRST");
  assert.equal(await (await fetch(state.url + "/check")).text(), "PASS");
  assert.equal((await fetch(state.url, {headers: {origin: "https://untrusted.example"}})).status, 403);
  const spoofed = await new Promise((resolve, reject) => {
    get(state.url, {headers: {host: "untrusted.example"}}, res => {res.resume(); resolve(res.statusCode);}).on("error", reject);
  });
  assert.equal(spoofed, 403);
  assert.equal((await fetch(state.url, {headers: {"sec-fetch-site": "cross-site"}})).status, 403);
  const navigate = {"sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"};
  // http.get preserves Fetch Metadata headers; native fetch overwrites its mode.
  const navigation = headers => new Promise((resolve, reject) => {
    get(state.url, {headers}, res => {res.resume(); resolve(res.statusCode);}).on("error", reject);
  });
  assert.equal(await navigation(navigate), 200);
  assert.equal(await navigation({...navigate, "sec-fetch-dest": "iframe"}), 403);
  assert.equal(await navigation({...navigate, origin: "https://untrusted.example"}), 403);
  assert.equal((await fetch(state.url, {method: "POST", headers: navigate})).status, 403);
  const ws = new WebSocket(state.url.replace("http:", "ws:") + "/ws");
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const echo = new Promise(resolve => { ws.onmessage = event => resolve(event.data); });
  ws.send("echo"); assert.equal(await echo, "echo"); ws.close();
  await client.tool("write", {path: "index.html", content: "EDITED"});
  for (let i = 0; i < 3; i++) await other.bash("true");
  await assert.rejects(client.tool("read", {path: servicePaths(project, agent).config}));
  await client.close();
  other.child.kill("SIGKILL"); await other.exited;
  assert.equal(await (await fetch(state.url)).text(), "EDITED");
  assert.equal(await (await fetch(state.url + "/check")).text(), "PASS");
  const resumed = await start(t);
  assert.equal((await service(resumed, {action: "status"})).url, state.url);
  assert.match((await service(resumed, {action: "logs"})).output, /PREVIEW_READY/);
  await service(resumed, {action: "stop"});
  await assert.rejects(fetch(state.url));
  assert.equal((await service(resumed, {action: "status"})).state, "stopped");
  assert.equal(existsSync(join(project, "asset-write")), false);
  assert.equal(readFileSync(outside, "utf8"), "host secret");
});

test("service startup rejects socket symlinks and never executes commands on the host", {skip: serviceSkip}, async t => {
  cleanupService(t);
  let connections = 0;
  const secretSocket = join(agent, "host.sock"), server = socketServer(socket => { connections++; socket.end("SECRET"); });
  await new Promise(resolve => server.listen(secretSocket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await start(t);
  writeFileSync(join(project, "link.ts"), `require('node:fs').symlinkSync(${JSON.stringify(secretSocket)},process.env.PI_SLICE_SOCKET);setInterval(()=>{},1000);`);
  await assert.rejects(service(client, {action: "start", command: "bun run link.ts"}), /Unix socket|file or link/);
  assert.doesNotMatch(JSON.parse(readFileSync(servicePaths(project, agent).state, "utf8")).error, /^Error:/);
  const failure = await client.command("/slice run bun run link.ts", "pi-slice:");
  assert.match(failure, /^pi-slice: PI_SLICE_SOCKET/);
  assert.equal(connections, 0);
  await assert.rejects(service(client, {action: "start", command: `echo bad > '${visible}'`, preview: false}), /exited|stopped/);
  assert.equal(readFileSync(visible, "utf8"), "read only");
  await assert.rejects(service(client, {action: "start", command: "exit 7", preview: false}), /exited|stopped/);
  assert.equal(await servicePlatform(project).active(servicePaths(project, agent).label), false);
});

test("service cancellation stops startup and a foreground worker can be restarted", {skip: serviceSkip}, async t => {
  cleanupService(t);
  const client = await start(t);
  const command = `bun -e 'setInterval(()=>console.log("WORKING"),100)'`;
  assert.match(await client.fixture({op: "cancel", tool: "slice_service", params: {action: "start", command}}), /Abort|cancel/i);
  assert.equal(await servicePlatform(project).active(servicePaths(project, agent).label), false);
  assert.equal((await service(client, {action: "start", command, preview: false})).state, "running");
  await assert.rejects(service(client, {action: "start", command}), /already running/);
  await client.command("/slice stop", "Service stopped.");
  assert.equal((await service(client, {action: "status"})).state, "stopped");
  await client.command("/slice run --background " + command, "Service running.");
  assert.match(await client.command("/slice logs", "Service running."), /\nWORKING\n/);
  await service(client, {action: "stop"});
});

test("preview path length fails before launch; workers do not need a socket", {skip: serviceSkip}, async t => {
  const longAgent = join(root, "long-" + "x".repeat(100)); mkdirSync(longAgent);
  writeFileSync(join(longAgent, "settings.json"), JSON.stringify(settings));
  const paths = servicePaths(project, longAgent), backend = servicePlatform(project);
  t.after(async () => {if (await backend.active(paths.label)) await backend.stop(paths.label);});
  const client = await start(t, project, {environment: {...env, PI_CODING_AGENT_DIR: longAgent}});
  await assert.rejects(service(client, {action: "start", command: "bun run server.ts"}), /Pi state path is too long/);
  assert.equal(existsSync(paths.dir), false);
  assert.equal(await backend.active(paths.label), false);
  assert.match(await client.command("/slice doctor", "pi-slice\n"), /Pi state path is too long/);
  await service(client, {action: "start", command: "sleep 60", preview: false});
  await service(client, {action: "stop"});
});

test("logs stay bounded and saved services can be stopped after deleting their workspace", {skip: serviceSkip}, async t => {
  cleanupService(t);
  const client = await start(t), paths = servicePaths(project, agent);
  writeFileSync(join(project, "noisy.ts"), `for(let i=0;i<512;i++)console.log('€'.repeat(4096));console.log('LATEST\\nplain logs');setInterval(()=>{},1000);`);
  await service(client, {action: "start", command: "bun run noisy.ts", preview: false});
  const deadline = Date.now() + 5000;
  while (!readFileSync(paths.log, "utf8").includes("LATEST") && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(statSync(paths.log).size <= 128000);
  assert.doesNotThrow(() => new TextDecoder("utf-8", {fatal: true}).decode(readFileSync(paths.log)));
  assert.match((await service(client, {action: "logs"})).output, /LATEST\nplain logs/);
  await client.close();
  rmSync(project, {recursive: true});
  const bin = join(root, "broken-tools"); mkdirSync(bin);
  for (const name of process.platform === "linux" ? ["bun", "node"] : ["node"])
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 99\n", {mode: 0o755});
  const ordinary = await start(t, plain, {environment: {...env, PATH: bin + ":" + env.PATH}});
  const broken = servicePaths(join(root, "bad-config"), agent);
  mkdirSync(broken.dir); writeFileSync(broken.config, "broken JSON");
  const listed = await ordinary.command("/slice services", "Services\n");
  assert.ok(listed.includes(project)); assert.ok(listed.includes(paths.label)); assert.match(listed, /Service running/);
  assert.ok(listed.includes(broken.label)); assert.match(listed, /Invalid service configuration/);
  assert.match(await ordinary.command("/slice stop " + broken.label, "pi-slice:"), /Invalid service configuration/);
  await ordinary.command("/slice stop " + paths.label, "Service stopped.");
  assert.equal(await servicePlatform(project).active(paths.label), false);
  assert.equal(JSON.parse(readFileSync(paths.state, "utf8")).state, "stopped");
  assert.match(await ordinary.command("/slice stop not-ours", "pi-slice:"), /Unknown service ID/);
  assert.ok(existsSync(join(paths.dir, "runtime")), "Stopping keeps private app data");
});

test("failed sandbox startup still reports and stops a running service", {skip: serviceSkip}, async t => {
  cleanupService(t);
  const client = await start(t);
  await service(client, {action: "start", command: "sleep 60", preview: false});
  await client.close();
  const marker = readFileSync(join(project, ".pi-slice"));
  writeFileSync(join(project, ".pi-slice"), "broken JSON");
  const invalid = await start(t);
  const invalidStatus = await invalid.command("/slice", "pi-slice\n");
  assert.match(invalidStatus, /sandbox    Invalid .pi-slice JSON/);
  assert.match(invalidStatus, /workspace  invalid marker/);
  assert.match(invalidStatus, /service    running/);
  await invalid.close();
  writeFileSync(join(project, ".pi-slice"), marker);
  const bin = join(root, "missing-flock"); mkdirSync(bin);
  const names = process.platform === "linux" ? ["systemctl", "systemd-run"] : ["launchctl", "bun"];
  for (const name of names) {
    const path = env.PATH.split(":").map(dir => join(dir, name)).find(existsSync);
    symlinkSync(realpathSync(path), join(bin, name));
  }
  const failed = await start(t, project, {environment: {...env, PATH: bin}});
  const status = await failed.command("/slice", "pi-slice\n");
  assert.match(status, /sandbox    Missing (bun|node)/);
  assert.match(status, /service    running/);
  await failed.command("/slice stop", "Service stopped.");
  assert.equal(await servicePlatform(project).active(servicePaths(project, agent).label), false);
});

test("the service runner checks the installed Pi version", {skip: serviceSkip}, async t => {
  cleanupService(t);
  const packageDir = join(root, "changed-pi"); mkdirSync(packageDir);
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({version: "1.3.0"}));
  const host = {version: "1.4.0", agentDir: agent, packageDir};
  await assert.rejects(serviceAction(project, host, {action: "start", command: "sleep 60", preview: false}), /^Error: Pi 1\.4\.0 or newer required\.$/);
  assert.equal(JSON.parse(readFileSync(servicePaths(project, agent).state, "utf8")).error, "Pi 1.4.0 or newer required.");
});

test("service crashes are reported and supervisor stop kills descendants", {skip: serviceSkip}, async t => {
  cleanupService(t);
  const client = await start(t), paths = servicePaths(project, agent);
  writeFileSync(join(project, "crash.ts"), `Bun.serve({unix:process.env.PI_SLICE_SOCKET,fetch(req){if(new URL(req.url).pathname==='/crash')setTimeout(()=>process.exit(7),10);return new Response('OK');}});`);
  const state = await service(client, {action: "start", command: "bun run crash.ts"});
  await fetch(state.url + "/crash");
  const deadline = Date.now() + 5000;
  let failed;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    failed = await service(client, {action: "status"});
  } while (failed.state === "running" && Date.now() < deadline);
  assert.equal(failed.state, "failed"); assert.match(failed.error, /code 7/);
  writeFileSync(join(project, "worker.ts"), `Bun.spawn(['bun','-e',\`setInterval(()=>require('fs').appendFileSync(process.env.XDG_DATA_HOME+'/ticks','x'),50)\`],{stdio:['ignore','ignore','ignore']});setInterval(()=>{},1000);`);
  await service(client, {action: "start", command: "bun run worker.ts", preview: false});
  const ticks = join(paths.dir, "runtime/data/ticks");
  assert.ok(readFileSync(ticks).length > 0);
  await service(client, {action: "stop"});
  const final = readFileSync(ticks, "utf8");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(readFileSync(ticks, "utf8"), final);
});

test("missing service supervision explains the limitation while ordinary tools work", async t => {
  const bin = join(root, "no-supervisor"); mkdirSync(bin);
  for (const name of ["systemctl", "systemd-run", "launchctl"])
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", {mode: 0o755});
  const client = await start(t, project, {environment: {...env, PATH: bin + ":" + env.PATH}});
  await assert.rejects(service(client, {action: "start", command: "bun run server.ts"}), /need a.*(systemd|launchd)/);
  const doctor = await client.command("/slice doctor", "pi-slice\n");
  assert.match(doctor, /Background services need/);
  assert.equal((await client.bash("echo STILL_WORKS")).output.trim(), "STILL_WORKS");
});
