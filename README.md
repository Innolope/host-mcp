# @innolope/host-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server
that lets an MCP client — Claude Code, Claude Desktop, or any other MCP
host — inspect a remote Linux server over SSH. Covers Docker, host-level
diagnostics (CPU, memory, disk, processes, listening sockets, port
probes, systemd units, journal, file reads), and the two most common
reverse proxies (nginx, Caddy).

The client launches this server as a local subprocess. The server opens
an SSH connection to the remote host you configure, runs read-only
commands there, and returns sanitized results over stdio.

**Read-only by default.** No tool starts, stops, restarts, removes,
writes, or modifies anything. `exec_command` / `host_exec` are constrained
to a fixed allowlist of read-only utilities with strict input validation.

---

## Tools

Each group can be turned off via env so the MCP client never sees tools
it can't use. Host tools always register.

### Host (no Docker / no reverse proxy required) — always on

| Tool                    | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `host_stats`            | One-shot snapshot: `uname -a`, `uptime`, load average, CPU count, `free -h` (or `vm_stat` on macOS), `df -h`, `/etc/os-release`. |
| `host_processes`        | Top N processes sorted by CPU (default) or memory.                            |
| `host_listening_ports`  | `ss -tln` (or `netstat -ln` fallback). Filter by `proto` = tcp / udp / both.  |
| `host_check_port`       | Probe one or more TCP ports for reachability. Default `host='127.0.0.1'` (is the service listening?); pass `host` for an outbound connectivity check from the remote. |
| `host_systemd_status`   | `systemctl status <unit> --no-pager` for a single unit (validated).           |
| `host_journal`          | `journalctl --no-pager` tail. Optional `unit`, `since`, `priority`.           |
| `host_exec`             | Allowlisted read-only command on the host (not inside a container).           |
| `host_read_file`        | Read up to `READ_FILE_MAX_BYTES` (default 1 MiB) from a path. Restricted to `READ_FILE_ALLOWED_PREFIXES`; **disabled** when unset. |

### Docker (`DOCKER_ENABLED=true`, default)

| Tool                    | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `list_containers`       | `docker ps` (running + stopped by default) with id, name, image, status, uptime, ports. Accepts `--filter` values. |
| `container_logs`        | Recent stdout+stderr for a container. Optional `tail` (default 200, max 5000), `since`, `timestamps`. |
| `container_processes`   | `docker top` — processes running inside the container.                        |
| `container_stats`       | Single-shot `docker stats` (CPU %, memory, network IO, block IO, pids).       |
| `container_inspect`     | Full `docker inspect`. Env values matching `PASSWORD/SECRET/TOKEN/KEY/...` are redacted. |
| `exec_command`          | `docker exec` of an allowlisted read-only command. No shells, no pipes.       |
| `docker_compose_status` | `docker compose ps --format json` in a project directory.                     |
| `check_db_activity`     | Runs `mongosh` inside the configured Mongo container and reports per-collection estimated count, recent-created / recent-updated counts, and last-insert timestamp. |

### Nginx (`NGINX_ENABLED=true`, default)

| Tool            | What it does                                                                  |
| --------------- | ----------------------------------------------------------------------------- |
| `nginx_config`  | `nginx -T` — dumps the effective configuration AND validates it. Set `NGINX_BIN` to `sudo nginx` if the SSH user needs privileges. |

### Caddy (`CADDY_ENABLED=true`, default)

| Tool            | What it does                                                                  |
| --------------- | ----------------------------------------------------------------------------- |
| `caddy_config`  | GET `/config/` from Caddy's admin API (default `http://localhost:2019`). Returns the full active configuration as JSON. Override with `CADDY_ADMIN_URL`. |

A bare host with just SSH access? Set `DOCKER_ENABLED=false`,
`NGINX_ENABLED=false`, `CADDY_ENABLED=false` and you get 8 general
host-diagnostic tools and nothing else.

---

## Install

Requires Node.js 20+ on the machine that runs the MCP client (not the remote).

### Easiest: zero-install via npx (recommended)

