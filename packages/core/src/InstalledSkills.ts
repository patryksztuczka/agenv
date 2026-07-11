import { Context, Effect, Layer } from "effect";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { DirectoryEntry } from "./AgentFileSystem.js";
import * as AgentFileSystem from "./AgentFileSystem.js";
import * as OpenSsh from "./OpenSsh.js";

export type SkillsTarget =
  | { readonly type: "local" }
  | { readonly alias: string; readonly type: "ssh" };
export type SkillAgent = "claude-code" | "codex" | "opencode";
export type SkillSourceScope = "project" | "user" | "system";
export type SkillSourceState = "scanned" | "missing" | "unreadable" | "connection-failed";
export type SkillMetadataState =
  | "parsed"
  | "missing-frontmatter"
  | "invalid-frontmatter"
  | "unreadable";

export interface InstalledSkillsInventory {
  readonly skills: readonly InstalledSkill[];
  readonly sources: readonly InstalledSkillSource[];
  readonly target: SkillsTarget;
}

export interface InstalledSkillSource {
  readonly agent: SkillAgent;
  readonly error?: string;
  readonly path: string;
  readonly scope: SkillSourceScope;
  readonly state: SkillSourceState;
}

export interface InstalledSkill {
  readonly agent: SkillAgent;
  readonly description?: string;
  readonly error?: string;
  readonly metadataState: SkillMetadataState;
  readonly name: string;
  readonly path: string;
  readonly skillFilePath: string;
  readonly source: InstalledSkillSource;
}

export interface SourcePlan {
  readonly agent: SkillAgent;
  readonly path: string;
  readonly scope: SkillSourceScope;
}

type SkillReadFailure = AgentFileSystem.FileReadFailure | OpenSsh.RemoteFileReadFailure;

interface DirectoryReader {
  readonly readDirectory: (
    path: string,
  ) => Effect.Effect<readonly DirectoryEntry[], SkillReadFailure>;
  readonly readFile: (path: string) => Effect.Effect<string, SkillReadFailure>;
}

export interface ListOptions {
  readonly projectPath?: string;
  readonly sourcePlans?: readonly SourcePlan[];
  readonly target: SkillsTarget;
  readonly tool?: SkillAgent;
}

export class InstalledSkillsService extends Context.Service<
  InstalledSkillsService,
  {
    readonly list: (
      options: ListOptions,
    ) => Effect.Effect<
      InstalledSkillsInventory,
      never,
      AgentFileSystem.AgentFileSystem | OpenSsh.OpenSsh
    >;
  }
>()("InstalledSkillsService") {}

export const layer = (inventory: InstalledSkillsInventory) =>
  Layer.succeed(InstalledSkillsService)({
    list: (options) =>
      Effect.succeed(
        options.tool === undefined
          ? inventory
          : {
              ...inventory,
              skills: inventory.skills.filter((skill) => skill.agent === options.tool),
              sources: inventory.sources.filter((source) => source.agent === options.tool),
            },
      ),
  });

export const liveLayer = Layer.succeed(InstalledSkillsService)({
  list: (options) => load(options),
});

export const list = Effect.fn("InstalledSkills.list")(function* (options: ListOptions) {
  const service = yield* InstalledSkillsService;

  return yield* service.list(options);
});

