import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { renderMessage } from "./index.js";

it.effect("renders CLI messages", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* renderMessage("CLI"), "Hello, CLI!");
  }),
);
