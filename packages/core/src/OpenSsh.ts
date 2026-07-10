import { Context, Effect, Layer, Schema } from "effect";
import type { DirectoryEntry } from "./AgentFileSystem.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);
const REMOTE_FILE_MISSING_MARKER = "__AGENV_REMOTE_MISSING__";
const REMOTE_FILE_UNREADABLE_MARKER = "__AGENV_REMOTE_UNREADABLE__";
const REMOTE_FILE_MISSING_EXIT_CODE = 86;
const REMOTE_FILE_UNREADABLE_EXIT_CODE = 87;

/**
 * Expected failure when OpenSSH cannot connect to or resolve an SSH-Known
 * Machine.
 */
export class ConnectionFailed extends Schema.TaggedErrorClass<ConnectionFailed>()(
  "OpenSshConnectionFailed",
  {
    message: Schema.String,
  },
) {}

/**
 * Expected remote read failure when a file is absent on an SSH-Known Machine.
 */
export class RemoteFileNotFound extends Schema.TaggedErrorClass<RemoteFileNotFound>()(
  "OpenSshRemoteFileNotFound",
  {
    message: Schema.String,
  },
) {}

/**
 * Expected remote read failure when a file exists but cannot be read over SSH.
 */
export class RemoteFileUnreadable extends Schema.TaggedErrorClass<RemoteFileUnreadable>()(
  "OpenSshRemoteFileUnreadable",
  {
    message: Schema.String,
  },
) {}

export type RemoteFileReadFailure = ConnectionFailed | RemoteFileNotFound | RemoteFileUnreadable;

/**
 * Effect service for OpenSSH-backed alias resolution.
 *
 * This keeps OpenSSH as the authority while allowing tests to inject stable
 * `ssh -G` output without touching a developer's real SSH configuration.
 */
export class OpenSsh extends Context.Service<
  OpenSsh,
  {
    readonly readFile: (
      alias: string,
      path: string,
    ) => Effect.Effect<string, RemoteFileReadFailure>;
    readonly readDirectory: (
      alias: string,
      path: string,
    ) => Effect.Effect<readonly DirectoryEntry[], RemoteFileReadFailure>;
    readonly writeFile: (
      alias: string,
      path: string,
      contents: string,
    ) => Effect.Effect<void, RemoteFileReadFailure>;
    readonly resolve: (alias: string) => Effect.Effect<string, ConnectionFailed>;
  }
>()("OpenSsh") {}

/**
 * Provides the OpenSSH resolver used by Machine Inventory loading.
 */
export const layer = (options: {
  readonly readFile?: (alias: string, path: string) => Effect.Effect<string, RemoteFileReadFailure>;
  readonly readDirectory?: (
    alias: string,
    path: string,
  ) => Effect.Effect<readonly DirectoryEntry[], RemoteFileReadFailure>;
  readonly writeFile?: (
    alias: string,
    path: string,
    contents: string,
  ) => Effect.Effect<void, RemoteFileReadFailure>;
  readonly resolve: (alias: string) => Effect.Effect<string, ConnectionFailed>;
}) =>
  Layer.succeed(OpenSsh)({
    readFile:
      options.readFile ??
      ((alias, path) =>
        Effect.fail(
          new ConnectionFailed({
            message: `OpenSSH remote file read is not configured for ${alias}:${path}`,
          }),
        )),
    readDirectory:
      options.readDirectory ??
      ((alias, path) =>
        Effect.fail(
          new ConnectionFailed({
            message: `OpenSSH remote directory read is not configured for ${alias}:${path}`,
          }),
        )),
    writeFile:
      options.writeFile ??
      ((alias, path) =>
        Effect.fail(
          new RemoteFileUnreadable({
            message: `OpenSSH remote file write is not configured for ${alias}:${path}`,
          }),
        )),
    resolve: options.resolve,
  });

/**
 * Live OpenSSH implementation backed by the user's installed `ssh` CLI.
 *
 * Resolution uses `ssh -G <alias>`. Remote file reads execute a small
 * POSIX-shell command over SSH so missing, unreadable, and connection failures
 * can be classified into stable error types.
 */
export const liveLayer = Layer.succeed(OpenSsh)({
  readDirectory: (alias, path) =>
    Effect.tryPromise({
      catch: (error) => classifyRemoteReadFailure(error),
      try: async () => {
        validateAlias(alias);

        const result = await execFilePromise("ssh", [
          alias,
          remoteShellCommand(remoteReadDirectoryCommand(path)),
        ]);

        return parseDirectoryEntries(result.stdout);
      },
    }),
  readFile: (alias, path) =>
    Effect.tryPromise({
      catch: (error) => classifyRemoteReadFailure(error),
      try: async () => {
        validateAlias(alias);

        const result = await execFilePromise("ssh", [
          alias,
          remoteShellCommand(remoteReadCommand(path)),
        ]);

        return result.stdout;
      },
    }),
  resolve: (alias) =>
    Effect.tryPromise({
      catch: (error) =>
        new ConnectionFailed({
          message: errorMessage(error),
        }),
      try: async () => {
        validateAlias(alias);

        const result = await execFilePromise("ssh", ["-G", alias]);

        return result.stdout;
      },
    }),
  writeFile: (alias, path, contents) =>
    Effect.tryPromise({
      catch: (error) => classifyRemoteReadFailure(error),
      try: async () => {
        validateAlias(alias);

        await execFilePromise("ssh", [
          alias,
          remoteShellCommand(
            remoteWriteCommand(path, Buffer.from(contents, "utf8").toString("base64")),
          ),
        ]);
      },
    }),
});

