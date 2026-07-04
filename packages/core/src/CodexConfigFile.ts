import { Effect, Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import * as AgentFileSystem from "./AgentFileSystem.js";
import type { ManagedFileSnapshot } from "./ManagedFileSnapshot.js";
import * as OpenSsh from "./OpenSsh.js";

/**
 * Expected read failure when the Codex Config File does not exist.
 */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("CodexConfigFileNotFound", {
  message: Schema.String,
}) {}

/**
 * Expected read failure when the Codex Config File exists but cannot be read.
 */
export class Unreadable extends Schema.TaggedErrorClass<Unreadable>()("CodexConfigFileUnreadable", {
  message: Schema.String,
}) {}

export type FileReadFailure = NotFound | Unreadable;

export interface LocalConfigOptions {
  readonly configPath: string;
}

export type ConfigTarget =
  | {
      readonly type: "local";
    }
  | {
      readonly alias: string;
      readonly type: "ssh";
    };

export interface ReadConfigOptions {
  readonly localConfigPath?: string;
  readonly remoteConfigPath?: string;
  readonly target: ConfigTarget;
}

export type SyncDirection = "pull" | "push";
export type SyncMode = "apply" | "preview";

export interface SyncConfigOptions {
  readonly direction: SyncDirection;
  readonly localConfigPath?: string;
  readonly remoteConfigPath?: string;
  readonly host: string;
  readonly mode: SyncMode;
}

export interface SyncConfigResult {
  readonly applied: boolean;
  readonly changed: boolean;
  readonly destination: ManagedFileSnapshot;
  readonly diff: string;
  readonly direction: SyncDirection;
  readonly error?: string;
  readonly mode: SyncMode;
  readonly source: ManagedFileSnapshot;
  readonly verified: boolean;
}

/**
 * Reads the local Codex Config File.
 *
 * The operation is display-only: it preserves native contents exactly and
 * converts typed read failures into stable snapshot states.
 */
export const readLocalConfig = Effect.fn("CodexConfigFile.readLocalConfig")(function* (
  options: LocalConfigOptions,
) {
  const fileSystem = yield* AgentFileSystem.AgentFileSystem;
  const snapshot = yield* fileSystem.readFile(options.configPath).pipe(
    Effect.mapError(mapFileReadFailure),
    Effect.match({
      onFailure: (failure) =>
        ({
          configFamily: "codex",
          error: failure.message,
          managedFile: "config.toml",
          path: options.configPath,
          state: failure instanceof NotFound ? "missing" : "unreadable",
        }) satisfies ManagedFileSnapshot,
      onSuccess: (fileContents) =>
        ({
          configFamily: "codex",
          contents: fileContents,
          managedFile: "config.toml",
          path: options.configPath,
          state: "present",
        }) satisfies ManagedFileSnapshot,
    }),
  );

  return snapshot;
});

/**
 * Reads the Codex Config File for an explicit target.
 *
 * Local targets use AgentFileSystem. SSH targets use OpenSsh and map
 * SSH-level connection failures into the shared Managed File Snapshot state.
 */
export const readConfig = Effect.fn("CodexConfigFile.readConfig")(function* (
  options: ReadConfigOptions,
) {
  if (options.target.type === "local") {
    const configPathEffect =
      options.localConfigPath === undefined
        ? defaultLocalConfigPath.pipe(
            Effect.match({
              onFailure: (failure) => failure,
              onSuccess: (path) => path,
            }),
          )
        : Effect.succeed(options.localConfigPath);
    const configPath = yield* configPathEffect;

    if (configPath instanceof Unreadable) {
      return {
        configFamily: "codex",
        error: configPath.message,
        managedFile: "config.toml",
        path: "<unknown>",
        state: "unreadable",
      } satisfies ManagedFileSnapshot;
    }

    return yield* readLocalConfig({
      configPath,
    });
  }

  const openSsh = yield* OpenSsh.OpenSsh;
  const alias = options.target.alias;
  const configPath = options.remoteConfigPath ?? "~/.codex/config.toml";
  const snapshot = yield* openSsh.readFile(alias, configPath).pipe(
    Effect.match({
      onFailure: (failure) =>
        ({
          configFamily: "codex",
          error: failure.message,
          managedFile: "config.toml",
          path: `${alias}:${configPath}`,
          state:
            failure instanceof OpenSsh.ConnectionFailed
              ? "connection-failed"
              : failure instanceof OpenSsh.RemoteFileNotFound
                ? "missing"
                : "unreadable",
        }) satisfies ManagedFileSnapshot,
      onSuccess: (fileContents) =>
        ({
          configFamily: "codex",
          contents: fileContents,
          managedFile: "config.toml",
          path: `${alias}:${configPath}`,
          state: "present",
        }) satisfies ManagedFileSnapshot,
    }),
  );

  return snapshot;
});

export const syncConfig = Effect.fn("CodexConfigFile.syncConfig")(function* (
  options: SyncConfigOptions,
) {
  const localPath = yield* resolveLocalConfigPath(options.localConfigPath);
  const remotePath = options.remoteConfigPath ?? "~/.codex/config.toml";
  const sourceTarget = syncSourceTarget(options.direction, options.host);
  const destinationTarget = syncDestinationTarget(options.direction, options.host);
  const source = yield* readConfig({
    localConfigPath: localPath,
    remoteConfigPath: remotePath,
    target: sourceTarget,
  });
  const destination = yield* readConfig({
    localConfigPath: localPath,
    remoteConfigPath: remotePath,
    target: destinationTarget,
  });
  const diff =
    source.state === "present" && destination.state === "present"
      ? unifiedDiff(destination.path, destination.contents, source.path, source.contents)
      : source.state === "present" && destination.state === "missing"
        ? unifiedDiff(destination.path, "", source.path, source.contents)
        : "";

  if (source.state !== "present") {
    return syncFailure(options, source, destination, diff, `Source is ${source.state}.`);
  }

  if (destination.state === "unreadable" || destination.state === "connection-failed") {
    return syncFailure(options, source, destination, diff, `Destination is ${destination.state}.`);
  }

  if (diff.length === 0) {
    return {
      applied: false,
      changed: false,
      destination,
      diff,
      direction: options.direction,
      mode: options.mode,
      source,
      verified: options.mode === "apply",
    } satisfies SyncConfigResult;
  }

  if (options.mode === "preview") {
    return {
      applied: false,
      changed: true,
      destination,
      diff,
      direction: options.direction,
      mode: options.mode,
      source,
      verified: false,
    } satisfies SyncConfigResult;
  }

  const writeError = yield* writeDestination(
    options.direction,
    options.host,
    localPath,
    remotePath,
    source.contents,
  ).pipe(
    Effect.match({
      onFailure: (failure) => failure.message,
      onSuccess: () => undefined,
    }),
  );

  if (writeError !== undefined) {
    return syncFailure(
      options,
      source,
      destination,
      diff,
      `Destination write failed: ${writeError}`,
    );
  }

  const verifiedDestination = yield* readConfig({
    localConfigPath: localPath,
    remoteConfigPath: remotePath,
    target: destinationTarget,
  });

  if (
    verifiedDestination.state !== "present" ||
    hashContents(verifiedDestination.contents) !== hashContents(source.contents)
  ) {
    return {
      applied: true,
      changed: true,
      destination: verifiedDestination,
      diff,
      direction: options.direction,
      error: "Verification failed.",
      mode: options.mode,
      source,
      verified: false,
    } satisfies SyncConfigResult;
  }

  return {
    applied: true,
    changed: true,
    destination: verifiedDestination,
    diff,
    direction: options.direction,
    mode: options.mode,
    source,
    verified: true,
  } satisfies SyncConfigResult;
});

/**
 * Normalizes platform read errors into Codex Config File domain errors.
 *
 * This should stay near the platform boundary; core logic should work with the
 * typed `FileReadFailure` union rather than raw Node errors.
 */
export const classifyReadFailure = (error: unknown): FileReadFailure => {
  const failure = AgentFileSystem.classifyReadFailure(error);

  if (failure instanceof AgentFileSystem.FileNotFound) {
    return new NotFound({
      message: "Codex Config File is missing",
    });
  }

  return new Unreadable({
    message: error instanceof Error ? error.message : "Codex Config File is unreadable",
  });
};

const mapFileReadFailure = (failure: AgentFileSystem.FileReadFailure): FileReadFailure => {
  if (failure instanceof AgentFileSystem.FileNotFound) {
    return new NotFound({
      message: failure.message,
    });
  }

  return new Unreadable({
    message: failure.message,
  });
};

const defaultLocalConfigPath = Effect.try({
  catch: (error) =>
    new Unreadable({
      message:
        error instanceof Error
          ? error.message
          : "Could not determine home directory for Codex config",
    }),
  try: () => join(homeDirectory(), ".codex", "config.toml"),
});

const resolveLocalConfigPath = (path: string | undefined) =>
  path === undefined
    ? defaultLocalConfigPath.pipe(
        Effect.mapError((failure) => failure),
        Effect.map((resolved) => resolved),
      )
    : Effect.succeed(path);

const syncSourceTarget = (direction: SyncDirection, host: string): ConfigTarget =>
  direction === "push"
    ? { type: "local" }
    : {
        alias: host,
        type: "ssh",
      };

const syncDestinationTarget = (direction: SyncDirection, host: string): ConfigTarget =>
  direction === "push"
    ? {
        alias: host,
        type: "ssh",
      }
    : { type: "local" };

const syncFailure = (
  options: SyncConfigOptions,
  source: ManagedFileSnapshot,
  destination: ManagedFileSnapshot,
  diff: string,
  error: string,
) =>
  ({
    applied: false,
    changed: diff.length > 0,
    destination,
    diff,
    direction: options.direction,
    error,
    mode: options.mode,
    source,
    verified: false,
  }) satisfies SyncConfigResult;

const writeDestination = (
  direction: SyncDirection,
  host: string,
  localPath: string,
  remotePath: string,
  contents: string,
) =>
  Effect.gen(function* () {
    if (direction === "push") {
      const openSsh = yield* OpenSsh.OpenSsh;

      return yield* openSsh.writeFile(host, remotePath, contents);
    }

    const fileSystem = yield* AgentFileSystem.AgentFileSystem;

    return yield* fileSystem.writeFile(localPath, contents);
  });

const unifiedDiff = (
  oldPath: string,
  oldContents: string,
  newPath: string,
  newContents: string,
) => {
  if (oldContents === newContents) {
    return "";
  }

  const oldLines = splitLines(oldContents);
  const newLines = splitLines(newContents);
  const lines = [`--- ${oldPath}`, `+++ ${newPath}`, `@@ -1 +1 @@`];

  for (const line of oldLines) {
    lines.push(`-${line}`);
  }

  for (const line of newLines) {
    lines.push(`+${line}`);
  }

  return `${lines.join("\n")}\n`;
};

const splitLines = (contents: string) => contents.replace(/\n$/, "").split("\n");

const hashContents = (contents: string) => {
  let hash = 0;

  for (let index = 0; index < contents.length; index += 1) {
    hash = (hash * 31 + contents.charCodeAt(index)) >>> 0;
  }

  return hash;
};

const homeDirectory = () => {
  const directory = process.env.HOME ?? homedir();

  if (directory.length === 0) {
    throw new Error("Could not determine home directory for Codex config");
  }

  return directory;
};

/**
 * Convenience wrapper for tests or narrow call sites that want to provide a
 * file reader directly without manually composing an AgentFileSystem layer.
 */
export const readLocalConfigWith = (
  options: LocalConfigOptions & {
    readonly readFile: (path: string) => Effect.Effect<string, AgentFileSystem.FileReadFailure>;
  },
) => readLocalConfig(options).pipe(Effect.provide(AgentFileSystem.layer(options.readFile)));
