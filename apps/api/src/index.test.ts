import { strictEqual } from "node:assert";
import { Effect } from "effect";
import { getGreeting } from "./index.js";

const greeting = await Effect.runPromise(getGreeting("Effect"));

strictEqual(greeting.message, "Hello, Effect!");
strictEqual(greeting.service, "api");
