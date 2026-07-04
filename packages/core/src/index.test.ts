import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { AgentFileSystem, CodexConfigFile, MachineInventory, OpenSsh } from "./index.js";

describe("Machine Inventory", () => {
  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(() =>
        Effect.succeed(
          [
            "Host workstation *.internal github-*",
            "  HostName ignored.example",
            "Host *",
            "  ForwardAgent no",
          ].join("\n"),
        ),
      ),
      OpenSsh.layer((alias) => {
        assert.strictEqual(alias, "workstation");

        return Effect.succeed(["user agent", "hostname workstation.local", "port 2222"].join("\n"));
      }),
    ),
  )((test) => {
    test.effect("resolves concrete SSH aliases and excludes wildcard patterns", () =>
      Effect.gen(function* () {
        const inventory = yield* MachineInventory.load({
          sshConfigPath: "/home/example/.ssh/config",
        });

        assert.deepStrictEqual(inventory, {
          machines: [
            {
              alias: "workstation",
              hostName: "workstation.local",
              port: 2222,
              source: {
                kind: "ssh-config",
                path: "/home/example/.ssh/config",
              },
              user: "agent",
            },
          ],
        });
      }),
    );
  });
});

describe("Managed File Snapshots", () => {
  layer(
    AgentFileSystem.layer(() =>
      Effect.fail(
        new CodexConfigFile.NotFound({
          message: "No such file or directory",
        }),
      ),
    ),
  )((test) => {
    test.effect("reports a missing local Codex Config File distinctly", () =>
      Effect.gen(function* () {
        const snapshot = yield* CodexConfigFile.readLocalConfig({
          configPath: "/home/example/.codex/config.toml",
        });

        assert.deepStrictEqual(snapshot, {
          configFamily: "codex",
          error: "No such file or directory",
          managedFile: "config.toml",
          path: "/home/example/.codex/config.toml",
          state: "missing",
        });
      }),
    );
  });
});
