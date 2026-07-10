import { Context, Effect, Layer } from "effect";
import { join } from "node:path";
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

export interface ListOptions {
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
  const sourcePlans = (options.sourcePlans ?? localSourcePlans()).filter(
    (plan) => options.tool === undefined || plan.agent === options.tool,
  );
  const sources: InstalledSkillSource[] = [];
  const skills: InstalledSkill[] = [];

  for (const plan of sourcePlans) {
    const entriesResult = yield* fileSystem.readDirectory(plan.path).pipe(
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
      const skillPath = join(plan.path, entry.name);
      const skillFilePath = join(skillPath, "SKILL.md");
      const metadata = yield* fileSystem.readFile(skillFilePath).pipe(
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
  failure: AgentFileSystem.FileReadFailure,
): InstalledSkillSource => ({
  agent: plan.agent,
  error: failure.message,
  path: plan.path,
  scope: plan.scope,
  state: failure instanceof AgentFileSystem.FileNotFound ? "missing" : "unreadable",
});

const localSourcePlans = (): readonly SourcePlan[] => [
  {
    agent: "claude-code",
    path: join(process.cwd(), ".claude", "skills"),
    scope: "project",
  },
  {
    agent: "claude-code",
    path: join(process.env.HOME ?? "", ".claude", "skills"),
    scope: "user",
  },
  {
    agent: "codex",
    path: join(process.cwd(), ".agents", "skills"),
    scope: "project",
  },
  {
    agent: "codex",
    path: join(process.env.HOME ?? "", ".agents", "skills"),
    scope: "user",
  },
  {
    agent: "codex",
    path: "/etc/codex/skills",
    scope: "system",
  },
  {
    agent: "opencode",
    path: join(process.cwd(), ".opencode", "skills"),
    scope: "project",
  },
  {
    agent: "opencode",
    path: join(process.env.HOME ?? "", ".config", "opencode", "skills"),
    scope: "user",
  },
  {
    agent: "opencode",
    path: join(process.cwd(), ".claude", "skills"),
    scope: "project",
  },
  {
    agent: "opencode",
    path: join(process.env.HOME ?? "", ".claude", "skills"),
    scope: "user",
  },
  {
    agent: "opencode",
    path: join(process.cwd(), ".agents", "skills"),
    scope: "project",
  },
  {
    agent: "opencode",
    path: join(process.env.HOME ?? "", ".agents", "skills"),
    scope: "user",
  },
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

  for (const line of frontmatter) {
    if (line.trim().length === 0) {
      continue;
    }

    const match = /^(name|description):\s*(.*)$/.exec(line);

    if (match === null || match[1] === undefined || match[2] === undefined) {
      return { metadataState: "invalid-frontmatter" };
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
