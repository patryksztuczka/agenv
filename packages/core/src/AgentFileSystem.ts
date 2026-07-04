import { Context, Effect, Layer, Schema } from "effect";

/**
 * Expected read failure when a file does not exist at the filesystem boundary.
 */
export class FileNotFound extends Schema.TaggedErrorClass<FileNotFound>()("FileNotFound", {
  message: Schema.String,
}) {}

/**
 * Expected read failure when a file exists but cannot be read at the filesystem
 * boundary.
 */
export class FileUnreadable extends Schema.TaggedErrorClass<FileUnreadable>()("FileUnreadable", {
  message: Schema.String,
}) {}

export type FileReadFailure = FileNotFound | FileUnreadable;

/**
 * Normalizes platform read errors into filesystem boundary errors.
 */
export const classifyReadFailure = (error: unknown): FileReadFailure => {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return new FileNotFound({
      message: "File is missing",
    });
  }

  return new FileUnreadable({
    message: error instanceof Error ? error.message : "File is unreadable",
  });
};

/**
 * Effect service for reading agent-environment files.
 *
 * Core domain operations depend on this service instead of Node's filesystem
 * APIs so tests, local reads, and future SSH-backed reads can share the same
 * behavior contract.
 */
export class AgentFileSystem extends Context.Service<
  AgentFileSystem,
  {
    readonly readFile: (path: string) => Effect.Effect<string, FileReadFailure>;
    readonly writeFile: (path: string, contents: string) => Effect.Effect<void, FileReadFailure>;
  }
>()("AgentFileSystem") {}

/**
 * Provides a concrete file-reading implementation to core operations.
 *
 * The implementation decides where bytes come from; callers still receive typed
 * file read failures instead of raw platform errors.
 */
export const layer = (
  readFile: (path: string) => Effect.Effect<string, FileReadFailure>,
  writeFile?: (path: string, contents: string) => Effect.Effect<void, FileReadFailure>,
) =>
  Layer.succeed(AgentFileSystem)({
    readFile,
    writeFile:
      writeFile ??
      ((path) =>
        Effect.fail(
          new FileUnreadable({
            message: `AgentFileSystem write is not configured for ${path}`,
          }),
        )),
  });
