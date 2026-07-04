#!/usr/bin/env node
import {
  AgentFileSystem,
  CodexConfigFile,
  MachineInventory,
  ManagedFileSnapshot,
  OpenSsh,
} from "@agenv/core";
import { Console, Effect, FileSystem, Layer, Option, Path, Ref, Stdio, Terminal } from "effect";
import { CliOutput, Command, Flag } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export const runCli = Effect.fn("Cli.runCli")(function* (args: readonly string[]) {
  const resultRef = yield* Ref.make<CliResult>(success(""));
  const command = makeCommand(resultRef);
  const run = Command.runWith(command, {
    version: "0.0.0",
  });

  yield* run(args).pipe(Effect.provide(cliLayer));
  return yield* Ref.get(resultRef);
});

const makeCommand = (resultRef: Ref.Ref<CliResult>) => {
  const jsonFlag = Flag.boolean("json");

  const hosts = Command.make("hosts", { json: jsonFlag }, (config) =>
    Effect.gen(function* () {
      const inventory = yield* MachineInventory.list();
      const stdout = config.json
        ? renderJson({ hosts: inventory.machines })
        : renderHosts(inventory);

      yield* Ref.set(resultRef, success(stdout));
    }),
  );
  const list = Command.make("list").pipe(Command.withSubcommands([hosts]));

  const configCommand = Command.make(
    "config",
    {
      host: Flag.string("host").pipe(Flag.optional),
      json: jsonFlag,
    },
    (options) =>
      Effect.gen(function* () {
        const host = Option.getOrUndefined(options.host);
        const snapshot = yield* CodexConfigFile.readConfig({
          target:
            host === undefined
              ? {
                  type: "local",
                }
              : {
                  alias: host,
                  type: "ssh",
                },
        });
        const stdout = options.json ? renderJson(snapshot) : renderSnapshot(snapshot, host);

        yield* Ref.set(resultRef, success(stdout));
      }),
  );
  const codex = Command.make("codex").pipe(Command.withSubcommands([configCommand]));
  const inspect = Command.make("inspect").pipe(Command.withSubcommands([codex]));

  return Command.make("agenv").pipe(Command.withSubcommands([list, inspect]));
};

const success = (stdout: string): CliResult => ({
  exitCode: 0,
  stderr: "",
  stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n`,
});

const renderJson = (value: unknown) => `${JSON.stringify(value, undefined, 2)}\n`;

const renderHosts = (inventory: MachineInventory.Inventory) => {
  if (inventory.machines.length === 0) {
    return "Hosts\nNo SSH-known Hosts found.\n";
  }

  const rows = inventory.machines.map((host) => [
    host.alias,
    host.hostName,
    host.user,
    String(host.port),
    `${host.source.kind}:${host.source.path}`,
  ]);
  const header = ["Alias", "HostName", "User", "Port", "Source"];
  const widths = header.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  return [
    "Hosts",
    renderRow(header),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(renderRow),
  ].join("\n");
};

const renderSnapshot = (
  snapshot: ManagedFileSnapshot.ManagedFileSnapshot,
  host: string | undefined,
) => {
  const lines = [
    "Codex Config File",
    `Target: ${host === undefined ? "local" : "Host"}`,
    ...(host === undefined ? [] : [`Host: ${host}`]),
    `State: ${snapshot.state}`,
    `Path: ${snapshot.path}`,
  ];

  if (snapshot.state === "present") {
    return [...lines, "", snapshot.contents].join("\n");
  }

  return [...lines, `Error: ${snapshot.error}`].join("\n");
};

const liveLayer = Layer.mergeAll(
  AgentFileSystem.layer((path) =>
    Effect.tryPromise({
      catch: AgentFileSystem.classifyReadFailure,
      try: () => readFile(path, "utf8"),
    }),
  ),
  OpenSsh.liveLayer,
  MachineInventory.liveLayer({
    sshConfigPath: join(process.env.HOME ?? homedir(), ".ssh", "config"),
  }),
);

const cliLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  CliOutput.layer(
    CliOutput.defaultFormatter({
      colors: false,
    }),
  ),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.die("Terminal input is not available for agenv commands"),
      readLine: Effect.die("Terminal input is not available for agenv commands"),
      rows: Effect.succeed(24),
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.die("Child process spawning is not available for agenv commands"),
    ),
  ),
);

const program = Effect.gen(function* () {
  const result = yield* runCli(process.argv.slice(2));

  if (result.stdout.length > 0) {
    yield* Console.log(result.stdout.trimEnd());
  }

  if (result.stderr.length > 0) {
    yield* Console.error(result.stderr.trimEnd());
  }

  process.exitCode = result.exitCode;
}).pipe(Effect.provide(liveLayer));

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  Effect.runPromise(program);
}
