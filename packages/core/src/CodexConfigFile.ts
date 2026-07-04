import { Effect, Schema } from "effect";
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
    return yield* readLocalConfig({
      configPath: options.localConfigPath ?? "~/.codex/config.toml",
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

/**
 * Normalizes platform read errors into Codex Config File domain errors.
 *
 * This should stay near the platform boundary; core logic should work with the
 * typed `FileReadFailure` union rather than raw Node errors.
 */
export const classifyReadFailure = (error: unknown): FileReadFailure => {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return new NotFound({
      message: "Codex Config File is missing",
    });
  }

  return new Unreadable({
    message: error instanceof Error ? error.message : "Codex Config File is unreadable",
  });
};

/**
 * Convenience wrapper for tests or narrow call sites that want to provide a
 * file reader directly without manually composing an AgentFileSystem layer.
 */
export const readLocalConfigWith = (
  options: LocalConfigOptions & {
    readonly readFile: (path: string) => Effect.Effect<string, FileReadFailure>;
  },
) => readLocalConfig(options).pipe(Effect.provide(AgentFileSystem.layer(options.readFile)));
