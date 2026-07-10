import { serve } from "@hono/node-server";
import {
  AgentFileSystem,
  CodexConfigFile,
  InstalledSkills,
  MachineInventory,
  OpenSsh,
} from "@agenv/core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ApiOptions {
  /**
   * Application services available to every HTTP handler.
   *
   * Hono is the JavaScript framework boundary; Effect services are built once
   * into a ManagedRuntime inside `createApp` and reused for each request.
   */
  readonly layer: Layer.Layer<
    | AgentFileSystem.AgentFileSystem
    | InstalledSkills.InstalledSkillsService
    | MachineInventory.MachineInventoryService
    | OpenSsh.OpenSsh
  >;
}

export type ConfigSnapshotTarget =
  | { readonly type: "local" }
  | { readonly alias: string; readonly type: "ssh" };

/**
 * Builds the local agenv HTTP API.
 *
 * The API intentionally exposes resource-shaped endpoints for clients and
 * keeps domain behavior in `@agenv/core`. Handlers should run Effect programs
 * through the app runtime rather than directly performing domain work.
 */
export const createApp = (options: ApiOptions) => {
  const app = new Hono();
  const runtime = ManagedRuntime.make(options.layer);

  app.get("/health", (context) => context.json({ ok: true }));

  app.get("/hello/:name", async (context) => {
    const greeting = await Effect.runPromise(getGreeting(context.req.param("name")));

    return context.json(greeting);
  });

  app.get("/machines", async (context) =>
    context.json(await runtime.runPromise(MachineInventory.list())),
  );

  app.get("/codex/config", async (context) => {
    const target = parseConfigTarget(context.req.query("target"), context.req.query("alias"));

    if (target === undefined) {
      return context.json(
        {
          error: "target must be local or ssh with alias",
        },
        400,
      );
    }

    const snapshot = await runtime.runPromise(
      CodexConfigFile.readConfig({
        localConfigPath: join(homeDirectory(), ".codex", "config.toml"),
        target,
      }),
    );

    return context.json(snapshot);
  });

  app.get("/skills", async (context) => {
    const target = parseSkillsTarget(context.req.query("target"), context.req.query("alias"));

    if (target === undefined) {
      return context.json(
        {
          error: "target must be local or ssh with alias",
        },
        400,
      );
    }

    return context.json(await runtime.runPromise(InstalledSkills.list({ target })));
  });

  return app;
};

/**
 * Temporary starter endpoint behavior kept from the scaffold.
 *
 * This is not part of the agenv domain model; real feature endpoints should
 * live on resource-shaped routes backed by core operations.
 */
export const getGreeting = (name: string) =>
  Effect.succeed({
    message: `Hello, ${name}!`,
    service: "api",
  });

const app = createApp({
  layer: Layer.mergeAll(
    MachineInventory.liveLayer({
      sshConfigPath: join(homeDirectory(), ".ssh", "config"),
    }),
    AgentFileSystem.layer(
      (path) =>
        Effect.tryPromise({
          catch: AgentFileSystem.classifyReadFailure,
          try: () => readFile(path, "utf8"),
        }),
      undefined,
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
    InstalledSkills.liveLayer,
  ),
});

const parseConfigTarget = (
  target: string | undefined,
  alias: string | undefined,
): CodexConfigFile.ConfigTarget | undefined => {
  if (target === "local") {
    return { type: "local" };
  }

  if (target === "ssh" && alias !== undefined && alias.length > 0) {
    return {
      alias,
      type: "ssh",
    };
  }

  return undefined;
};

const parseSkillsTarget = (
  target: string | undefined,
  alias: string | undefined,
): InstalledSkills.SkillsTarget | undefined => {
  if (target === "local") {
    return { type: "local" };
  }

  if (target === "ssh" && alias !== undefined && alias.length > 0) {
    return {
      alias,
      type: "ssh",
    };
  }

  return undefined;
};

function homeDirectory() {
  const directory = process.env.HOME ?? homedir();

  if (directory.length === 0) {
    throw new Error("Could not determine home directory for agenv API");
  }

  return directory;
}

export { app };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? "3000");

  serve({ fetch: app.fetch, port });

  console.log(`API listening on http://localhost:${port}`);
}
