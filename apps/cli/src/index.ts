#!/usr/bin/env node
import {
  AgentFileSystem,
  CodexConfigDiff,
  CodexConfigFile,
  InstalledSkills,
  MachineInventory,
  ManagedFileSnapshot,
  OpenSsh,
  PackageManagerDiagnostics,
} from "@agenv/core";
import type { CodexConfigDiffPreview, CodexConfigDiffSnapshotMetadata } from "@agenv/core";
import { Console, Effect, FileSystem, Layer, Option, Path, Ref, Stdio, Terminal } from "effect";
import type { Console as EffectConsole } from "effect/Console";
import { CliOutput, Command, Flag } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
  const rawFlag = Flag.boolean("raw");
  const skillToolFlag = Flag.choice("tool", ["claude-code", "codex", "opencode"] as const).pipe(
    Flag.optional,
  );

  const hosts = Command.make("hosts", { json: jsonFlag }, (config) =>
    Effect.gen(function* () {
      const inventory = yield* MachineInventory.list();
      const stdout = config.json
        ? renderJson({ hosts: inventory.machines })
        : renderHosts(inventory);

      yield* Ref.set(resultRef, success(stdout));
    }),
  );
  const skills = Command.make("skills", { json: jsonFlag, tool: skillToolFlag }, (config) =>
    Effect.gen(function* () {
      const tool = Option.getOrUndefined(config.tool);
      const inventory = yield* InstalledSkills.list({
        target: {
          type: "local",
        },
        ...(tool === undefined ? {} : { tool }),
      });
      const stdout = config.json
        ? renderJson({ skills: inventory.skills, sources: inventory.sources })
        : renderSkills(inventory);

      yield* Ref.set(resultRef, success(stdout));
    }),
  );
  const list = Command.make("list").pipe(Command.withSubcommands([hosts, skills]));

  const configCommand = Command.make(
    "config",
    {
      host: Flag.string("host").pipe(Flag.optional),
      json: jsonFlag,
      raw: rawFlag,
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
        const stdout = options.json
          ? renderJson(options.raw ? snapshot : redactSnapshot(snapshot))
          : renderSnapshot(snapshot, host, {
              raw: options.raw,
            });

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
      raw: rawFlag,
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
        const stdout = options.json
          ? renderJson(options.raw ? output : redactDiffPreviewOutput(output))
          : renderDiffPreview(output, {
              raw: options.raw,
            });

        yield* Ref.set(resultRef, success(stdout));
      }),
  );
  const diffCodex = Command.make("codex").pipe(Command.withSubcommands([diffConfigCommand]));
  const diff = Command.make("diff").pipe(Command.withSubcommands([diffCodex]));
  const packageManagerConfigCommand = Command.make(
    "package-manager-config",
    {
      json: jsonFlag,
    },
    (options) =>
      Effect.gen(function* () {
        const diagnostics = yield* PackageManagerDiagnostics.inspectPackageManagerConfigs();
        const stdout = options.json
          ? renderJson(diagnostics)
          : renderPackageManagerConfigDiagnostics(diagnostics);

        yield* Ref.set(resultRef, success(stdout));
      }),
  );
  const diagnostics = Command.make("diagnostics").pipe(
    Command.withSubcommands([packageManagerConfigCommand]),
  );

  const syncConfigCommand = (direction: CodexConfigFile.SyncDirection) =>
    Command.make(
      "config",
      {
        apply: applyFlag,
        host: Flag.string("host").pipe(Flag.optional),
        json: jsonFlag,
        raw: rawFlag,
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
          const stdout = options.json
            ? renderJson(options.raw ? result : redactSyncResult(result))
            : renderSyncResult(result, {
                raw: options.raw,
              });
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

  return Command.make("agenv").pipe(
    Command.withSubcommands([list, inspect, diff, diagnostics, push, pull]),
  );
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

const renderSkills = (inventory: InstalledSkills.InstalledSkillsInventory) => {
  const rows = [
    ...inventory.skills.map((skill) => [
      skill.agent,
      skill.name,
      skill.source.scope,
      skill.source.state,
      skill.metadataState,
      skill.path,
    ]),
    ...inventory.sources
      .filter((source) => source.state !== "scanned")
      .map((source) => [source.agent, "<source>", source.scope, source.state, "", source.path]),
  ];

  if (rows.length === 0) {
    return "Skills\nNo installed Skills found.\n";
  }

  const header = ["Agent", "Name", "Scope", "SourceState", "MetadataState", "Path"];
  const widths = header.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  return [
    "Skills",
    renderRow(header),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(renderRow),
  ].join("\n");
};

const renderSnapshot = (
  snapshot: ManagedFileSnapshot.ManagedFileSnapshot,
  host: string | undefined,
  options: RenderSecretOptions,
) => {
  const lines = [
    "Codex Config File",
    `Target: ${host === undefined ? "local" : "Host"}`,
    ...(host === undefined ? [] : [`Host: ${host}`]),
    `State: ${snapshot.state}`,
    `Path: ${snapshot.path}`,
  ];

  if (snapshot.state === "present") {
    if (options.raw) {
      return [
        ...lines,
        "Redaction: off (--raw may expose config secrets)",
        "",
        snapshot.contents,
      ].join("\n");
    }

    const safeSnapshot = redactPresentSnapshot(snapshot);

    return [
      ...lines,
      "Redaction: on (use --raw only when you intend to expose config secrets)",
      `Bytes: ${safeSnapshot.contentByteCount}`,
      `SHA-256: ${safeSnapshot.contentSha256}`,
      `Sensitive values redacted: ${safeSnapshot.contentsRedacted ? "yes" : "no"}`,
      "",
      safeSnapshot.contentsPreview,
    ].join("\n");
  }

  return [...lines, `Error: ${snapshot.error}`].join("\n");
};

const renderSyncResult = (
  result: CodexConfigFile.SyncConfigResult,
  options: RenderSecretOptions,
) => {
  const lines = [];

  if (result.diff.length > 0) {
    lines.push(
      options.raw
        ? "Redaction: off (--raw may expose config secrets)"
        : "Redaction: on (use --raw only when you intend to expose config secrets)",
    );
    lines.push((options.raw ? result.diff : redactDiff(result.diff)).trimEnd());
  } else {
    lines.push("No changes.");
  }

  if (result.error !== undefined) {
    lines.push(result.error);
  } else if (result.mode === "apply" && result.changed && result.applied) {
    lines.push("Applied and verified.");
  }

  return `${lines.join("\n")}\n`;
};

const renderPackageManagerConfigDiagnostics = (
  report: PackageManagerDiagnostics.DiagnosticsReport,
) => {
  const lines = ["Package Manager Config Diagnostics"];

  for (const diagnostic of report.packageManagerConfigs) {
    lines.push("", `${diagnostic.packageManager}: ${diagnostic.status}`);
    lines.push(`Source: ${diagnostic.source}`);

    if (diagnostic.output.trim().length > 0) {
      lines.push("Output:", diagnostic.output.trimEnd());
    } else {
      lines.push("Output: <empty>");
    }

    if (diagnostic.stderr.trim().length > 0) {
      lines.push("Stderr:", diagnostic.stderr.trimEnd());
    }

    if (diagnostic.error !== undefined) {
      lines.push(`Error: ${diagnostic.error}`);
    }
  }

  return lines.join("\n");
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
  readonly changed: boolean;
  readonly diff: string | null;
  readonly left: LocalDiffSnapshotMetadata;
  readonly reason: string | null;
  readonly right: SshDiffSnapshotMetadata;
}

const withDiffTargets = (preview: CodexConfigDiffPreview, host: string): DiffPreviewOutput => ({
  changed: preview.changed,
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

const renderDiffPreview = (preview: DiffPreviewOutput, options: RenderSecretOptions) => {
  const lines = [
    "Codex Config Diff",
    "Left: local",
    "Right: host",
    `Host: ${preview.right.target.alias}`,
    options.raw
      ? "Redaction: off (--raw may expose config secrets)"
      : "Redaction: on (use --raw only when you intend to expose config secrets)",
  ];

  if (preview.diff !== null) {
    return [...lines, "", options.raw ? preview.diff : redactDiff(preview.diff)].join("\n");
  }

  if (!preview.changed) {
    return [...lines, "", "No changes."].join("\n");
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

interface RenderSecretOptions {
  readonly raw: boolean;
}

type PresentManagedFileSnapshot = Extract<
  ManagedFileSnapshot.ManagedFileSnapshot,
  { readonly state: "present" }
>;

type SafePresentManagedFileSnapshot = Omit<PresentManagedFileSnapshot, "contents"> & {
  readonly contentByteCount: number;
  readonly contentSha256: string;
  readonly contentsPreview: string;
  readonly contentsRedacted: boolean;
};

type SafeManagedFileSnapshot =
  | SafePresentManagedFileSnapshot
  | Exclude<ManagedFileSnapshot.ManagedFileSnapshot, { readonly state: "present" }>;

interface SafeDiffPreviewOutput extends Omit<DiffPreviewOutput, "diff"> {
  readonly diff: string | null;
  readonly diffRedacted: boolean;
}

interface SafeSyncConfigResult extends Omit<
  CodexConfigFile.SyncConfigResult,
  "destination" | "source"
> {
  readonly destination: SafeManagedFileSnapshot;
  readonly diffRedacted: boolean;
  readonly source: SafeManagedFileSnapshot;
}

const redactedTomlValue = '"<redacted>"';
const sensitiveKeyParts = new Set([
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "passwd",
  "password",
  "secret",
  "session",
  "token",
]);
const tokenLikeValuePattern =
  /\b(?:sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{6,})\b/g;

const redactSnapshot = (
  snapshot: ManagedFileSnapshot.ManagedFileSnapshot,
): SafeManagedFileSnapshot => {
  if (snapshot.state !== "present") {
    return snapshot;
  }

  return redactPresentSnapshot(snapshot);
};

const redactPresentSnapshot = (
  snapshot: PresentManagedFileSnapshot,
): SafePresentManagedFileSnapshot => {
  const contentsPreview = redactTomlContents(snapshot.contents);

  return {
    configFamily: snapshot.configFamily,
    contentByteCount: Buffer.byteLength(snapshot.contents, "utf8"),
    contentSha256: createHash("sha256").update(snapshot.contents).digest("hex"),
    contentsPreview,
    contentsRedacted: contentsPreview !== snapshot.contents,
    managedFile: snapshot.managedFile,
    path: snapshot.path,
    state: snapshot.state,
  };
};

const redactDiffPreviewOutput = (preview: DiffPreviewOutput): SafeDiffPreviewOutput => {
  const diff = preview.diff === null ? null : redactDiff(preview.diff);

  return {
    ...preview,
    diff,
    diffRedacted: preview.diff !== diff,
  };
};

const redactSyncResult = (result: CodexConfigFile.SyncConfigResult): SafeSyncConfigResult => {
  const diff = redactDiff(result.diff);

  return {
    ...result,
    destination: redactSnapshot(result.destination),
    diff,
    diffRedacted: diff !== result.diff,
    source: redactSnapshot(result.source),
  };
};

const redactDiff = (diff: string) => {
  const redactor = createTomlLineRedactor();

  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) {
        return line;
      }

      const prefix = line[0];

      if (prefix === "+" || prefix === "-" || prefix === " ") {
        return `${prefix}${redactor.redactLine(line.slice(1))}`;
      }

      return redactor.redactLine(line);
    })
    .join("\n");
};

const redactTomlContents = (contents: string) => {
  const redactor = createTomlLineRedactor();

  return contents
    .split("\n")
    .map((line) => redactor.redactLine(line))
    .join("\n");
};

const createTomlLineRedactor = () => {
  let inEnvTable = false;
  let redactingMultilineSecret = false;
  let multilineDelimiter: string | undefined;

  const redactLine = (line: string): string => {
    if (redactingMultilineSecret) {
      if (multilineDelimiter !== undefined && line.includes(multilineDelimiter)) {
        redactingMultilineSecret = false;
        multilineDelimiter = undefined;
      }

      return "<redacted>";
    }

    const section = parseTomlSection(line);

    if (section !== undefined) {
      inEnvTable = section.some((part) => part === "env");
      return redactSecretFragments(line);
    }

    const assignment = parseTomlAssignment(line);

    if (assignment === undefined) {
      return redactSecretFragments(line);
    }

    const forceRedact = inEnvTable || isEnvKey(assignment.key) || isSensitiveKey(assignment.key);

    if (forceRedact || hasTokenLikeValue(assignment.value)) {
      const trimmedValue = assignment.value.trimStart();
      const delimiter = trimmedValue.startsWith('"""')
        ? '"""'
        : trimmedValue.startsWith("'''")
          ? "'''"
          : undefined;

      if (delimiter !== undefined && trimmedValue.indexOf(delimiter, delimiter.length) === -1) {
        redactingMultilineSecret = true;
        multilineDelimiter = delimiter;
      }

      return `${assignment.prefix}${redactedTomlValue}${assignment.comment}`;
    }

    return `${assignment.prefix}${redactSecretFragments(assignment.value)}${assignment.comment}`;
  };

  return {
    redactLine,
  };
};

const parseTomlSection = (line: string) => {
  const match = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*(?:#.*)?$/);

  if (match?.[1] === undefined) {
    return undefined;
  }

  return keyParts(match[1]);
};

const parseTomlAssignment = (line: string) => {
  const match = line.match(/^(\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*)(.*?)(\s*(?:#.*)?)$/);

  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }

  return {
    comment: match[3],
    key: match[1].slice(0, match[1].lastIndexOf("=")).trim(),
    prefix: match[1],
    value: match[2],
  };
};

const isEnvKey = (key: string) => keyParts(key).some((part) => part === "env");

const isSensitiveKey = (key: string) => {
  const parts = keyParts(key);

  if (parts.some((part) => sensitiveKeyParts.has(part))) {
    return true;
  }

  const compactKey = parts.join("");

  return (
    compactKey.includes("apikey") ||
    compactKey.includes("accesstoken") ||
    compactKey.includes("refreshtoken") ||
    compactKey.includes("privatekey")
  );
};

const keyParts = (key: string) =>
  key
    .replaceAll(/["']/g, "")
    .toLowerCase()
    .split(/[._-]+/)
    .filter((part) => part.length > 0);

const hasTokenLikeValue = (value: string) => {
  tokenLikeValuePattern.lastIndex = 0;
  return tokenLikeValuePattern.test(value) || value.includes("-----BEGIN ");
};

const redactSecretFragments = (value: string) => {
  tokenLikeValuePattern.lastIndex = 0;
  return value
    .replace(tokenLikeValuePattern, "<redacted>")
    .replaceAll(/-----BEGIN [^-]+-----/g, "<redacted>");
};

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
    (path) =>
      Effect.tryPromise({
        catch: AgentFileSystem.classifyReadFailure,
        try: async () =>
          (await readdir(path, { withFileTypes: true })).map((entry) => ({
            isDirectory: entry.isDirectory(),
            name: entry.name,
          })),
      }),
  ),
  OpenSsh.liveLayer,
  PackageManagerDiagnostics.liveLayer,
  MachineInventory.liveLayer({
    sshConfigPath: join(process.env.HOME ?? homedir(), ".ssh", "config"),
  }),
  InstalledSkills.liveLayer,
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
