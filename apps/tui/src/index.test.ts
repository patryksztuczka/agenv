import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { dashboardLines } from "./index.js";

it.effect("renders dashboard lines", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* dashboardLines, [
      "agenv TUI",
      "Built with OpenTUI and Effect",
      "Press Ctrl+C to exit",
    ]);
  }),
);
