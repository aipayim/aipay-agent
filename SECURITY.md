# Security

This repository ships a runtime, not keys. It contains no wallet, mnemonic,
approval key, state file or deployment credential.

The build refuses to publish a file that is not reachable from the agent
entry points, that lives outside `agent/` or `src/lib/`, or that matches a
credential shape. `manifest.json` lists every file with its sha256 so a
release can be diffed.

Report problems privately to the operator of the AIPAY deployment you use.
