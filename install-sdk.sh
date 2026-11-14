#!/usr/bin/env bash
# Installs the AIPAY merchant watcher SDK (sdk/aipay-watch).
#
# Nothing is installed globally and no npm registry is involved: the tarball is
# fetched, its sha256 is verified, and the files are unpacked where you point it.
set -euo pipefail

REPO="aipayim/aipay-agent"
VERSION="${AIPAY_WATCH_VERSION:-}"
SITE="https://aipay.im/downloads"
DEST="${AIPAY_WATCH_HOME:-$HOME/.aipay/watch}"

if [ -z "$VERSION" ]; then
  echo "Set AIPAY_WATCH_VERSION (see sdk-latest.json or the GitHub release)." >&2
  exit 1
fi

FILE="aipay-watch-$VERSION.tgz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

fetch() {
  echo "Downloading $1"
  curl -fsSL --retry 3 --max-time 120 "$1" -o "$2"
}

BASES="$SITE https://github.com/$REPO/releases/download/sdk-v$VERSION"
if [ "${AIPAY_WATCH_SOURCE:-site}" = "github" ]; then
  BASES="https://github.com/$REPO/releases/download/sdk-v$VERSION $SITE"
fi

EXPECTED=""
for base in $BASES; do
  [ -n "$EXPECTED" ] && break
  if fetch "$base/$FILE.sha256" "$TMP/$FILE.sha256" 2>/dev/null; then
    EXPECTED="$(cut -d' ' -f1 "$TMP/$FILE.sha256")"
  fi
done
if [ -z "$EXPECTED" ]; then
  echo "Could not find $FILE.sha256 (aipay.im or the GitHub release)." >&2
  exit 1
fi

for base in $BASES; do
  if fetch "$base/$FILE" "$TMP/$FILE" 2>/dev/null && [ "$EXPECTED" = "$(sha_of "$TMP/$FILE")" ]; then
    break
  fi
  rm -f "$TMP/$FILE"
done

if [ ! -f "$TMP/$FILE" ] || [ "$EXPECTED" != "$(sha_of "$TMP/$FILE")" ]; then
  echo "No tarball matched the published sha256 for $FILE." >&2
  exit 1
fi

mkdir -p "$DEST"
rm -rf "$DEST/package"
tar -xzf "$TMP/$FILE" -C "$DEST"

echo "Installed to $DEST/package (sha256 $EXPECTED verified)"
echo "Next: node $DEST/package/bin/aipay-watch.mjs --help"
