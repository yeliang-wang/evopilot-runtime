# Runtime v0.9.0 limited Preview

Use an Apple silicon Mac and Node 24.14.0 to try Project Lifecycle YAML editing, graph preview, and read-only monitoring in a fresh local workspace. The service runs without Codex or external credentials.

## Verify and unpack

Download all six assets from the [Runtime v0.9.0 GitHub pre-release](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.9.0). Run these commands in the private download directory.

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
mkdir -m 700 unpacked
tar -xzf evopilot-runtime-0.9.0-darwin-arm64.tar.gz -C unpacked
chmod 600 distribution-manifest.json evopilot-runtime-0.9.0-darwin-arm64.tar.gz
```

All checksums should pass. The source revision is `81777f07e856ba5a3615b373de5f6709dc3b3e9b`. The standalone archive includes its dependencies.

## Run the service

Create a JSON installation plan in a private file with mode `0600`. Use canonical absolute paths without symlinks.

| Field | Value |
| --- | --- |
| `schema` | `runtime-install-plan/v1` |
| `root` | New or empty private installation directory |
| `distribution` | Set `packageRoot` to the extracted `unpacked/package`. Set `manifestRef` and `archiveRef` to the downloaded files and `manifestDigest` and `archiveDigest` to their SHA-256 hex digests. |
| `nodeExecutable`, `nodeSha256` | Resolved path to Node 24.14.0 and its SHA-256 hex digest |
| `workspaceId`, `projectId`, `principalId` | Local IDs such as `preview`, `demo`, and `preview-editor` |
| `role` | `editor` to save drafts or `reader` for read-only access |
| `credentialExpiresAt`, `port` | A future ISO 8601 UTC timestamp and an available port from 1024 to 65535 |
| `integrationsRef`, `codex` | Both `null` |

Replace the example paths with the plan's real location and installation root.

```sh
node unpacked/package/dist/installation/installer.js stage --plan-ref /absolute/path/install-plan.json
node unpacked/package/dist/installation/installer.js start --plan-ref /absolute/path/install-plan.json
node unpacked/package/dist/installation/installer.js inspect --plan-ref /absolute/path/install-plan.json
node /absolute/install-root/package/dist/server/cli.js browser-code --connection-ref /absolute/install-root/connection.json
```

Check that `inspect` reports the running `0.9.0` service with distribution profile `limited-preview`. At `http://127.0.0.1:<port>/lifecycle`, enter the one-use code, validate YAML, and view the graph. With `editor`, save and reopen the draft. Open `/monitor` to see read-only status. A fresh installation has an empty instance list.

Use `node unpacked/package/dist/installation/installer.js stop --plan-ref /absolute/path/install-plan.json` to stop the service while retaining the local installation and state. The limited profile disables activation, business execution, external provider integration, remote CI, migration, and Codex Desktop registration. [Acceptance criteria](https://github.com/yeliang-wang/evopilot-runtime/blob/v0.9.0/docs/acceptance-v090.md#limited-public-preview-acceptance)