Don't install anything. Point your MCP client at `npx -y @innolope/host-mcp`
(see [Wire it into an MCP client](#wire-it-into-an-mcp-client) below).
npx pulls the latest published version on each launch.

### Global install

```bash
npm install -g @innolope/host-mcp
```

Then use `host-mcp` as the command in your MCP client config.

### From source

```bash
git clone https://github.com/innolope/host-mcp.git
cd host-mcp
npm install
npm run build
cp .env.example .env
$EDITOR .env
```

The CLI entry point is `dist/index.js` (also exposed as the
`host-mcp` bin).

---

## Configure

All configuration is via environment variables. The server loads `.env`
from its working directory on startup, so you can either set the variables
in your shell, in the MCP client's `env` block, or in `.env`.

See [`.env.example`](.env.example) for the full list.

### Required

| Variable        | Purpose                                  |
| --------------- | ---------------------------------------- |
| `SSH_HOST`      | Remote host.                             |
| `SSH_USER`      | SSH user.                                |
| `SSH_KEY_PATH`  | Path to a private key file (preferred). |
| `SSH_PASSWORD`  | …or a password (use a key when you can). |

One of `SSH_KEY_PATH` / `SSH_PASSWORD` must be set.

### Optional

| Variable                    | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `SSH_PORT`                  | Defaults to 22.                                                      |
| `SSH_KEY_PASSPHRASE`        | If the private key is encrypted.                                     |
| `DOCKER_ENABLED`            | `true` / `false` — register the 8 Docker tools. Default `true`.      |
| `NGINX_ENABLED`             | `true` / `false` — register `nginx_config`. Default `true`.          |
| `CADDY_ENABLED`             | `true` / `false` — register `caddy_config`. Default `true`.          |
| `DOCKER_BIN`                | Defaults to `docker`. Set to `sudo docker` if needed.                |
| `NGINX_BIN`                 | Defaults to `nginx`. Set to `sudo nginx` if needed.                  |
| `CADDY_ADMIN_URL`           | Defaults to `http://localhost:2019`.                                 |
| `DEFAULT_COMPOSE_DIR`       | Used by `docker_compose_status` when `cwd` is omitted.               |
| `DEFAULT_COMPOSE_PROJECT`   | Used by `docker_compose_status` when `project` is omitted.           |
| `DEFAULT_CONTAINERS`        | Comma-separated hint surfaced in `list_containers`' description.     |
| `MONGO_CONTAINER`           | Container that has `mongosh` for `check_db_activity`.                |
| `MONGO_URI`                 | Mongo URI as resolved from inside that container.                    |
| `MONGO_DB`                  | Default database for `check_db_activity`.                            |
| `MONGO_COLLECTIONS`         | Comma-separated default collection list.                             |
| `EXEC_EXTRA_ALLOWED`        | Comma-separated commands to add to both `exec_command` and `host_exec` allowlists. |
| `READ_FILE_ALLOWED_PREFIXES`| Comma-separated absolute path prefixes `host_read_file` is allowed to read. **Unset = tool disabled.** |
| `READ_FILE_MAX_BYTES`       | Per-call byte cap for `host_read_file`. Default 1 MiB.               |

---

## Wire it into an MCP client

### Claude Code

Add the server to `~/.claude.json` (or a project-scoped `.mcp.json`).
The `npx` form needs no install — npm fetches `@innolope/host-mcp` on demand:

```json
{
  "mcpServers": {
    "host-mcp": {
      "command": "npx",
      "args": ["-y", "@innolope/host-mcp"],
      "env": {
        "SSH_HOST": "prod.example.com",
        "SSH_USER": "deploy",
        "SSH_KEY_PATH": "/Users/you/.ssh/id_ed25519",

        "DOCKER_BIN": "docker",
        "DEFAULT_COMPOSE_DIR": "/srv/app",
        "DEFAULT_CONTAINERS": "app,worker,mongo",

        "MONGO_CONTAINER": "mongo",
        "MONGO_URI": "mongodb://localhost:27017",
        "MONGO_DB": "app",
        "MONGO_COLLECTIONS": "users,events,jobs",

        "NGINX_BIN": "sudo nginx",
        "CADDY_ADMIN_URL": "http://localhost:2019",
        "READ_FILE_ALLOWED_PREFIXES": "/etc/nginx,/etc/caddy,/var/log,/etc/systemd"
      }
    }
  }
}
```

Drop the Docker / Mongo / nginx / Caddy blocks if the remote doesn't run
those, and set `DOCKER_ENABLED=false` / `NGINX_ENABLED=false` /
`CADDY_ENABLED=false` accordingly so the unused tools don't show up in
`tools/list`.

A bare host-only config (no Docker, no nginx, no Caddy):

```json
{
  "mcpServers": {
    "host-mcp": {
      "command": "npx",
      "args": ["-y", "@innolope/host-mcp"],
      "env": {
        "SSH_HOST": "box.example.com",
        "SSH_USER": "deploy",
        "SSH_KEY_PATH": "/Users/you/.ssh/id_ed25519",
        "DOCKER_ENABLED": "false",
        "NGINX_ENABLED": "false",
        "CADDY_ENABLED": "false",
        "READ_FILE_ALLOWED_PREFIXES": "/var/log,/etc"
      }
    }
  }
}
```

Other launch styles:

```jsonc
// Global install (faster cold-start than npx, but you have to upgrade manually)
"command": "host-mcp",
"args": []

// From a local clone (good for development)
"command": "node",
"args": ["/absolute/path/to/host-mcp/dist/index.js"]
```

Restart Claude Code and use `/mcp` to confirm the server is connected.

### Claude Desktop

Add the same block to `claude_desktop_config.json` (location varies by
OS — see the [Claude Desktop docs](https://modelcontextprotocol.io/quickstart/user)).

### Other MCP clients

Any MCP client that supports stdio transport works — launch
`npx -y @innolope/host-mcp` (or `node dist/index.js` from source) and
pass env vars.

---

## Smoke test (without an MCP client)

```bash
export SSH_HOST=localhost SSH_USER=test SSH_PASSWORD=x   # placeholders, just to pass startup
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

You should see an `initialize` response and a `tools/list` response with
every tool from the groups you enabled. The SSH connection is lazy, so it
won't actually be established until a tool is called.

---

## Security model

- **No interactive shells.** `exec_command` / `host_exec` run a single
  binary with positional args. The metacharacters `` ` $ \ ; | & > < ``
  (plus newlines and NULs) are rejected. There is no `bash -c`, no pipes,
  no redirects, no command chaining.
- **Command allowlist.** Only a fixed read-only set is permitted (`ls`,
  `cat`, `head`, `tail`, `ps`, `df`, `du`, `env`, `grep`, `find`, `curl`,
  `wget`, `dig`, `ss`, …). Extend deliberately via `EXEC_EXTRA_ALLOWED`.
- **File-read allowlist.** `host_read_file` is **off by default**. To
  enable it, set `READ_FILE_ALLOWED_PREFIXES` to the path prefixes you
  consent to expose. Paths with `..` segments are rejected.
- **Validated identifiers.** Container names, compose projects, database
  names, collection names, systemd unit names, and hostnames are matched
  against strict regexes before being shell-quoted.
- **Validated ports.** Port numbers must be integers 1..65535.
- **Secret redaction.** `container_inspect` replaces env values whose key
  matches `PASSWORD/SECRET/TOKEN/KEY/CREDENTIAL/PRIVATE/AUTH/SESSION`
  with `***redacted***`.
- **Output cap.** Each of stdout and stderr is capped at ~1 MiB per call.
  Truncation is marked inline.
- **Per-call timeout.** Each command has a 15–60 s ceiling.
- **No credential leakage.** SSH credentials live in env / a key file and
  never appear in tool output.

What the server **does not** do:

- It does not start, stop, restart, kill, rm, or pull containers.
- It does not write to MongoDB.
- It does not modify files on the remote host.
- It does not run `sudo` implicitly — if you need privileged commands
  (e.g. `nginx -T` on Debian), grant the SSH user a narrow sudoers
  entry and set `NGINX_BIN=sudo nginx` / `DOCKER_BIN=sudo docker`.

If you need a write operation, add it as a separate tool with an explicit
name. Don't broaden the allowlists.

---

## Development

```bash
npm run dev      # tsc --watch
npm run build    # one-shot compile to dist/
npm start        # run the compiled server
```

Source layout:

- `src/config.ts`   — env loading and validation.
- `src/ssh.ts`      — lazy-connecting ssh2 client with output caps and timeouts.
- `src/security.ts` — input validators, shell quoting, exec allowlist.
- `src/result.ts`   — MCP `ToolText` helpers.
- `src/docker.ts`   — one async function per Docker tool.
- `src/host.ts`     — one async function per host / nginx / Caddy tool.
- `src/index.ts`    — registers the tools on an `McpServer` over stdio.

---

## Publishing to npm

The package is shaped to publish as `@innolope/host-mcp` under the
`@innolope` npm scope. The first time you publish, do it manually; after
that a tag push runs the release workflow automatically.

### Before the first publish

1. Create the `@innolope` npm org once (free for public packages):

   ```bash
   npm login
   npm org create innolope
   ```

   Or via the web UI at https://www.npmjs.com/org/create.

2. Inspect the tarball locally:

   ```bash
   npm pack --dry-run
   ```

   You should see only `dist/`, `README.md`, `LICENSE`, `.env.example`,
   and `package.json` — no `node_modules`, no `src/`, no `.git*`.

### Manual publish (first time)

```bash
npm publish --access public
```

`--access public` is required for scoped packages — without it npm
assumes private. The `prepublishOnly` script cleans and rebuilds for you;
sourcemaps are included for debuggability.

Once published, anyone can run it with:

```bash
npx -y @innolope/host-mcp     # zero-install
# or
npm install -g @innolope/host-mcp
```

### Subsequent releases (automated)

The `.github/workflows/release.yml` workflow publishes on tag push.

1. Add an npm automation token (`Settings → Access Tokens → Automation`,
   scoped to the `@innolope` org) as the `NPM_TOKEN` repo secret on
   GitHub.
2. Bump the version and tag:

   ```bash
   npm version patch    # or minor / major. Edits package.json + creates a tag.
   git push --follow-tags
   ```

The workflow verifies that the tag matches `package.json`, runs
`npm ci && npm run build`, and publishes with `--provenance` (npm shows a
"Built and signed on GitHub Actions" badge on the package page).

---

## Contributing

Issues and PRs welcome. Please:

- Keep new tools read-only by default, or gate writes behind an explicit
  opt-in env var.
- Add input validation in `src/security.ts` for any new identifier shape.
- Don't widen the `exec_command` / `host_exec` allowlist for convenience —
  users can set `EXEC_EXTRA_ALLOWED` themselves.

---

## License

[MIT](./LICENSE).
