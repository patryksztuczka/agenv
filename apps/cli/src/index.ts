#!/usr/bin/env node
import {
  AgentFileSystem,
  CodexConfigDiff,
  CodexConfigFile,
  MachineInventory,
  ManagedFileSnapshot,
  OpenSsh,
} from "@agenv/core";
import type { CodexConfigDiffPreview, CodexConfigDiffSnapshotMetadata } from "@agenv/core";
import { Console, Effect, FileSystem, Layer, Option, Path, Ref, Stdio, Terminal } from "effect";
import type { Console as EffectConsole } from "effect/Console";
import { CliOutput, Command, Flag } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { readFile } from "node:fs/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export const runCli = Effect.fn("Cli.runCli")(function* (args: readonly string[]) {
  const resultRef = yield* Ref.make<CliResult>(emptyResult);
  const command = makeCommand(resultRef);
  const run = Command.runWith(command, {
    version: "0.0.0",
  });
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const capturedConsole: EffectConsole = {
    ...globalThis.console,
    error: (...values) => {
      stderr += `${formatConsoleArgs(values)}\n`;
    },
    log: (...values) => {
      stdout += `${formatConsoleArgs(values)}\n`;
    },
  };

  yield* run(args).pipe(
    Effect.provide(cliLayer),
    Effect.provideService(Console.Console, capturedConsole),
    Effect.catchTag("ShowHelp", (error) =>
      Effect.sync(() => {
        exitCode = error.errors.length > 0 ? 1 : 0;
      }),
    ),
  );

  const handlerResult = yield* Ref.get(resultRef);

  if (handlerResult.stdout.length > 0 || handlerResult.stderr.length > 0) {
    return handlerResult;
  }

  return {
    exitCode,
    stderr,
    stdout,
  };
});

const makeCommand = (resultRef: Ref.Ref<CliResult>) => {
  const jsonFlag = Flag.boolean("json");
  const applyFlag = Flag.boolean("apply");

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
  const diffConfigCommand = Command.make(
    "config",
    {
      host: Flag.string("host"),
      json: jsonFlag,
    },
    (options) =>
      Effect.gen(function* () {
        const left = yield* CodexConfigFile.readConfig({
          target: {
            type: "local",
          },
        });
        const right = yield* CodexConfigFile.readConfig({
          target: {
            alias: options.host,
            type: "ssh",
          },
        });
        const preview = yield* CodexConfigDiff.preview({
          left,
          right,
        });
        const output = withDiffTargets(preview, options.host);
        const stdout = options.json ? renderJson(output) : renderDiffPreview(output);

        yield* Ref.set(resultRef, success(stdout));
      }),
  );
  const diffCodex = Command.make("codex").pipe(Command.withSubcommands([diffConfigCommand]));
  const diff = Command.make("diff").pipe(Command.withSubcommands([diffCodex]));

  const syncConfigCommand = (direction: CodexConfigFile.SyncDirection) =>
    Command.make(
      "config",
      {
        apply: applyFlag,
        host: Flag.string("host").pipe(Flag.optional),
        json: jsonFlag,
      },
      (options) =>
        Effect.gen(function* () {
          const host = Option.getOrUndefined(options.host);

          if (host === undefined) {
            yield* Ref.set(resultRef, failure("--host is required for push/pull.", 2));
            return;
          }

          const result = yield* CodexConfigFile.syncConfig({
            direction,
            host,
            mode: options.apply ? "apply" : "preview",
          });
          const stdout = options.json ? renderJson(result) : renderSyncResult(result);
          const exitCode = result.error === undefined ? 0 : 1;

          yield* Ref.set(resultRef, { exitCode, stderr: "", stdout });
        }),
    );
  const pushCodex = Command.make("codex").pipe(
    Command.withSubcommands([syncConfigCommand("push")]),
  );
  const push = Command.make("push").pipe(Command.withSubcommands([pushCodex]));
  const pullCodex = Command.make("codex").pipe(
    Command.withSubcommands([syncConfigCommand("pull")]),
  );
  const pull = Command.make("pull").pipe(Command.withSubcommands([pullCodex]));

  return Command.make("agenv").pipe(Command.withSubcommands([list, inspect, diff, push, pull]));
};

