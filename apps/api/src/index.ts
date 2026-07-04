import { serve } from "@hono/node-server";
import { Effect } from "effect";
import { Hono } from "hono";
import { pathToFileURL } from "node:url";

const app = new Hono();

export const getGreeting = (name: string) =>
  Effect.succeed({
    message: `Hello, ${name}!`,
    service: "api",
  });

app.get("/health", (context) => context.json({ ok: true }));

app.get("/hello/:name", async (context) => {
  const greeting = await Effect.runPromise(getGreeting(context.req.param("name")));

  return context.json(greeting);
});

export { app };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? "3000");

  serve({ fetch: app.fetch, port });

  console.log(`API listening on http://localhost:${port}`);
}
