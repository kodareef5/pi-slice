# Slice

A Pi extension for project isolation and a minimal configuration.

- File and shell tools run in an OS sandbox: `sandbox-exec` on macOS,
  bubblewrap on Linux, through [sandbox-runtime](https://github.com/anthropics/sandbox-runtime).
- `pi --slice` loads only Slice and the skills, extensions and MCP servers you select.

Pi keeps your normal accounts and sessions. Tool writes stay in the workspace;
homes and Pi state are hidden. Other host paths are generally readable. Network
access, including local services, goes through proxies. Pi, extensions and MCP
servers remain trusted host code.

## Start

Requires Pi ≥1.4 (Node distribution), Node 24 LTS or newer, Bun ≥1.4.3, npm, Git and ripgrep.
Linux also needs `bwrap`, `socat` and `flock`.

Bun runs Slice's sandbox helpers and is installed separately:

```sh
npm install -g bun
pi install git:github.com/kodareef5/pi-slice
cd /path/to/project
pi
```

Run `/slice init`. Pi exits after setup. Then:

```sh
pi --slice
```

Use `-c` to continue or `-r` to choose a session. Plain `pi` in an initialized
folder keeps the tool sandbox and loads your usual configuration.

Git cloning works normally. On macOS, run `git init` from the host terminal if
you want a repository at the workspace root; initializing subdirectories works
inside Slice.

## Choose what loads

Add a skill for one session:

```sh
pi --slice --skill /path/to/skill
```

Use `/slice config` to save workspace settings, then restart:

```json
{
  "extensions": [],
  "skills": [],
  "prompts": [],
  "tools": [],
  "contextFiles": false,
  "mcpServers": {}
}
```

Resource paths are relative to the workspace. `tools` enables extra extension
tools; MCP uses Pi's native server configuration. `contextFiles` restores normal
context and system-prompt loading. Settings stay in Pi's private state.

## Commands

```text
/slice                                 status
/slice doctor                          diagnostics
/slice run <command>                   start a preview
/slice run --background <command>      start a worker
/slice logs                            service output
/slice stop [service-id]                stop a service
/slice services                        saved services
/slice export ../project.slice         encrypted snapshot
/slice import ../project.slice ../copy restore into a new directory
```

Previews listen on `PI_SLICE_SOCKET`, for example
`Bun.serve({ unix: process.env.PI_SLICE_SOCKET, fetch })`. Services use launchd on
macOS or a systemd user manager on Linux. They survive Pi exiting, read the project
and write to private runtime storage.

Snapshots need `age`. They include project secrets and Git, exclude dependencies
and runtime files, and restore with a fresh workspace identity.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
bun test/smoke-terminal.mjs
```

Tests use disposable workspaces and no paid model calls. Current integration is
verified on macOS arm64; Linux needs revalidation after the Pi 1.4 update.

[MIT](LICENSE).
