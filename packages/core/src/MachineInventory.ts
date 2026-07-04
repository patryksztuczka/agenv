import { Context, Effect, Layer } from "effect";
import * as AgentFileSystem from "./AgentFileSystem.js";
import * as OpenSsh from "./OpenSsh.js";

/**
 * Machine Inventory is the list of SSH-Known Machines agenv can present as
 * possible Agent Environment targets.
 */
export interface Inventory {
  readonly machines: readonly InventoryMachine[];
}

/**
 * SSH-known machine discovered from config, with per-alias resolution state.
 */
export type InventoryMachine = SyncableMachine | ResolutionFailedMachine;

/**
 * Concrete SSH-known machine after OpenSSH resolution.
 */
export interface SyncableMachine {
  readonly state: "resolved";
  readonly alias: string;
  readonly hostName: string;
  readonly user: string;
  readonly port: number;
  readonly source: Source;
}

/**
 * SSH-known machine whose alias could not be resolved by OpenSSH.
 */
export interface ResolutionFailedMachine {
  readonly state: "resolution-failed";
  readonly alias: string;
  readonly source: Source;
  readonly error: string;
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
    readonly list: Effect.Effect<
      Inventory,
      AgentFileSystem.FileUnreadable,
      AgentFileSystem.AgentFileSystem | OpenSsh.OpenSsh
    >;
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

/**
 * Provides Machine Inventory by loading SSH config and resolving aliases each
 * time the inventory is requested.
 */
export const liveLayer = (options: LoadOptions) =>
  Layer.succeed(MachineInventoryService)({
    list: load(options).pipe(
      Effect.catchIf(
        (failure) => failure instanceof AgentFileSystem.FileNotFound,
        () =>
          Effect.succeed({
            machines: [],
          }),
      ),
    ),
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
 * inventory records. OpenSSH resolution failures stay attached to the alias
 * that failed so one broken Host entry cannot hide the rest of inventory.
 */
export const load = Effect.fn("MachineInventory.load")(function* (options: LoadOptions) {
  const fileSystem = yield* AgentFileSystem.AgentFileSystem;
  const openSsh = yield* OpenSsh.OpenSsh;
  const sshConfig = yield* fileSystem.readFile(options.sshConfigPath);
  const aliases = concreteHostAliases(sshConfig);
  const machines: InventoryMachine[] = [];

  for (const alias of aliases) {
    const source: Source = {
      kind: "ssh-config",
      path: options.sshConfigPath,
    };
    const machine = yield* openSsh.resolve(alias).pipe(
      Effect.map(parseOpenSshResolution),
      Effect.map(
        (resolved): InventoryMachine => ({
          alias,
          hostName: resolved.hostName,
          port: resolved.port,
          source,
          state: "resolved",
          user: resolved.user,
        }),
      ),
      Effect.catch((failure: OpenSsh.ConnectionFailed) =>
        Effect.succeed({
          alias,
          error: failure.message,
          source,
          state: "resolution-failed" as const,
        } satisfies ResolutionFailedMachine),
      ),
    );

    machines.push(machine);
  }

  return { machines };
});

/**
 * Convenience wrapper for tests or narrow call sites that want to provide file
 * and OpenSSH behavior directly without manually composing layers.
 */
export const loadWith = (
  options: LoadOptions & {
    readonly readFile: (path: string) => Effect.Effect<string, AgentFileSystem.FileReadFailure>;
    readonly runOpenSsh: (args: readonly string[]) => Effect.Effect<string>;
  },
) =>
  load(options).pipe(
    Effect.provide(
      Layer.mergeAll(
        AgentFileSystem.layer(options.readFile),
        OpenSsh.layer({
          resolve: (alias) => options.runOpenSsh(["-G", alias]),
        }),
      ),
    ),
  );

const concreteHostAliases = (sshConfig: string) => [
  ...new Set(
    sshConfig
      .split(/\r?\n/)
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = /^host\s+(.+)$/i.exec(line);

        return match === null
          ? []
          : stripInlineComment(match[1] ?? "")
              .trim()
              .split(/\s+/);
      })
      .filter((alias) => alias.length > 0 && !/[*?!]/.test(alias)),
  ),
];

const stripInlineComment = (value: string) => {
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character === quote) {
      quote = undefined;
      continue;
    }

    if (quote === undefined && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }

    if (quote === undefined && character === "#") {
      return value.slice(0, index);
    }
  }

  return value;
};

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
