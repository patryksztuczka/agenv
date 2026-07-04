#!/usr/bin/env sh

set -eu

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect-smol"

if [ -d "$repo_dir/.git" ]; then
  exit 0
fi

if [ -e "$repo_dir" ]; then
  cat >&2 <<EOF
Cannot prepare Effect reference checkout: $repo_dir already exists but is not a git repository.

Move or remove $repo_dir, then rerun:
  pnpm prepare:effect
EOF
  exit 1
fi

mkdir -p ".repos"
git clone "$repo_url" "$repo_dir"
