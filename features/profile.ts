import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { privateDir, readWorkspace } from "../workspace.ts";

export type SliceProfile = {
  extensions: string[];
  skills: string[];
  prompts: string[];
  tools: string[];
  contextFiles: boolean;
  mcpServers: Record<string, McpServerConfig>;
};

export function parseProfile(value: unknown): SliceProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Slice configuration must be a JSON object.");
  const data = value as Record<string, unknown>;
  const keys = ["extensions", "skills", "prompts", "tools", "contextFiles", "mcpServers"];
  for (const key of Object.keys(data)) if (!keys.includes(key)) throw Error(`Unknown Slice setting: ${key}.`);
  const strings = (key: string) => {
    const values = data[key] ?? [];
    if (!Array.isArray(values) || values.some(v => typeof v !== "string" || !v.trim() || v.includes("\0")))
      throw Error(`Slice ${key} must be an array of nonempty strings.`);
    return values as string[];
  };
  if (data.contextFiles !== undefined && typeof data.contextFiles !== "boolean") throw Error("contextFiles must be true or false.");
  const servers = data.mcpServers ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw Error("mcpServers must be an object.");
  const names = new Set<string>();
  for (const [name, config] of Object.entries(servers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || names.has(name.replaceAll("-", "_"))) throw Error(`Invalid or conflicting MCP server name: ${name}.`);
    names.add(name.replaceAll("-", "_"));
    if (!config || typeof config !== "object" || Array.isArray(config) ||
        !(typeof config.command === "string" || typeof config.url === "string"))
      throw Error(`MCP server ${name} needs a command or URL.`);
  }
  return { extensions: strings("extensions"), skills: strings("skills"), prompts: strings("prompts"),
    tools: strings("tools"), contextFiles: data.contextFiles === true, mcpServers: servers as Record<string, McpServerConfig> };
}

export function profilePath(root: string, agent: string) {
  // A copied project marker must not opt another directory into trusted add-ons.
  const key = createHash("sha256").update(root + "\0" + readWorkspace(root).id).digest("hex");
  return join(agent, "pi-slice", "profiles", key + ".json");
}

export function readProfile(root: string, agent: string): SliceProfile {
  const path = profilePath(root, agent), stat = lstatSync(path, {throwIfNoEntry: false});
  if (!stat) return parseProfile({});
  if (!stat.isFile()) throw Error("Slice configuration must be a plain file.");
  return parseProfile(JSON.parse(readFileSync(path, "utf8")));
}

export function saveProfile(root: string, agent: string, profile: SliceProfile, createOnly = false) {
  const value = parseProfile(profile), path = profilePath(root, agent);
  privateDir(agent, "profiles");
  if (createOnly) {
    try { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {flag: "wx", mode: 0o600}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; readProfile(root, agent); }
    return path;
  }
  const temp = path + "." + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {flag: "wx", mode: 0o600});
    renameSync(temp, path);
  } finally { rmSync(temp, {force: true}); }
  return path;
}
