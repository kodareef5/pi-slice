import { realpathSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseArgs } from "@earendil-works/pi-coding-agent";
import { readWorkspace } from "../workspace.ts";
import { readProfile, saveProfile, type SliceProfile } from "./profile.ts";

const launchKey = "PI_SLICE_LAUNCH";

// The = form prevents Pi from consuming the prompt as --slice's value.
export function normalizeSliceFlag(args: string[]) {
  return args.map((arg, index) => arg === "--slice" &&
    parseArgs([...args.slice(0, index), "--slice=probe"]).unknownFlags.get("slice") === "probe"
      ? "--slice=true" : arg);
}

export function profileArgs(profile: SliceProfile, entry: string) {
  return ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve",
    ...(!profile.contextFiles ? ["--no-context-files", "--system-prompt", "", "--append-system-prompt", ""] : []),
    "-e", entry,
    ...profile.extensions.flatMap(path => ["-e", path]),
    ...profile.skills.flatMap(path => ["--skill", path]),
    ...profile.prompts.flatMap(path => ["--prompt-template", path])];
}

export function enterProfile(packageRoot: string): SliceProfile | undefined {
  const args = normalizeSliceFlag(process.argv.slice(2)), parsed = parseArgs(args);
  if (!parsed.unknownFlags.has("slice") || parsed.help || parsed.listModels !== undefined) return;
  if (parsed.unknownFlags.get("slice") !== "true" && parsed.unknownFlags.get("slice") !== true)
    throw Error("Use --slice as a boolean flag.");
  if (parsed.projectTrustOverride === true) throw Error("--slice cannot be combined with --approve. Add trusted resources with /slice config.");
  const root = realpathSync(process.cwd()), agent = realpathSync(getAgentDir());
  let id: string;
  try { id = readWorkspace(root).id; }
  catch { throw Error("--slice needs an initialized workspace. Start pi and run /slice init first."); }
  const identity = JSON.stringify({root, agent, id});
  const profile = readProfile(root, agent);
  if (process.env[launchKey]) {
    if (process.env[launchKey] !== identity || !parsed.noExtensions || !parsed.noSkills || !parsed.noPromptTemplates)
      throw Error("Slice launch belongs to another workspace. Exit and run pi --slice in this directory.");
    return profile;
  }
  if (typeof process.execve !== "function" || process.versions.bun || !process.argv[1])
    throw Error("Automatic Slice restart requires the Node.js Pi distribution with Node >=24.");
  saveProfile(root, agent, profile, true);
  // Extension factories may have run before this restart.
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env[launchKey] = identity;
  const next = [process.execPath, ...process.execArgv, process.argv[1],
    ...profileArgs(profile, join(packageRoot, "extension.ts")), ...args];
  process.execve(process.execPath, next, env);
  throw Error("Slice restart did not complete.");
}