export const load = Effect.fn("InstalledSkills.load")(function* (options: ListOptions) {
  const fileSystem = yield* AgentFileSystem.AgentFileSystem;
  const reader =
    options.target.type === "local"
      ? localReader(fileSystem)
      : remoteReader(options.target.alias, yield* OpenSsh.OpenSsh);
  const sourcePlans = (options.sourcePlans ?? plannedSources(options)).filter(
    (plan) => options.tool === undefined || plan.agent === options.tool,
  );
  const sources: InstalledSkillSource[] = [];
  const skills: InstalledSkill[] = [];

  for (const plan of sourcePlans) {
    const entriesResult = yield* reader.readDirectory(plan.path).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure, type: "failure" as const }),
        onSuccess: (entries) => ({ entries, type: "success" as const }),
      }),
    );

    if (entriesResult.type === "failure") {
      const source = sourceFromFailure(plan, entriesResult.failure);
      sources.push(source);
      continue;
    }

    const source: InstalledSkillSource = {
      agent: plan.agent,
      path: plan.path,
      scope: plan.scope,
      state: "scanned",
    };
    sources.push(source);

    for (const entry of entriesResult.entries.filter((candidate) => candidate.isDirectory)) {
      const skillPath = pathJoin(options.target, plan.path, entry.name);
      const skillFilePath = pathJoin(options.target, skillPath, "SKILL.md");
      const metadata = yield* reader.readFile(skillFilePath).pipe(
        Effect.match({
          onFailure: (failure) => ({
            description: undefined,
            metadataState: "unreadable" as const,
            name: entry.name,
            error: failure.message,
          }),
          onSuccess: parseSkillMetadata,
        }),
      );

      const skill: InstalledSkill = {
        agent: plan.agent,
        ...(metadata.error === undefined ? {} : { error: metadata.error }),
        metadataState: metadata.metadataState,
        name: metadata.name ?? entry.name,
        path: skillPath,
        skillFilePath,
        source,
      };

      skills.push(
        metadata.description === undefined
          ? skill
          : {
              ...skill,
              description: metadata.description,
            },
      );
    }
  }

  return {
    skills,
    sources,
    target: options.target,
  };
});

const sourceFromFailure = (
  plan: SourcePlan,
  failure: AgentFileSystem.FileReadFailure | OpenSsh.RemoteFileReadFailure,
): InstalledSkillSource => ({
  agent: plan.agent,
  error: failure.message,
  path: plan.path,
  scope: plan.scope,
  state:
    failure instanceof OpenSsh.ConnectionFailed
      ? "connection-failed"
      : failure instanceof AgentFileSystem.FileNotFound ||
          failure instanceof OpenSsh.RemoteFileNotFound
        ? "missing"
        : "unreadable",
});

const localReader = (
  fileSystem: typeof AgentFileSystem.AgentFileSystem.Service,
): DirectoryReader => ({
  readDirectory: fileSystem.readDirectory,
  readFile: fileSystem.readFile,
});

const remoteReader = (alias: string, openSsh: typeof OpenSsh.OpenSsh.Service): DirectoryReader => ({
  readDirectory: (path) => openSsh.readDirectory(alias, path),
  readFile: (path) => openSsh.readFile(alias, path),
});

const pathJoin = (target: SkillsTarget, ...parts: readonly string[]) =>
  target.type === "local" ? join(...parts) : posix.join(...parts);

const plannedSources = (options: ListOptions) =>
  options.target.type === "local"
    ? localSourcePlans(options.projectPath)
    : sshSourcePlans(options.projectPath);

const localSourcePlans = (projectPath: string | undefined): readonly SourcePlan[] => {
  const projectRoot =
    projectPath === undefined || projectPath.length === 0 ? process.cwd() : projectPath;
  const homeRoot = localHomeDirectory();
  const userSource = (agent: SkillAgent, ...parts: readonly string[]): readonly SourcePlan[] =>
    homeRoot === undefined
      ? []
      : [
          {
            agent,
            path: join(homeRoot, ...parts),
            scope: "user",
          },
        ];

  return [
    {
      agent: "claude-code",
      path: join(projectRoot, ".claude", "skills"),
      scope: "project",
    },
    ...userSource("claude-code", ".claude", "skills"),
    {
      agent: "codex",
      path: join(projectRoot, ".agents", "skills"),
      scope: "project",
    },
    ...userSource("codex", ".agents", "skills"),
    {
      agent: "codex",
      path: "/etc/codex/skills",
      scope: "system",
    },
    {
      agent: "opencode",
      path: join(projectRoot, ".opencode", "skills"),
      scope: "project",
    },
    ...userSource("opencode", ".config", "opencode", "skills"),
    {
      agent: "opencode",
      path: join(projectRoot, ".claude", "skills"),
      scope: "project",
    },
    ...userSource("opencode", ".claude", "skills"),
    {
      agent: "opencode",
      path: join(projectRoot, ".agents", "skills"),
      scope: "project",
    },
    ...userSource("opencode", ".agents", "skills"),
  ];
};

