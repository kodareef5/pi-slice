import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {servicePlatform} from "../features/service-platform.ts";
import {record, serviceAction, servicePaths} from "../features/service.ts";

test("native supervisors receive literal arguments, bounded shutdown and no automatic restart", async t => {
  const base = mkdtempSync(join(tmpdir(), "pi-work-backend-")), bin = join(base, "bin"), log = join(base, "calls"), status = join(base, "status");
  mkdirSync(bin);
  writeFileSync(status, "state = running");
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; rmSync(base, {recursive: true, force: true}); });
  for (const name of ["systemctl", "systemd-run", "launchctl"])
    writeFileSync(join(bin, name), `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');
${name === "launchctl" ? `const fs=require('fs'),status=${JSON.stringify(status)};
if(process.argv[2]==='bootout')fs.writeFileSync(status,'state = waiting');
if(process.argv[2]==='bootstrap')fs.writeFileSync(status,'state = running');
console.log(fs.readFileSync(status,'utf8'));` : `console.log(${JSON.stringify(name === "systemctl" ? "active" : "state = running")});`}`, {mode: 0o755});
  process.env.PATH = bin;
  const args = ["/usr/bin/env", "-i", "PATH=/a & b", "/trusted/node", "<runner>", "'config'"];
  for (const platform of ["linux", "darwin"]) {
    const backend = servicePlatform(join(base, "project"), platform);
    await backend.check();
    assert.equal(await backend.active("pi-work-test"), true);
    if (platform === "darwin") {
      writeFileSync(status, "state = xpcproxy\npid = 12345\n");
      assert.equal(await backend.active("pi-work-test"), true);
      writeFileSync(status, "state = waiting\nruns = 1\nlast exit code = 0\n");
      assert.equal(await backend.active("pi-work-test"), false);
    }
    await backend.start("pi-work-test", args, base);
    await backend.stop("pi-work-test");
  }
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const run = calls.find(args => args.includes("--collect"));
  assert.deepEqual(run.slice(-args.length), args);
  assert.ok(run.includes("--property=KillMode=control-group"));
  assert.ok(run.includes("--property=TimeoutStopSec=8"));
  assert.equal(run.some(arg => /Restart=/.test(arg)), false);
  assert.ok(calls.some(args => args[0] === "bootstrap" && args[1] === "gui/" + process.getuid()));
  assert.ok(calls.some(args => args[0] === "bootout" && args[1].endsWith("/pi-work-test")));
  const plist = readFileSync(join(base, "agent.plist"), "utf8");
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<key>ExitTimeOut<\/key><integer>8<\/integer>/);
  assert.match(plist, /PATH=\/a &amp; b/);
  assert.match(plist, /&lt;runner&gt;/);
  assert.match(plist, /&apos;config&apos;/);
  assert.throws(() => servicePlatform(base, "freebsd"), /No backend/);
});

test("status and logs do not need a workspace or runtime executables", async t => {
  const agent = mkdtempSync(join(tmpdir(), "pi-work-status-")), root = join(agent, "missing-project");
  const paths = servicePaths(root, agent), previous = process.env.PATH;
  t.after(() => {process.env.PATH = previous; rmSync(agent, {recursive: true, force: true});});
  mkdirSync(paths.dir, {recursive: true});
  record(paths.state, {state: "stopped"}); writeFileSync(paths.log, "line one\nline two\n");
  process.env.PATH = "";
  const pi = {version: "unavailable", packageDir: "missing", agentDir: agent};
  assert.equal((await serviceAction(root, pi, {action: "status"})).state, "stopped");
  assert.equal((await serviceAction(root, pi, {action: "logs"})).output, "line one\nline two\n");
});
