import { Context, Effect, Layer } from "effect";
import * as AgentFileSystem from "./AgentFileSystem.js";
import type { FileReadFailure } from "./CodexConfigFile.js";
import * as OpenSsh from "./OpenSsh.js";

/**
 * Machine Inventory is the list of SSH-Known Machines agenv can present as
 * possible Agent Environment targets.
 */
export interface Inventory {
  readonly machines: readonly SyncableMachine[];
}

/**
 * Concrete SSH-known machine after OpenSSH resolution.
 */
export interface SyncableMachine {
  readonly alias: string;
  readonly hostName: string;
  readonly user: string;
  readonly port: number;
  readonly source: Source;
}

/**
 * Provenance for why a machine is visible to agenv.
 */
export interface Source {
  readonly kind: "ssh-config";
  readonly path: string;
}

/**
 * Effect service used by API clients to list the current Machine Inventory.
 *
 * The service boundary lets the API expose inventory before the live
 * OpenSSH-backed loader is wired into the default runtime.
 */
export class MachineInventoryService extends Context.Service<
  MachineInventoryService,
  {
    readonly list: Effect.Effect<Inventory>;
  }
>()("MachineInventoryService") {}

/**
 * Provides a fixed Machine Inventory.
 *
 * Useful for API tests and for the current default app runtime until live
 * OpenSSH inventory loading is connected.
 */
export const layer = (inventory: Inventory) =>
  Layer.succeed(MachineInventoryService)({
    list: Effect.succeed(inventory),
  });

export const emptyLayer = layer({
  machines: [],
});

/**
 * Lists Syncable Machines from the provided MachineInventoryService.
 */
export const list = Effect.fn("MachineInventory.list")(function* () {
  const machineInventory = yield* MachineInventoryService;

  return yield* machineInventory.list;
});

export interface LoadOptions {
  readonly sshConfigPath: string;
}

/**
 * Loads Machine Inventory from SSH config text and OpenSSH resolution output.
 *
 * This operation treats OpenSSH as the authority for resolved metadata and
 * filters wildcard/pattern Host entries so only concrete aliases become
 * Syncable Machines.
 */
export const load = Effect.fn("MachineInventory.load")(function* (options: LoadOptions) {
  const fileSystem = yield* AgentFileSystem.AgentFileSystem;
  const openSsh = yield* OpenSsh.OpenSsh;
  const sshConfig = yield* fileSystem.readFile(options.sshConfigPath);
  const aliases = concreteHostAliases(sshConfig);
  const machines: SyncableMachine[] = [];

  for (const alias of aliases) {
    const resolved = parseOpenSshResolution(yield* openSsh.resolve(alias));

    machines.push({
      alias,
      hostName: resolved.hostName,
      port: resolved.port,
      source: {
        kind: "ssh-config",
        path: options.sshConfigPath,
      },
      user: resolved.user,
    });
  }

  return { machines };
});

/**
 * Convenience wrapper for tests or narrow call sites that want to provide file
 * and OpenSSH behavior directly without manually composing layers.
 */
export const loadWith = (
  options: LoadOptions & {
    readonly readFile: (path: string) => Effect.Effect<string, FileReadFailure>;
    readonly runOpenSsh: (args: readonly string[]) => Effect.Effect<string>;
  },
) =>
  load(options).pipe(
    Effect.provide(
      Layer.mergeAll(
        AgentFileSystem.layer(options.readFile),
        OpenSsh.layer((alias) => options.runOpenSsh(["-G", alias])),
      ),
    ),
  );

const concreteHostAliases = (sshConfig: string) =>
  sshConfig
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith("host "))
    .flatMap((line) => line.slice(5).trim().split(/\s+/))
    .filter((alias) => alias.length > 0 && !/[*?!]/.test(alias));

const parseOpenSshResolution = (output: string) => {
  const fields = new Map(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/, 2))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([key, value]) => [key.toLowerCase(), value]),
  );

  return {
    hostName: fields.get("hostname") ?? "",
    port: Number(fields.get("port") ?? 22),
    user: fields.get("user") ?? "",
  };
};
