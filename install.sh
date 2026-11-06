#!/usr/bin/env bash
# Downloads and verifies the AIPAY agent runtime.
#
# Two sources, same sha256: aipay.im (canonical) and the GitHub release (mirror).
# Set AIPAY_AGENT_SOURCE=github to prefer the mirror.
set -euo pipefail

REPO="aipayim/aipay-agent"
VERSION="${AIPAY_AGENT_VERSION:-}"
SITE="https://aipay.im/downloads"
DEST="${AIPAY_AGENT_DIST:-$HOME/.aipay/agent-dist}"

if [ -z "$VERSION" ]; then
  echo "Set AIPAY_AGENT_VERSION (see CHECKSUMS.txt in this repo)." >&2
  exit 1
fi

FILE="aipay-agent-$VERSION.tgz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

checksum_of() { sha256sum "$1" | cut -d' ' -f1; }

fetch() {
  local url="$1" out="$2"
  echo "Downloading $url"
  curl -fsSL --retry 3 --max-time 120 "$url" -o "$out"
}

BASE_SITE="$SITE"
BASE_GH="https://github.com/$REPO/releases/download/v$VERSION"

# Checksum first, from whichever source answers; then the tarball, verified
# against it. A mirror that serves a different file fails here, not at runtime.
if [ "${AIPAY_AGENT_SOURCE:-site}" = "github" ]; then
  SOURCES="$BASE_GH $BASE_SITE"
else
  SOURCES="$BASE_SITE $BASE_GH"
fi

EXPECTED=""
for base in $SOURCES; do
  if [ -z "$EXPECTED" ]; then
    if fetch "$base/$FILE.sha256" "$TMP/$FILE.sha256" 2>/dev/null; then
      EXPECTED="$(cut -d' ' -f1 "$TMP/$FILE.sha256")"
    elif fetch "$base/CHECKSUMS.txt" "$TMP/CHECKSUMS.txt" 2>/dev/null; then
      EXPECTED="$(grep " $FILE$" "$TMP/CHECKSUMS.txt" | cut -d' ' -f1 || true)"
    fi
  fi
  if [ -n "$EXPECTED" ] && fetch "$base/$FILE" "$TMP/$FILE" 2>/dev/null; then
    if [ "$EXPECTED" = "$(checksum_of "$TMP/$FILE")" ]; then
      break
    fi
    echo "Checksum mismatch from $base, trying the next source" >&2
    rm -f "$TMP/$FILE"
  fi
done

if [ ! -f "$TMP/$FILE" ] || [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$(checksum_of "$TMP/$FILE")" ]; then
  echo "Could not download a tarball matching the published sha256 of $FILE." >&2
  exit 1
fi

mkdir -p "$DEST"
rm -rf "$DEST/package"
tar -xzf "$TMP/$FILE" -C "$DEST"
( cd "$DEST/package" && npm install --omit=dev --no-audit --no-fund )

echo "Installed to $DEST/package (sha256 $EXPECTED verified)"
echo "Next: node $DEST/package/agent/cli.mjs config"
