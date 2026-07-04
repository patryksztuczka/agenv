import { Context, Effect, Layer } from "effect";
import type { FileReadFailure } from "./CodexConfigFile.js";

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
  }
>()("AgentFileSystem") {}

/**
 * Provides a concrete file-reading implementation to core operations.
 *
 * The implementation decides where bytes come from; callers still receive
 * typed Codex Config File read failures instead of raw platform errors.
 */
export const layer = (readFile: (path: string) => Effect.Effect<string, FileReadFailure>) =>
  Layer.succeed(AgentFileSystem)({
    readFile,
  });
