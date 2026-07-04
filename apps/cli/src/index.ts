#!/usr/bin/env node
import {
  AgentFileSystem,
  CodexConfigFile,
  MachineInventory,
  ManagedFileSnapshot,
  OpenSsh,
} from "@agenv/core";
import { Console, Effect, Layer } from "effect";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface ParsedCommand {
  readonly host?: string;
  readonly json: boolean;
  readonly kind: "list-hosts" | "inspect-codex-config";
}

export const runCli = Effect.fn("Cli.runCli")(function* (args: readonly string[]) {
  const parsed = parseArgs(args);

  if (parsed.kind === "list-hosts") {
    const inventory = yield* MachineInventory.list();

    return success(
      parsed.json ? renderJson({ hosts: inventory.machines }) : renderHosts(inventory),
    );
  }

  const snapshot = yield* CodexConfigFile.readConfig({
    target:
      parsed.host === undefined
        ? {
            type: "local",
          }
        : {
            alias: parsed.host,
            type: "ssh",
          },
  });

  return success(parsed.json ? renderJson(snapshot) : renderSnapshot(snapshot, parsed.host));
});

const parseArgs = (args: readonly string[]): ParsedCommand => {
  const json = args.includes("--json");
  const host = optionValue(args, "--host");
  const positional = args.filter((arg) => !arg.startsWith("--") && !isOptionValue(args, arg));
  const command = positional.join(" ");

  if (command === "list hosts") {
    return {
      json,
      kind: "list-hosts",
    };
  }

  if (command === "inspect codex config") {
    return {
      ...(host === undefined ? {} : { host }),
      json,
      kind: "inspect-codex-config",
    };
  }

  throw new Error(`Unknown command: ${args.join(" ")}`);
};

const optionValue = (args: readonly string[], option: string) => {
  const index = args.indexOf(option);

  if (index === -1) {
    return undefined;
  }

  return args.at(index + 1);
};

const isOptionValue = (args: readonly string[], value: string) => {
  const index = args.indexOf(value);

  return args.at(index - 1) === "--host";
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
