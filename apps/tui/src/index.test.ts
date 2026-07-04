import { deepStrictEqual } from "node:assert";
import { Effect } from "effect";
import { dashboardLines } from "./index.js";

deepStrictEqual(await Effect.runPromise(dashboardLines), [
  "agenv TUI",
  "Built with OpenTUI and Effect",
  "Press Ctrl+C to exit",
]);
