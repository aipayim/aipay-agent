# aipay-agent — public distribution

This repository is the **distribution point** for the AIPAY agent surface (a local
stdio MCP server + CLI). The application itself lives at <https://aipay.im>; the
implementation is not public. Nothing in this repository can move funds on its own.

## What you get

- `aipay-agent-<version>.tgz` — the sanitized runtime: `agent/` (MCP server, CLI,
  tool registry) and the `src/lib` closure it imports. Installed from
  <https://aipay.im/downloads/> and verified against `CHECKSUMS.txt`.
- `install.sh` — downloads, **verifies the sha256**, extracts and installs the
  runtime dependencies.
- `manifest.json` — machine-readable: version, tarball URL, sha256, size, every
  shipped file with its hash, and the allow/deny rules used to build it.
- `ALLOWLIST.txt` / `DENYLIST.txt` — the same rules in human-readable form.
- `mcp.example.json` — an MCP client entry you can copy.

## Install (Node.js >= 22.18)

```bash
curl -fsSLO https://raw.githubusercontent.com/aipayim/aipay-agent/main/install.sh
bash install.sh                     # or: AIPAY_AGENT_VERSION=<v> bash install.sh
```

Then:

```bash
export AIPAY_AGENT_HOME="$HOME/.aipay/agent"
export AIPAY_AGENT_PASSPHRASE='a strong passphrase'
node "$HOME/.aipay/agent-dist/package/agent/cli.mjs" keystore init --generate
node "$HOME/.aipay/agent-dist/package/agent/cli.mjs" address
```

Register the MCP server (stdio) with your client — see `mcp.example.json`:

```json
{
  "mcpServers": {
    "aipay": {
      "command": "node",
      "args": ["/home/you/.aipay/agent-dist/package/agent/mcp-server.mjs"],
      "env": { "AIPAY_AGENT_HOME": "/home/you/.aipay/agent", "AIPAY_AGENT_PASSPHRASE": "…" }
    }
  }
}
```

## What is *not* here

- No keys, mnemonic, keystore, `approval.json`, state file, `.env`, CI config,
  internal docs, contracts or web app code.
- No hosted API. The tools run locally inside your process; `aipay.im` is not an
  API endpoint. If a page tells you otherwise, it is wrong.

## Allowlist / denylist

A file is shipped only if it is reachable from `agent/cli.ts` or
`agent/mcp-server.ts` **and** lives under `agent/` or `src/lib/`. Everything else
is refused at build time (enforced in the private repository's build script, which
also scans every file for credential shapes and fails the release on a hit). The
exact file list and hashes are in `manifest.json`.

## Security

- The agent's key is the agent's: it is created locally and never leaves the
  machine. The human's wallet key is separate.
- Approving an escalated payment, or issuing/delegating a capability, needs the
  human's approval key on the operator side; this bundle contains no such key.
- Report a problem privately to the operator of the AIPAY deployment you use.
