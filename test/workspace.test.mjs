import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { staging } from "../workspace.ts";

test("staging reclaims confirmed dead owners and preserves live or unknown owners", async (t) => {
  const agent = mkdtempSync(join(tmpdir(), "pi-work-stage-"));
  t.after(() => rmSync(agent, { recursive: true, force: true }));
  const live = staging(agent),
    base = join(agent, "pi-work/staging");
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await once(child, "exit");
  const dead = join(base, `${child.pid}-${randomUUID()}-abcdef`),
    unknown = join(base, "unknown-owner");
  mkdirSync(dead);
  mkdirSync(unknown);
  staging(agent);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(unknown), true);
});
