import { AgentFileSystem, MachineInventory, OpenSsh } from "@agenv/core";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { runCli } from "./index.js";

describe("CLI Host Visibility", () => {
  layer(
    Layer.mergeAll(
      AgentFileSystem.layer((path) => {
        if (path === "/home/example/.codex/config.toml") {
          return Effect.succeed('model = "gpt-5"');
        }

        assert.strictEqual(path, "/home/example/.ssh/config");
        return Effect.succeed("Host workstation");
      }),
      OpenSsh.layer({
        readFile: (alias, path) => {
          assert.strictEqual(alias, "workstation");
          assert.strictEqual(path, "~/.codex/config.toml");

          return Effect.succeed('model = "gpt-5"\n');
        },
        resolve: (alias) => {
          assert.strictEqual(alias, "workstation");

          return Effect.succeed(
            ["user agent", "hostname workstation.local", "port 2222"].join("\n"),
          );
        },
      }),
      MachineInventory.liveLayer({
        sshConfigPath: "/home/example/.ssh/config",
      }),
    ),
  )((test) => {
    test.effect("renders Host Inventory as JSON for agents", () =>
      Effect.gen(function* () {
        const result = yield* runCli(["list", "hosts", "--json"]);

        assert.strictEqual(result.exitCode, 0);
        assert.deepStrictEqual(JSON.parse(result.stdout), {
          hosts: [
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
        assert.strictEqual(result.stderr, "");
      }),
    );

    test.effect("renders a compact Host table for humans", () =>
      Effect.gen(function* () {
        const result = yield* runCli(["list", "hosts"]);

        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stdout, /Hosts/);
        assert.match(result.stdout, /workstation/);
        assert.match(result.stdout, /workstation\.local/);
        assert.match(result.stdout, /agent/);
        assert.match(result.stdout, /2222/);
        assert.match(result.stdout, /ssh-config/);
      }),
    );

    test.effect("inspects local Codex config by default as JSON", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli(["inspect", "codex", "config", "--json"]).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (originalHome === undefined) {
                delete process.env.HOME;
              } else {
                process.env.HOME = originalHome;
              }
            }),
          ),
        );

        assert.strictEqual(result.exitCode, 0);
        assert.deepStrictEqual(JSON.parse(result.stdout), {
          configFamily: "codex",
          contents: 'model = "gpt-5"',
          managedFile: "config.toml",
          path: "/home/example/.codex/config.toml",
          state: "present",
        });
      }),
    );

    test.effect("inspects remote Codex config for a Host alias as text", () =>
      Effect.gen(function* () {
        const result = yield* runCli(["inspect", "codex", "config", "--host", "workstation"]);

        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stdout, /Codex Config File/);
        assert.match(result.stdout, /Host: workstation/);
        assert.match(result.stdout, /State: present/);
        assert.match(result.stdout, /Path: workstation:~\/\.codex\/config\.toml/);
        assert.match(result.stdout, /model = "gpt-5"/);
      }),
    );
  });

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(() =>
        Effect.fail(
          new AgentFileSystem.FileNotFound({
            message: "No such file or directory",
          }),
        ),
      ),
      OpenSsh.layer({
        resolve: () => Effect.succeed(""),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("renders missing local Codex config snapshots as JSON", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli(["inspect", "codex", "config", "--json"]).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (originalHome === undefined) {
                delete process.env.HOME;
              } else {
                process.env.HOME = originalHome;
              }
            }),
          ),
        );

        assert.strictEqual(result.exitCode, 0);
        assert.deepStrictEqual(JSON.parse(result.stdout), {
          configFamily: "codex",
          error: "No such file or directory",
          managedFile: "config.toml",
          path: "/home/example/.codex/config.toml",
          state: "missing",
        });
      }),
    );
  });

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(() =>
        Effect.fail(
          new AgentFileSystem.FileNotFound({
            message: "unused",
          }),
        ),
      ),
      OpenSsh.layer({
        readFile: () =>
          Effect.fail(
            new OpenSsh.ConnectionFailed({
              message: "ssh: connect to host workstation port 22: Connection refused",
            }),
          ),
        resolve: () => Effect.succeed(""),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("renders SSH connection failures as inspect snapshots", () =>
      Effect.gen(function* () {
        const result = yield* runCli(["inspect", "codex", "config", "--host", "workstation"]);

        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stdout, /State: connection-failed/);
        assert.match(result.stdout, /Path: workstation:~\/\.codex\/config\.toml/);
        assert.match(result.stdout, /ssh: connect to host workstation port 22: Connection refused/);
      }),
    );
  });
});
