import { assert, describe, it } from "@effect/vitest";
import { AgentFileSystem, CodexConfigFile, MachineInventory } from "@agenv/core";
import { Effect, Layer } from "effect";
import { createApp, getGreeting } from "./index.js";

describe("api", () => {
  it.effect("returns Effect greetings", () =>
    Effect.gen(function* () {
      const greeting = yield* getGreeting("Effect");

      assert.strictEqual(greeting.message, "Hello, Effect!");
      assert.strictEqual(greeting.service, "api");
    }),
  );

  it("lists Syncable Machines with resolved metadata", async () => {
    const app = createApp({
      layer: Layer.mergeAll(
        MachineInventory.layer({
          machines: [
            {
              alias: "workstation",
              hostName: "workstation.local",
              port: 22,
              source: {
                kind: "ssh-config",
                path: "/home/example/.ssh/config",
              },
              user: "agent",
            },
          ],
        }),
        AgentFileSystem.layer(() =>
          Effect.fail(
            new CodexConfigFile.NotFound({
              message: "Codex Config File is missing",
            }),
          ),
        ),
      ),
    });
    const response = await app.request("/machines");

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      machines: [
        {
          alias: "workstation",
          hostName: "workstation.local",
          port: 22,
          source: {
            kind: "ssh-config",
            path: "/home/example/.ssh/config",
          },
          user: "agent",
        },
      ],
    });
  });

  it("returns a local Codex Config File snapshot without interpreting contents", async () => {
    const app = createApp({
      layer: Layer.mergeAll(
        MachineInventory.layer({
          machines: [],
        }),
        AgentFileSystem.layer(() => Effect.succeed("")),
      ),
    });
    const response = await app.request("/codex/config?target=local");

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      configFamily: "codex",
      contents: "",
      managedFile: "config.toml",
      path: `${process.env.HOME ?? ""}/.codex/config.toml`,
      state: "present",
    });
  });
});
