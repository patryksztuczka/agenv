import { Context, Effect, Layer } from "effect";

/**
 * Effect service for OpenSSH-backed alias resolution.
 *
 * This keeps OpenSSH as the authority while allowing tests to inject stable
 * `ssh -G` output without touching a developer's real SSH configuration.
 */
export class OpenSsh extends Context.Service<
  OpenSsh,
  {
    readonly resolve: (alias: string) => Effect.Effect<string>;
  }
>()("OpenSsh") {}

/**
 * Provides the OpenSSH resolver used by Machine Inventory loading.
 */
export const layer = (resolve: (alias: string) => Effect.Effect<string>) =>
  Layer.succeed(OpenSsh)({
    resolve,
  });
