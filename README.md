# Pi Slice

Opt-in project isolation and a minimal configuration for Pi. Run `/slice init`
once, then start `pi --slice`. Other folders keep ordinary Pi behavior. Pi keeps
its normal accounts and session history; isolation applies to the project's file
and shell tools.

Includes background apps and encrypted project snapshots. This is a Pi extension
installed through `pi install`.

## Quickstart

Needs the Node.js distribution of Pi >=1.4.0, Node >=24, Bun >=1.4.3, npm, git and rg; Linux also needs bwrap,
socat and flock. Export/import needs age. Sandbox-runtime is pinned to 0.0.78.

```sh
pi install git:github.com/kodareef5/pi-slice
mkdir -p ~/my-project && cd ~/my-project
git init # optional; on macOS, initialize the workspace-root repository here
pi
```

The repository is private; Git must be authenticated to an account with access.
Run `/slice init`; Pi exits after setup. Then:

```sh
pi --slice           # minimal configuration and sandboxed tools
pi --slice -c        # continue the latest session
pi --slice -r        # choose a session to resume
```

`--slice` is registered by the extension. It automatically restarts Pi before the
working session opens, using Pi's native resource-loading flags. No shell alias,
wrapper or separate launcher is needed. Update an existing installation with
`pi update git:github.com/kodareef5/pi-slice`.

Starting plain `pi` in an initialized folder still sandboxes its file and shell
tools. A notice and status indicator explain that your normal Pi configuration is
loaded, and other extensions can operate outside the sandbox.

```text
/slice                                 # status
/slice doctor                          # requirements and diagnostics
/slice config                          # edit this workspace's minimal configuration
/slice run bun run server.ts            # persistent localhost preview
/slice logs                            # service output
/slice stop [service-id]                # stop current or saved service
/slice services                        # list services, including deleted workspaces
/slice export ../project.slice          # encrypted workspace assets
/slice import ../project.slice ../copy  # new directory; unmarked Pi works too
```

## Workspace configuration

By default, `pi --slice` loads only Slice: no other extensions, MCP connections,
skills, prompt templates, custom themes or context files. This also suppresses
inherited `SYSTEM.md` and `APPEND_SYSTEM.md`. Account credentials, model selection
and native session storage stay with your normal Pi installation. Resuming a
session keeps its existing conversation; use a new session for a fresh context.

Use `/slice config` to edit the workspace's JSON configuration, then restart
`pi --slice`. It starts with:

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

- `extensions`: trusted extension files, directories or Pi package sources.
- `skills`: selected skill files or directories. A selected `SKILL.md` grants the
  sandbox read access to its skill directory and bundled assets; a loose Markdown
  file grants access only to that file. Files outside the project stay read-only.
- `prompts`: selected prompt-template files or directories.
- `tools`: names of additional tools the model may call. Loading an extension does
  not automatically allow all its tools. Slice's file, shell and service tools
  are always available.
- `contextFiles`: opt back into Pi's normal context-file and system-prompt loading.
- `mcpServers`: the native Pi MCP server configuration shape. Only these servers
  are connected by Slice; global and project `mcp.json` files are not imported.

For example, add a server with:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/absolute/path/to/my-mcp-server.js"]
    }
  }
}
```

Omitted fields keep their defaults. MCP tools default to direct exposure and do not
need entries in `tools`. `/mcp` manages connections and login; persist server changes
with `/slice config`. Advanced `codemode` or `deferred` exposure also needs the
corresponding extension and tool enabled. `--no-mcp` disables configured servers
for a single launch. Explicit Pi CLI resource arguments remain available as
temporary additions. Relative resource paths resolve from the workspace.

Configuration lives in private Pi state, keyed by directory and workspace ID.
Sandboxed tools cannot edit it, copying the project does not copy its permissions,
and snapshots do not include it. In RPC mode `/slice config` reports the file path
for host-side editing. Global Pi settings are unchanged.

Added extensions and MCP servers are trusted host integrations with their own
permissions. The automatic restart produces a clean working session; Pi may run
normal extension factories during the initial launch before Slice takes control.

## Apps and snapshots

Or ask Pi: **“Host a simple Bun dashboard and keep it running after I exit.”**
The `slice_service` tool configures one service per workspace; previews use
`Bun.serve({ unix: process.env.PI_SLICE_SOCKET, fetch })`. Linux needs a systemd user
manager; macOS uses launchd. `/slice doctor` checks backends and preview socket paths,
which must fit within 100 bytes including the Pi state path.
Services survive Pi/terminal exit, follow OS logout policy, and do not restart after
reboot. They read the project and write only to private runtime; normal tools edit
the project. Use `/slice run --background <command>` for a worker without a preview.

Snapshots include Git and project secrets, exclude runtime/dependencies, and assign a
fresh workspace ID on import. They do not collect Pi accounts or conversations.

Git clones and `git init <subdirectory>` work inside the workspace with standard
`.git` directories. Repository-local Git configuration is writable. Default Git
templates are skipped so cloning does not try to copy sample hooks into protected
paths. Git still uses an isolated HOME and ignores host system/global config;
only the host's author name and email are carried over.

Homes and Pi state are hidden; other host paths, including `/tmp`, remain readable.
Tool writes stay in the project; service runtime is private Pi state, never exported.
Proxied internet includes local/LAN services. Linux hides
`/run` and `/var/run`, but permits sockets on other visible paths. Pi and global
extensions remain trusted host code; running generated files on the host bypasses
this boundary. Writes to conventional `.git/hooks` paths remain blocked. On macOS,
the workspace-root `.git` directory is also pinned, so `git init` at that root
still needs the host terminal. Cloning and initializing repositories in
subdirectories work inside Pi, as do add/commit in existing repositories.
The restored extension is tested on macOS arm64
with Pi 1.4.0. The original extension was also tested on Ubuntu; the Pi 1.4 update
has not yet been revalidated on Linux. WSL is unverified.

## Development and packaging

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
bun test/smoke-terminal.mjs
pi install "$PWD"
```

Tests use disposable projects, fixture accounts, local simulated inference and a
local MCP server, without paid model calls. The package
declares `pi.extensions` and the `pi-package` keyword for Pi's package discovery.
Pi supplies its SDK and AI package at runtime; these are peer dependencies, with
Pi 1.4.0 pinned only for development. It can be installed from Git now and published
to npm later under the same name.

## Origin and compatibility

Pi Slice continues the original [pi-work extension at d9235de](https://github.com/kodareef5/pi-work/tree/d9235ded2882764218de6766f839f23aeb7d65e8).
The separate [Pi Work service](https://github.com/kodareef5/pi-work) manages browser
and terminal workspaces through `piw`.

Slice uses `/slice` commands, a `.pi-slice` project marker, private `pi-slice`
extension state, and `.slice` snapshots. Scratch files live in `.pi-runtime`.
There is no `/work` alias or automatic migration of old Pi Work projects or spaces.
Remove the original extension before using Slice, then run `/slice init` in each
project you want to isolate. Other projects keep ordinary Pi behavior.
