import { Context, Effect, Layer, Schema } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);

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
    readonly resolve: (alias: string) => Effect.Effect<string, ConnectionFailed>;
  }
>()("OpenSsh") {}

/**
 * Provides the OpenSSH resolver used by Machine Inventory loading.
 */
export const layer = (options: {
  readonly readFile?: (alias: string, path: string) => Effect.Effect<string, RemoteFileReadFailure>;
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
  readFile: (alias, path) =>
    Effect.tryPromise({
      catch: (error) => classifyRemoteReadFailure(error),
      try: async () => {
        validateAlias(alias);

        const result = await execFilePromise("ssh", [alias, "sh", "-lc", remoteReadCommand(path)]);

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
});

export const unsafeOpenSshInternals = {
  remoteReadCommand,
  validateAlias,
};

function validateAlias(alias: string) {
  if (alias.length === 0 || alias.startsWith("-")) {
    throw new ConnectionFailed({
      message: `Unsafe SSH alias: ${alias}`,
    });
  }
}

function remoteReadCommand(path: string) {
  const quotedPath = shellPath(path);

  return [
    `if [ ! -e ${quotedPath} ]; then exit 2; fi`,
    `if [ ! -r ${quotedPath} ]; then exit 3; fi`,
    `cat -- ${quotedPath}`,
  ].join("; ");
}

const shellPath = (path: string) => {
  if (path.startsWith("~/")) {
    return `~/${quoteShell(path.slice(2))}`;
  }

  return quoteShell(path);
};

const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const classifyRemoteReadFailure = (error: unknown): RemoteFileReadFailure => {
  const code = exitCode(error);
  const message = errorMessage(error);

  if (code === 2) {
    return new RemoteFileNotFound({ message });
  }

  if (code === 3) {
    return new RemoteFileUnreadable({ message });
  }

  return new ConnectionFailed({ message });
};

const exitCode = (error: unknown) => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;

    return typeof code === "number" ? code : undefined;
  }

  return undefined;
};

const errorMessage = (error: unknown) => {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = error.stderr;

    if (typeof stderr === "string" && stderr.length > 0) {
      return stderr.trim();
    }
  }

  return error instanceof Error ? error.message : "OpenSSH command failed";
};
