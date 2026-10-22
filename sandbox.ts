import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { executable, inside } from "./workspace.ts";

const require = createRequire(import.meta.url);
const packageRoot = import.meta.dirname;

export const present = (path: string) => {
  try {
    return !!lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return true;
  } // An unreadable marker must not disable confinement.
};
const systemPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type PiHost = { version: string; agentDir: string; packageDir: string };

export function requirements(cwd: string, pi: PiHost) {
  if (!["linux", "darwin"].includes(process.platform)) throw Error("Use macOS or Linux (Windows requires WSL).");
  const piVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(pi.version);
  if (!piVersion || Number(piVersion[1]) < 1 || (Number(piVersion[1]) === 1 && Number(piVersion[2]) < 4))
    throw Error("Pi 1.4.0 or newer required.");
  const root = realpathSync(cwd);
  if (inside(realpathSync(homedir()), root))
    throw Error("Choose a workspace below your home, not your home or a parent directory.");
  for (const path of [pi.agentDir, pi.packageDir, packageRoot]) {
    const trusted = realpathSync(path);
    if (inside(trusted, root) || inside(root, trusted))
      throw Error("Choose a workspace outside trusted Pi state and installed extension code.");
  }
  const tools: Record<string, string> = {};
  for (const name of [
    "bun",
    "node",
    "npm",
    "git",
    "rg",
    ...(process.platform === "linux" ? ["bwrap", "socat", "flock"] : []),
  ]) {
    tools[name] = executable(name, root);
  }
  const version = (name: string, minimum: number[]) => {
    const result = spawnSync(tools[name], ["--version"], {
      cwd: "/",
      env: { PATH: systemPath, HOME: homedir() },
      encoding: "utf8",
      timeout: 5000,
    });
    const text = result.stdout?.trim().replace(/^v/, "") || "";
    const parts = text.split(".").map(Number);
    const enough =
      parts[0] > minimum[0] ||
      (parts[0] === minimum[0] && (parts[1] > minimum[1] || (parts[1] === minimum[1] && parts[2] >= minimum[2])));
    if (result.status !== 0 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(text) || !enough)
      throw Error(`${name} >=${minimum.join(".")} required.`);
    return text;
  };
  const nodeVersion = version("node", [24, 0, 0]),
    bunVersion = version("bun", [1, 4, 3]);
  if (Number(process.versions.node.split(".")[0]) < 24) throw Error("Run Pi with Node >=24.0.0.");
  const runtimeVersion = JSON.parse(
    readFileSync(require.resolve("@anthropic-ai/sandbox-runtime/package.json"), "utf8"),
  ).version;
  if (runtimeVersion !== "0.0.78") throw Error("Unsupported sandbox-runtime version; expected 0.0.78.");
  return { root, tools, nodeVersion, bunVersion };
}

