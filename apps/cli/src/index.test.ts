import { strictEqual } from "node:assert";
import { Effect } from "effect";
import { renderMessage } from "./index.js";

strictEqual(await Effect.runPromise(renderMessage("CLI")), "Hello, CLI!");
