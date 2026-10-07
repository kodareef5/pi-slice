import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { executable } from "../workspace.ts";

const exec = promisify(execFile);
const xml = (value: string) => value.replace(/[<>&"']/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"})[c]!);
export function launchAgent(label: string, args: string[], log: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>ProcessType</key><string>Background</string><key>ExitTimeOut</key><integer>8</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>`;
}

// Native supervisors own processes. No saved PID is ever used to stop a service.
export function servicePlatform(root: string, platform = process.platform) {
  const hostEnv = { HOME: homedir(), PATH: process.env.PATH,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS };
  const run = async (name: string, args: string[]) =>
    (await exec(executable(name, root), args, {env: hostEnv, cwd: "/", timeout: 10000, maxBuffer: 128 * 1024})).stdout;
  if (platform === "linux") return {
    name: "systemd user service",
    async check() {
      try { await run("systemctl", ["--user", "show-environment"]); executable("systemd-run", root); }
      catch { throw Error("Background services need a running systemd user manager on Linux. This host has none available. Ordinary pi-work tools still work; no unsandboxed fallback is used. Use a systemd user session or a future alternative backend."); }
    },
    async active(label: string) {
      try { return /^(active|activating|deactivating)$/.test((await run("systemctl", ["--user", "show", label, "--property=ActiveState", "--value"])).trim()); }
      catch { return false; }
    },
    async start(label: string, args: string[], dir: string) {
      await run("systemd-run", ["--user", "--unit=" + label, "--collect", "--service-type=exec",
        "--property=KillMode=control-group", "--property=TimeoutStopSec=8", "--working-directory=" + dir, ...args]);
    },
    async stop(label: string) { await run("systemctl", ["--user", "stop", label]); },
  };
  if (platform === "darwin") {
    const domain = "gui/" + process.getuid!();
    return {
      name: "launchd agent",
      async check() {
        try { await run("launchctl", ["print", domain]); }
        catch { throw Error("Background services need a logged-in macOS launchd user session. Ordinary pi-work tools still work; no unsandboxed fallback is used."); }
      },
      async active(label: string) {
        try {
          const status = await run("launchctl", ["print", domain + "/" + label]);
          // launchd assigns a PID while xpcproxy is still preparing the process.
          // Treat that startup phase as active so callers do not stop it early.
          return /^\s*state = (running|spawn scheduled)\s*$/m.test(status) ||
            /^\s*pid = [1-9]\d*\s*$/m.test(status);
        }
        catch { return false; }
      },
      async start(label: string, args: string[], dir: string) {
        // A completed job can remain registered. Its program is no longer running.
        try { await run("launchctl", ["bootout", domain + "/" + label]); } catch {}
        const file = join(dir, "agent.plist");
        writeFileSync(file, launchAgent(label, args, join(dir, "supervisor.log")), {mode: 0o600});
        await run("launchctl", ["bootstrap", domain, file]);
      },
      async stop(label: string) {
        await run("launchctl", ["bootout", domain + "/" + label]);
        // bootout can return while launchd is still terminating the job.
        const deadline = Date.now() + 10000;
        while (await this.active(label)) {
          if (Date.now() >= deadline) throw Error("launchd service did not stop within 10 seconds.");
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      },
    };
  }
  throw Error("Background services support systemd on Linux and launchd on macOS. No backend is available on this platform.");
}
