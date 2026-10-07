# pi-work

Constrained, portable workspaces for ordinary Pi. Sandboxed tools, background apps
and encrypted project snapshots; Pi keeps its normal auth and sessions.

## Quickstart

Needs Pi 1.0.4, Node >=24, Bun >=1.4.2, npm, git and rg; Linux also needs bwrap,
socat and flock. Export/import needs age. Sandbox-runtime is pinned to 0.0.78.

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.4
git clone https://github.com/kodareef5/pi-work.git ~/pi-work
cd ~/pi-work && npm ci --ignore-scripts
pi install "$PWD"
mkdir -p ~/my-project && cd ~/my-project
pi
```

Run `/work init`; Pi exits after setup. Start `pi` again. Use `pi -c` / `pi -r` normally.

```text
/work                                # status
/work doctor                         # requirements and diagnostics
/work run bun run server.ts          # persistent localhost preview
/work logs                           # service output
/work stop [service-id]              # stop current or saved service
/work services                       # list services, including deleted workspaces
/work export ../project.piw          # encrypted workspace assets
/work import ../project.piw ../copy  # new directory; unmarked Pi works too
```

Or ask Pi: **“Host a simple Bun dashboard and keep it running after I exit.”**
The `work_service` tool configures one service per workspace; previews use
`Bun.serve({ unix: process.env.PI_WORK_SOCKET, fetch })`. Linux needs a systemd user
manager; macOS uses launchd. `/work doctor` checks backends and preview socket paths,
which must fit within 100 bytes including the Pi state path.
Services survive Pi/terminal exit, follow OS logout policy, and do not restart after
reboot. They read the project and write only to private runtime; normal tools edit
the project. Use `/work run --background <command>` for a worker without a preview.

Snapshots include Git and project secrets, exclude runtime/dependencies, and assign a
fresh workspace ID on import. They do not collect Pi accounts or conversations.

Homes and Pi state are hidden; other host paths, including `/tmp`, remain readable.
Tool writes stay in the project; service runtime is private Pi state, never exported.
Proxied internet includes local/LAN services. Linux hides
`/run` and `/var/run`, but permits sockets on other visible paths. Pi and global
extensions remain trusted host code; running generated files on the host bypasses
this boundary. Ubuntu tested; macOS and WSL unverified.
