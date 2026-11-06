#!/usr/bin/env bash
# Downloads and verifies the AIPAY agent runtime.
set -euo pipefail

REPO="aipayim/aipay-agent"
VERSION="${AIPAY_AGENT_VERSION:-}"
BASE="https://aipay.im/downloads"
DEST="${AIPAY_AGENT_DIST:-$HOME/.aipay/agent-dist}"

if [ -z "$VERSION" ]; then
  echo "Set AIPAY_AGENT_VERSION (see CHECKSUMS.txt in this repo) or run with a pinned version." >&2
  exit 1
fi

FILE="aipay-agent-$VERSION.tgz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $BASE/$FILE"
curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
curl -fsSL "$BASE/$FILE.sha256" -o "$TMP/$FILE.sha256"

EXPECTED="$(cut -d' ' -f1 "$TMP/$FILE.sha256")"
ACTUAL="$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum mismatch for $FILE" >&2
  exit 1
fi

mkdir -p "$DEST"
rm -rf "$DEST/package"
tar -xzf "$TMP/$FILE" -C "$DEST"
( cd "$DEST/package" && npm install --omit=dev --no-audit --no-fund )

echo "Installed to $DEST/package"
echo "Next: node $DEST/package/agent/cli.mjs config"
