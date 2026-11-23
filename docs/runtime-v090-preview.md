# Runtime v0.9.0 limited Preview

English | [简体中文](zh-CN/runtime-v090-preview.md) · [Documentation index](README.md)

Use an Apple silicon Mac and Node 24.14.0 to try Project Lifecycle YAML editing, graph preview, and read-only monitoring in a fresh local workspace. The installer uses a per-user macOS launchd service bound to `127.0.0.1`. It runs independently of Codex and external credentials. [HTTP, MCP and CLI reference](runtime-v090-preview-api.md)

## Verify and unpack

Download these six release attachments into a private directory. GitHub also lists two automatically generated source archives. [Runtime v0.9.0 GitHub pre-release](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.9.0)

| File | Purpose |
| --- | --- |
| `evopilot-runtime-0.9.0-darwin-arm64.tar.gz` | Standalone installation archive with runtime dependencies |
| `distribution-manifest.json` | Installer inventory binding the archive and extracted package |
| `SHA256SUMS` | SHA-256 checksums of the other five attachments |
| `source-revision.txt` | Source commit associated with the distribution |
| `runtime-dependency-lock.json` | Runtime dependency inventory |
| `evopilot-next-runtime-0.9.0.tgz` | npm-format package artifact |

Run these commands from the private download directory. Proceed only after all five checksums pass and the source revision matches `81777f07e856ba5a3615b373de5f6709dc3b3e9b`.

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
mkdir -m 700 unpacked
tar -xzf evopilot-runtime-0.9.0-darwin-arm64.tar.gz -C unpacked
chmod 600 distribution-manifest.json evopilot-runtime-0.9.0-darwin-arm64.tar.gz
```

## Run the service

Use the verified standalone archive for the installation. Resolve the Node executable path, confirm the version with `node --version`, and obtain its SHA-256 digest with `shasum -a 256`. Use the same Node executable for the commands below.

Create a JSON installation plan in a private regular file with mode `0600`. Use canonical absolute paths without symlinks. Existing private material must belong to the current user. The installation directory is created with mode `0700` if absent.

| Field | Value |
| --- | --- |
| `schema` | `runtime-install-plan/v1` |
| `root` | New or empty private installation directory, separate from the download |
| `distribution` | Set `packageRoot` to the extracted `unpacked/package`. Set `manifestRef` and `archiveRef` to the downloaded files and `manifestDigest` and `archiveDigest` to their lowercase SHA-256 hex digests. |
| `nodeExecutable`, `nodeSha256` | Resolved Node 24.14.0 executable and its lowercase SHA-256 hex digest |
| `workspaceId`, `projectId`, `principalId` | Local IDs such as `preview`, `demo`, and `preview-editor` |
| `role` | `editor` receives `read` and `draft.write`. `reader` receives `read`. |
| `credentialExpiresAt`, `port` | An ISO 8601 UTC timestamp within the next 30 days and an available port from 1024 to 65535 |
| `integrationsRef`, `codex` | Both `null` |

Replace the example paths with the plan's real location and installation root. Keep the same plan for subsequent operations on this installation.

```sh
node unpacked/package/dist/installation/installer.js stage --plan-ref /absolute/path/install-plan.json
node unpacked/package/dist/installation/installer.js start --plan-ref /absolute/path/install-plan.json
node unpacked/package/dist/installation/installer.js inspect --plan-ref /absolute/path/install-plan.json
node /absolute/install-root/package/dist/server/cli.js browser-code --connection-ref /absolute/install-root/connection.json
```

`stage` should return `STAGED`. After `start`, check that `inspect` returns `service.running: true`, `service.identity.version: "0.9.0"`, and `service.identity.distributionProfile: "limited-preview"`, with the expected workspace and project. The `start` response uses the shared installer phase `AWAITING_HOST_VERIFICATION`. The limited plan uses `codex: null` and `inspect` reports `hostRegistered: false`.

## Validate and save a draft

Open `http://127.0.0.1:<port>/lifecycle` and enter the code printed by `browser-code` in the page. It expires after at most five minutes and works once. Keep the code out of URLs and logs. On service restart or session expiry, generate a fresh code.

With an `editor` plan, paste the following in the initially empty YAML editor. Replace `demo` with the plan's `projectId`.

```yaml
# Isolated Preview draft
projectId: demo
```

Choose **校验与差异预览** to see the missing-field diagnostics. This short example is deliberately incomplete, so the graph shows a draft preview based on the Publisher Base. A structurally valid draft uses its compiled graph. Choose **保存草稿** and return to the page to confirm the YAML and comment were retained. A reader can view saved drafts and use validation through the API. [Preview API](runtime-v090-preview-api.md)

Open `/monitor` for the project snapshot and connection status. The instance list starts empty and the profile has no operation to create an instance. Saving a draft produces a project event that the monitor can observe.

## Stop, restart and recover

```sh
node unpacked/package/dist/installation/installer.js stop --plan-ref /absolute/path/install-plan.json
```

Stop retains the installation and saved drafts. Start with the same plan, inspect the live service, and obtain a new browser code to reopen them. If startup is interrupted, inspect before retrying and keep the records in `installation-audit/`. After a draft save times out, use the Dashboard's receipt lookup or read the original request receipt before submitting another save. After a revision conflict, preserve the local YAML and reread the current server revision before reconciling edits.

The profile permits isolated draft work and observation. Activation, instance creation, business execution, external provider integration, remote CI, release authorization and publication, workspace migration, and Codex Desktop registration are disabled.

## Release verification

Source CI passed 1,716 of 1,716 tests at the release commit. The limited acceptance checks LP01–LP08 passed, including download of all six attachments without GitHub credentials, checksum verification, and reinstall and service readback from the downloaded archive in a fresh isolated root. Full v0.9 acceptance and desktop verification are deferred. [Source CI](https://github.com/yeliang-wang/evopilot-runtime/actions/runs/45109539220) · [Limited Preview acceptance criteria](https://github.com/yeliang-wang/evopilot-runtime/blob/v0.9.0/docs/acceptance-v090.md#limited-public-preview-acceptance)