const success = (stdout: string): CliResult => ({
  exitCode: 0,
  stderr: "",
  stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n`,
});

const failure = (stderr: string, exitCode: number): CliResult => ({
  exitCode,
  stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n`,
  stdout: "",
});

const emptyResult: CliResult = {
  exitCode: 0,
  stderr: "",
  stdout: "",
};

const formatConsoleArgs = (args: ReadonlyArray<unknown>) =>
  args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");

const renderJson = (value: unknown) => `${JSON.stringify(value, undefined, 2)}\n`;

const renderHosts = (inventory: MachineInventory.Inventory) => {
  if (inventory.machines.length === 0) {
    return "Hosts\nNo SSH-known Hosts found.\n";
  }

  const rows = inventory.machines.map((host) =>
    host.state === "resolved"
      ? [
          host.alias,
          host.state,
          host.hostName,
          host.user,
          String(host.port),
          `${host.source.kind}:${host.source.path}`,
          "",
        ]
      : [host.alias, host.state, "", "", "", `${host.source.kind}:${host.source.path}`, host.error],
  );
  const header = ["Alias", "State", "HostName", "User", "Port", "Source", "Error"];
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

const renderSyncResult = (result: CodexConfigFile.SyncConfigResult) => {
  const lines = [];

  if (result.diff.length > 0) {
    lines.push(result.diff.trimEnd());
  } else {
    lines.push("No changes.");
  }

  if (result.error !== undefined) {
    lines.push(result.error);
  } else if (result.mode === "apply" && result.applied) {
    lines.push("Applied and verified.");
  } else if (result.mode === "apply") {
    lines.push("No changes.");
  }

  return `${lines.join("\n")}\n`;
};

interface LocalDiffSnapshotMetadata extends CodexConfigDiffSnapshotMetadata {
  readonly target: {
    readonly type: "local";
  };
}

interface SshDiffSnapshotMetadata extends CodexConfigDiffSnapshotMetadata {
  readonly target: {
    readonly alias: string;
    readonly type: "ssh";
  };
}

interface DiffPreviewOutput {
  readonly diff: string | null;
  readonly left: LocalDiffSnapshotMetadata;
  readonly reason: string | null;
  readonly right: SshDiffSnapshotMetadata;
}

const withDiffTargets = (preview: CodexConfigDiffPreview, host: string): DiffPreviewOutput => ({
  diff: preview.diff,
  left: {
    ...preview.left,
    target: {
      type: "local",
    },
  },
  reason: preview.reason,
  right: {
    ...preview.right,
    target: {
      alias: host,
      type: "ssh",
    },
  },
});

const renderDiffPreview = (preview: DiffPreviewOutput) => {
  const lines = [
    "Codex Config Diff",
    "Left: local",
    "Right: host",
    `Host: ${preview.right.target.alias}`,
  ];

  if (preview.diff !== null) {
    return [...lines, "", preview.diff].join("\n");
  }

  return [
    ...lines,
    "",
    `No textual diff available: ${preview.reason}`,
    "",
    ...renderDiffSnapshot("Left", preview.left),
    "",
    ...renderDiffSnapshot("Right", preview.right),
  ].join("\n");
};

const renderDiffSnapshot = (
  label: string,
  snapshot: LocalDiffSnapshotMetadata | SshDiffSnapshotMetadata,
) => [
  label,
  `State: ${snapshot.state}`,
  `Path: ${snapshot.path}`,
  ...(snapshot.error === undefined ? [] : [`Error: ${snapshot.error}`]),
];

const liveLayer = Layer.mergeAll(
  AgentFileSystem.layer(
    (path) =>
      Effect.tryPromise({
        catch: AgentFileSystem.classifyReadFailure,
        try: () => readFile(path, "utf8"),
      }),
    (path, contents) =>
      Effect.tryPromise({
        catch: AgentFileSystem.classifyReadFailure,
        try: async () => {
          await mkdir(dirname(path), {
            recursive: true,
          });
          const temporaryPath = join(dirname(path), `.agenv-config.toml.${process.pid}.tmp`);
          await writeFile(temporaryPath, contents, {
            mode: 0o600,
          });
          await rename(temporaryPath, path);
        },
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
