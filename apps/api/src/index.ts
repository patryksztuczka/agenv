import { serve } from "@hono/node-server";
import { AgentFileSystem, CodexConfigFile, MachineInventory } from "@agenv/core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
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
    MachineInventory.MachineInventoryService | AgentFileSystem.AgentFileSystem
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
    const target = context.req.query("target");

    if (target !== "local") {
      return context.json(
        {
          error: "target must be local for this endpoint slice",
        },
        400,
      );
    }

    const snapshot = await runtime.runPromise(
      CodexConfigFile.readLocalConfig({
        configPath: join(process.env.HOME ?? "", ".codex", "config.toml"),
      }),
    );

    return context.json(snapshot);
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
    MachineInventory.emptyLayer,
    AgentFileSystem.layer((path) =>
      Effect.tryPromise({
        catch: CodexConfigFile.classifyReadFailure,
        try: () => readFile(path, "utf8"),
      }),
    ),
  ),
});

export { app };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? "3000");

  serve({ fetch: app.fetch, port });

  console.log(`API listening on http://localhost:${port}`);
}
