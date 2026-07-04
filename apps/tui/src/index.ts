import { createCliRenderer, TextRenderable } from "@opentui/core";
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

export const dashboardLines = Effect.succeed([
  "agenv TUI",
  "Built with OpenTUI and Effect",
  "Press Ctrl+C to exit",
]);

const program = Effect.gen(function* () {
  const lines = yield* dashboardLines;
  const renderer = yield* Effect.promise(() => createCliRenderer());
  const text = new TextRenderable(renderer, {
    id: "welcome",
    content: lines.join("\n"),
  });

  renderer.root.add(text);
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  Effect.runPromise(program);
}