export const unsafeOpenSshInternals = {
  classifyRemoteReadFailure,
  parseDirectoryEntries,
  remoteReadDirectoryCommand,
  remoteReadCommand,
  remoteShellCommand,
  remoteWriteCommand,
  validateAlias,
};

function validateAlias(alias: string) {
  if (alias.length === 0 || alias.startsWith("-")) {
    throw new ConnectionFailed({
      message: `Unsafe SSH alias: ${alias}`,
    });
  }
}

function remoteReadDirectoryCommand(path: string) {
  const quotedPath = shellPath(path);

  return [
    `if [ ! -e ${quotedPath} ]; then ${remoteFailureCommand(
      REMOTE_FILE_MISSING_MARKER,
      REMOTE_FILE_MISSING_EXIT_CODE,
    )}; fi`,
    `if [ ! -r ${quotedPath} ] || [ ! -d ${quotedPath} ]; then ${remoteFailureCommand(
      REMOTE_FILE_UNREADABLE_MARKER,
      REMOTE_FILE_UNREADABLE_EXIT_CODE,
    )}; fi`,
    `find ${quotedPath} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n'`,
  ].join("; ");
}

function remoteReadCommand(path: string) {
  const quotedPath = shellPath(path);

  return [
    `if [ ! -e ${quotedPath} ]; then ${remoteFailureCommand(
      REMOTE_FILE_MISSING_MARKER,
      REMOTE_FILE_MISSING_EXIT_CODE,
    )}; fi`,
    `if [ ! -r ${quotedPath} ]; then ${remoteFailureCommand(
      REMOTE_FILE_UNREADABLE_MARKER,
      REMOTE_FILE_UNREADABLE_EXIT_CODE,
    )}; fi`,
    `cat -- ${quotedPath}`,
  ].join("; ");
}

function parseDirectoryEntries(stdout: string): readonly DirectoryEntry[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.lastIndexOf("\t");
      const name = separator === -1 ? line : line.slice(0, separator);
      const type = separator === -1 ? "" : line.slice(separator + 1);

      return {
        isDirectory: type === "d",
        name,
      };
    });
}

function remoteFailureCommand(marker: string, exitCode: number) {
  return `printf '%s\\n' ${quoteShell(marker)} >&2; exit ${exitCode}`;
}

function remoteWriteCommand(path: string, base64Contents: string) {
  const quotedPath = shellPath(path);
  const quotedContents = quoteShell(base64Contents);

  return [
    `parent=$(dirname -- ${quotedPath})`,
    `mkdir -p -- "$parent"`,
    `tmp=$(mktemp "$parent/.agenv-config.toml.XXXXXX")`,
    `printf '%s' ${quotedContents} | base64 -d > "$tmp"`,
    `if [ -e ${quotedPath} ]; then chmod --reference=${quotedPath} "$tmp" 2>/dev/null || true; else chmod 600 "$tmp"; fi`,
    `mv -f -- "$tmp" ${quotedPath}`,
  ].join("; ");
}

function remoteShellCommand(script: string) {
  return `sh -lc ${quoteShell(script)}`;
}

const shellPath = (path: string) => {
  if (path.startsWith("~/")) {
    return `~/${quoteShell(path.slice(2))}`;
  }

  return quoteShell(path);
};

const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function classifyRemoteReadFailure(error: unknown): RemoteFileReadFailure {
  const code = exitCode(error);
  const stderr = errorStderr(error);
  const message = errorMessage(error);

  if (
    code === REMOTE_FILE_MISSING_EXIT_CODE &&
    hasRemoteFailureMarker(stderr, REMOTE_FILE_MISSING_MARKER)
  ) {
    return new RemoteFileNotFound({
      message: remoteFailureMessage(stderr, REMOTE_FILE_MISSING_MARKER, "Remote file is missing"),
    });
  }

  if (
    code === REMOTE_FILE_UNREADABLE_EXIT_CODE &&
    hasRemoteFailureMarker(stderr, REMOTE_FILE_UNREADABLE_MARKER)
  ) {
    return new RemoteFileUnreadable({
      message: remoteFailureMessage(
        stderr,
        REMOTE_FILE_UNREADABLE_MARKER,
        "Remote file is unreadable",
      ),
    });
  }

  return new ConnectionFailed({ message });
}

const hasRemoteFailureMarker = (stderr: string | undefined, marker: string) =>
  stderr?.split(/\r?\n/).some((line) => line.trim() === marker) ?? false;

const remoteFailureMessage = (stderr: string | undefined, marker: string, fallback: string) => {
  const details =
    stderr
      ?.split(/\r?\n/)
      .filter((line) => line.trim().length > 0 && line.trim() !== marker)
      .join("\n")
      .trim() ?? "";

  return details.length > 0 ? details : fallback;
};

const exitCode = (error: unknown) => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;

    return typeof code === "number" ? code : undefined;
  }

  return undefined;
};

const errorStderr = (error: unknown) => {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = error.stderr;

    return typeof stderr === "string" ? stderr : undefined;
  }

  return undefined;
};

const errorMessage = (error: unknown) => {
  const stderr = errorStderr(error);

  if (stderr !== undefined && stderr.length > 0) {
    return stderr.trim();
  }

  return error instanceof Error ? error.message : "OpenSSH command failed";
};
