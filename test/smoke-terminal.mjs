import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const base = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "slice-tty-")));
const home = join(base, "home"), agent = join(base, "agent"), project = join(home, "project");
const node = Bun.which("node"), pi = realpathSync(Bun.which("pi"));
for (const dir of [home, agent, project]) mkdirSync(dir, {recursive: true});
writeFileSync(join(agent, "settings.json"), JSON.stringify({extensions: [join(dirname(import.meta.dirname), "extension.ts")],
  quietStartup: true, tuiMode: "regular", defaultProvider: "openai", defaultModel: "gpt-6-astra"}));
writeFileSync(join(agent, "auth.json"), JSON.stringify({openai: {type: "api_key", key: "fixture-only"}}), {mode: 0o600});
const env = {...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, TERM: "xterm-256color"};
delete env.PI_SLICE_LAUNCH;
delete env.PI_CODING_AGENT_SESSION_DIR;

async function until(check, detail) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw Error(detail());
}

async function terminal(args, run) {
  let output = "";
  const tty = new Bun.Terminal({cols: 120, rows: 40, data(_tty, data) { output = (output + new TextDecoder().decode(data)).slice(-100000); }});
  const child = Bun.spawn([node, pi, "--offline", ...args], {env, cwd: project, terminal: tty});
  const text = () => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  try {
    await until(() => text().includes("gpt-6-astra"), () => "Pi TUI did not initialize: " + text());
    // The editor appears before startup hooks finish.
    await Bun.sleep(600);
    await run(tty, text, child);
    await until(() => child.exitCode !== null, () => "Pi did not exit: " + text());
    assert.equal(await child.exited, 0, text());
  } finally { child.kill("SIGKILL"); tty.close(); }
}

try {
  await terminal([], async tty => { tty.write("/slice init\r"); });
  assert.equal(JSON.parse(readFileSync(join(project, ".pi-slice"), "utf8")).version, 1);
  await terminal(["--slice"], async (tty, text) => {
    tty.write("/slice doctor\r");
    await until(() => /config\s+Slice/.test(text()) && /sandbox\s+healthy/.test(text()), text);
    tty.write("!printf 'from the TUI' > result.txt\r");
    await until(() => { try { return readFileSync(join(project, "result.txt"), "utf8") === "from the TUI"; } catch { return false; } }, text);
    tty.write("/slice config\r");
    await until(() => text().includes('"mcpServers"'), text);
    tty.write("\x1b");
    await Bun.sleep(200);
    tty.write("/quit\r");
  });
  console.log("Pi TUI: init, automatic --slice restart, sandbox command, configuration editor and exit passed.");
} finally { rmSync(base, {recursive: true, force: true}); }
