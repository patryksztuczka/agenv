# Install

agenv uses Node 26.3.0 or newer and pins development to pnpm 10.33.0.

The Node policy is declared in `package.json` and the minimum known-good runtime
is pinned in `.node-version`.

## Fresh clone

1. Select Node 26.3.0:

   ```sh
   # with nvm
   nvm install 26.3.0
   nvm use 26.3.0

   # or with mise
   mise shell node@26.3.0
   ```

2. Install with the declared package manager:

   ```sh
   corepack enable
   corepack pnpm install --frozen-lockfile
   ```

   The project policy is `pnpm@10.33.0`, matching the `packageManager` field in
   `package.json`. If Corepack is not available but a host pnpm is, a host pnpm
   may be used only to bootstrap `node_modules`:

   ```sh
   pnpm install --frozen-lockfile
   node_modules/.bin/pnpm --version
   ```

   The second command must print `10.33.0`. After that, run repo commands through
   the pinned pnpm:

   ```sh
   node_modules/.bin/pnpm test
   ```

## Install policy

`pnpm install --frozen-lockfile` must not edit tracked files. The workspace
commits explicit build-script decisions in `pnpm-workspace.yaml` so pnpm does not
write temporary `allowBuilds` placeholders during install.

The approved build-script packages are:

- `esbuild`, required by the Vite/Vitest toolchain.
- `msgpackr-extract`, an optional native dependency used by transitive runtime
  packages.

pnpm 10.33.0 does not re-check minimum-release-age or trust-policy metadata.
Those checks can appear when a newer host pnpm is used for the first bootstrap.
If a newer host pnpm rejects recent lockfile entries before the pinned pnpm is
available, rerun only the host-pnpm bootstrap install with:

```sh
pnpm install --frozen-lockfile --trust-lockfile
```

`--trust-lockfile` skips re-verification of the committed lockfile. Use it only
when installing from a trusted checkout of this repository, then switch back to
`node_modules/.bin/pnpm` for normal repo commands.
