#!/usr/bin/env node
import { Console, Effect } from "effect";
import { pathToFileURL } from "node:url";

export const renderMessage = (name: string) => Effect.succeed(`Hello, ${name}!`);

const program = Effect.gen(function* () {
  const name = process.argv.at(2) ?? "Effect";
  const message = yield* renderMessage(name);

  yield* Console.log(message);
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  Effect.runPromise(program);
}