export function prepareRuntime(runtime: string, tools: Record<string, string>): Record<string, string> {
  const root = realpathSync(dirname(runtime));
  for (const part of ["", "bin", "home", "cache", "tmp", "config", "data"]) {
    const path = join(runtime, part);
    if (present(path) && (lstatSync(path).isSymbolicLink() || !inside(realpathSync(path), root)))
      throw Error(`Unsafe runtime path: ${path}`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  for (const name of ["bun", "node", "npm", "git", "rg"]) {
    const path = join(runtime, "bin", name);
    rmSync(path, { force: true });
    symlinkSync(tools[name], path);
  }
  const identity: Record<string, string> = {};
  for (const [key, field] of [
    ["NAME", "name"],
    ["EMAIL", "email"],
  ]) {
    const value = spawnSync(tools.git, ["config", "--global", "--get", "user." + field], {
      cwd: "/",
      env: { HOME: homedir(), PATH: systemPath, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME },
      encoding: "utf8",
      timeout: 5000,
    });
    if (value.status === 0 && value.stdout.trim()) {
      identity["GIT_AUTHOR_" + key] = identity["GIT_COMMITTER_" + key] = value.stdout.trim();
    }
  }
  return {
    ...identity,
    PATH: join(runtime, "bin") + ":" + systemPath,
    HOME: join(runtime, "home"),
    TMPDIR: join(runtime, "tmp"),
    XDG_CACHE_HOME: join(runtime, "cache"),
    XDG_CONFIG_HOME: join(runtime, "config"),
    XDG_DATA_HOME: join(runtime, "data"),
    BUN_INSTALL_CACHE_DIR: join(runtime, "cache/bun"),
    npm_config_cache: join(runtime, "cache/npm"),
    npm_config_ignore_scripts: "true",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // Git's default templates copy sample hooks into a write-protected path.
    GIT_TEMPLATE_DIR: "",
    NODE_USE_ENV_PROXY: "1",
    LANG: process.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8",
    TERM: "xterm-256color",
  };
}

export function policy(root: string, tools: Record<string, string>, agentDir: string) {
  return {
    network: {
      allowedDomains: ["*"],
      deniedDomains: [],
      allowUnixSockets: [] as string[],
      allowLocalBinding: false,
      allowUnauthenticatedSocksProxy: false,
      allowAllUnixSockets: process.platform === "linux",
    },
    filesystem: {
      denyRead: [
        homedir(),
        agentDir,
        ...(process.platform === "linux" ? ["/home", "/run", "/var/run"] : ["/Users"]),
      ],
      allowRead: [root, ...Object.values(tools), dirname(createRequire(tools.npm).resolve("npm/package.json"))],
      allowWrite: [root],
      // Clone/init need repository-local config. Conventional .git/hooks stay protected.
      allowGitConfig: true,
      denyWrite: [
        join(root, ".pi-slice"),
        ...(present(join(root, ".pi")) ? [join(root, ".pi")] : []),
        "/tmp/claude",
        "/private/tmp/claude",
      ],
    },
    credentials: {
      envVars: ["JAVA_TOOL_OPTIONS", "GIT_CONFIG_COUNT"].map((name) => ({ name, mode: "deny" as const })),
    },
    enableWeakerNetworkIsolation: false,
    mandatoryDenySearchDepth: 5,
    ripgrep: { command: tools.rg },
    bwrapPath: tools.bwrap,
    socatPath: tools.socat,
  };
}

export function probeCode(env: Record<string, string>, nodeVersion: string, agentDir: string) {
  // Linux can replace hidden directories with empty tmpfs mounts.
  const agentStat = lstatSync(realpathSync(agentDir));
  return `const fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(process.env.HOME,${JSON.stringify(env.HOME)});assert.equal(process.env.TMPDIR,${JSON.stringify(env.TMPDIR)});
for(const name of Object.keys(process.env))if(/TOKEN|SECRET|API_KEY|^AWS_|^SSH_AUTH_SOCK$/.test(name))throw Error('Host credentials leaked: '+name);
const probe=process.env.TMPDIR+'/probe-'+process.pid;fs.writeFileSync(probe,'ok');assert.equal(fs.readFileSync(probe,'utf8'),'ok');fs.unlinkSync(probe);
try{const path=${JSON.stringify(agentDir)};fs.readdirSync(path);const s=fs.statSync(path);assert.notDeepEqual([s.dev,s.ino],${JSON.stringify([agentStat.dev, agentStat.ino])});}
catch(e){if(!['EPERM','EACCES','ENOENT'].includes(e.code))throw e;}
const {Database}=require('bun:sqlite');const db=new Database(':memory:');assert.equal(db.query('select 1 as v').get().v,1);db.close();
const node=Bun.spawnSync(['node','--no-warnings','-e',${JSON.stringify("const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');if(db.prepare('select 1 as v').get().v!==1)throw Error('SQLite');db.close();console.log(process.version)")}]);
assert.equal(node.exitCode,0);assert.equal(node.stdout.toString().trim(),${JSON.stringify("v" + nodeVersion)});console.log('PI_SLICE_OK');`;
}
