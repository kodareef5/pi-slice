# Pi Slice

Opt-in project isolation for Pi. Run `pi`, then `/slice init` to sandbox a project.
Other folders keep ordinary Pi behavior. Pi keeps its normal accounts and session
history; isolation applies to the project's file and shell tools.

Includes background apps and encrypted project snapshots. This is a Pi extension
installed through `pi install`.

## Quickstart

Needs Pi >=1.4.0, Node >=24, Bun >=1.4.3, npm, git and rg; Linux also needs bwrap,
socat and flock. Export/import needs age. Sandbox-runtime is pinned to 0.0.78.

```sh
pi install git:github.com/kodareef5/pi-slice
mkdir -p ~/my-project && cd ~/my-project
git init # optional; on macOS, initialize Git here before entering Pi
pi
```

The repository is private; Git must be authenticated to an account with access.
Run `/slice init`; Pi exits after setup. Start `pi` again. Use `pi -c` / `pi -r` normally.

```text
/slice                                 # status
/slice doctor                          # requirements and diagnostics
/slice run bun run server.ts            # persistent localhost preview
/slice logs                            # service output
/slice stop [service-id]                # stop current or saved service
/slice services                        # list services, including deleted workspaces
/slice export ../project.slice          # encrypted workspace assets
/slice import ../project.slice ../copy  # new directory; unmarked Pi works too
```

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

Homes and Pi state are hidden; other host paths, including `/tmp`, remain readable.
Tool writes stay in the project; service runtime is private Pi state, never exported.
Proxied internet includes local/LAN services. Linux hides
`/run` and `/var/run`, but permits sockets on other visible paths. Pi and global
extensions remain trusted host code; running generated files on the host bypasses
this boundary. macOS protects Git hooks/config and their parent paths, so new Git
repositories must be initialized from the host terminal. Git add/commit work inside
Pi once the repository exists. The restored extension is tested on macOS arm64
with Pi 1.4.0. The original extension was also tested on Ubuntu; the Pi 1.4 update
has not yet been revalidated on Linux. WSL is unverified.

## Development and packaging

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
pi install "$PWD"
```

Tests use disposable projects and fixture accounts without model calls. The package
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