const localHomeDirectory = () => {
  const directory =
    process.env.HOME === undefined || process.env.HOME.length === 0 ? homedir() : process.env.HOME;

  return directory.length === 0 ? undefined : directory;
};

const sshSourcePlans = (projectPath: string | undefined): readonly SourcePlan[] => [
  ...(projectPath === undefined
    ? []
    : [
        {
          agent: "claude-code" as const,
          path: posix.join(projectPath, ".claude", "skills"),
          scope: "project" as const,
        },
        {
          agent: "codex" as const,
          path: posix.join(projectPath, ".agents", "skills"),
          scope: "project" as const,
        },
        {
          agent: "opencode" as const,
          path: posix.join(projectPath, ".opencode", "skills"),
          scope: "project" as const,
        },
        {
          agent: "opencode" as const,
          path: posix.join(projectPath, ".claude", "skills"),
          scope: "project" as const,
        },
        {
          agent: "opencode" as const,
          path: posix.join(projectPath, ".agents", "skills"),
          scope: "project" as const,
        },
      ]),
  { agent: "claude-code", path: "~/.claude/skills", scope: "user" },
  { agent: "codex", path: "~/.agents/skills", scope: "user" },
  {
    agent: "codex",
    path: "/etc/codex/skills",
    scope: "system",
  },
  { agent: "opencode", path: "~/.config/opencode/skills", scope: "user" },
  { agent: "opencode", path: "~/.claude/skills", scope: "user" },
  { agent: "opencode", path: "~/.agents/skills", scope: "user" },
];

interface ParsedSkillMetadata {
  readonly description?: string;
  readonly error?: string;
  readonly metadataState: SkillMetadataState;
  readonly name?: string;
}

const parseSkillMetadata = (contents: string): ParsedSkillMetadata => {
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) {
    return { metadataState: "missing-frontmatter" };
  }

  const newline = contents.startsWith("---\r\n") ? "\r\n" : "\n";
  const closing = contents.indexOf(`${newline}---`, 4);

  if (closing === -1) {
    return { metadataState: "invalid-frontmatter" };
  }

  const metadata: { description?: string; name?: string } = {};
  const frontmatter = contents.slice(4, closing).split(/\r?\n/);
  let skippingUnsupportedBlock = false;

  for (const line of frontmatter) {
    if (line.trim().length === 0) {
      continue;
    }

    if (/^\s/.test(line)) {
      if (skippingUnsupportedBlock) {
        continue;
      }

      return { metadataState: "invalid-frontmatter" };
    }

    skippingUnsupportedBlock = false;

    const match = /^([^:]+):\s*(.*)$/.exec(line);

    if (match === null || match[1] === undefined || match[2] === undefined) {
      return { metadataState: "invalid-frontmatter" };
    }

    if (match[1] !== "name" && match[1] !== "description") {
      skippingUnsupportedBlock = true;
      continue;
    }

    const value = parseScalar(match[2]);

    if (value === undefined) {
      return { metadataState: "invalid-frontmatter" };
    }

    metadata[match[1] as "description" | "name"] = value;
  }

  return {
    ...metadata,
    metadataState: "parsed",
  };
};

const parseScalar = (value: string) => {
  const trimmed = value.trim();

  if (
    trimmed.length === 0 ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{") ||
    trimmed.includes(": ")
  ) {
    return undefined;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};
