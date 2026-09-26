#!/usr/bin/env bash
# Build Lichtblick's web app from source, at the tag pinned in
# LICHTBLICK_VERSION, into apps/advanced/.build/lichtblick/web/.webpack.
# scripts/assemble.mjs then copies it to dist/advanced/.
#
# Neither the source nor the output is committed (see .gitignore). This is
# what CI runs; locally it needs Node 22+, git, ~4 GB of disk and ~5 min.
#
#   apps/advanced/build.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(tr -d '[:space:]' < "$here/LICHTBLICK_VERSION")"
src="$here/.build/lichtblick"

if [ -d "$src/.git" ] && [ "$(git -C "$src" describe --tags --exact-match 2>/dev/null || true)" = "$version" ]; then
  echo "Lichtblick $version already checked out at $src"
else
  rm -rf "$src"
  mkdir -p "$here/.build"
  git clone --depth 1 --branch "$version" https://github.com/lichtblick-suite/lichtblick.git "$src"
fi

cd "$src"
# Lichtblick pins its Yarn version in package.json ("packageManager") and
# refuses to run without corepack.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0  # never stop to ask in CI
corepack enable
yarn install --immutable
yarn run web:build:prod
echo "built Lichtblick $version: $src/web/.webpack"
