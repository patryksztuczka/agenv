import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { test as vitestTest } from "vitest";
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
      OpenSsh.layer({
        resolve: (alias) => {
          assert.strictEqual(alias, "workstation");

          return Effect.succeed(
            ["user agent", "hostname workstation.local", "port 2222"].join("\n"),
          );
        },
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

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(() =>
        Effect.succeed(
          ["Host\tworkstation", "  HostName workstation.local", "Host workstation build-box"].join(
            "\n",
          ),
        ),
      ),
      OpenSsh.layer({
        resolve: (alias) =>
          Effect.succeed(["user agent", `hostname ${alias}.local`, "port 22"].join("\n")),
      }),
    ),
  )((test) => {
    test.effect("accepts whitespace after Host and resolves each alias once", () =>
      Effect.gen(function* () {
        const inventory = yield* MachineInventory.load({
          sshConfigPath: "/home/example/.ssh/config",
        });

        assert.deepStrictEqual(
          inventory.machines.map((machine) => machine.alias),
          ["workstation", "build-box"],
        );
      }),
    );
  });

  let readCount = 0;

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(() =>
        Effect.sync(() => {
          readCount += 1;

          return `Host workstation-${readCount}`;
        }),
      ),
      OpenSsh.layer({
        resolve: (alias) =>
          Effect.succeed(["user agent", `hostname ${alias}.local`, "port 22"].join("\n")),
      }),
      MachineInventory.liveLayer({
        sshConfigPath: "/home/example/.ssh/config",
      }),
    ),
  )((test) => {
    test.effect("loads Machine Inventory dynamically for each list request", () =>
      Effect.gen(function* () {
        const first = yield* MachineInventory.list();
        const second = yield* MachineInventory.list();

        assert.deepStrictEqual(
          first.machines.map((machine) => machine.alias),
          ["workstation-1"],
        );
        assert.deepStrictEqual(
          second.machines.map((machine) => machine.alias),
          ["workstation-2"],
        );
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
            new OpenSsh.RemoteFileNotFound({
              message: "remote file is missing",
            }),
          ),
        resolve: () => Effect.succeed(""),
      }),
    ),
  )((test) => {
    test.effect("reports a missing remote Codex Config File distinctly", () =>
      Effect.gen(function* () {
        const snapshot = yield* CodexConfigFile.readConfig({
          target: {
            alias: "workstation",
            type: "ssh",
          },
        });

        assert.deepStrictEqual(snapshot, {
          configFamily: "codex",
          error: "remote file is missing",
          managedFile: "config.toml",
          path: "workstation:~/.codex/config.toml",
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
            new OpenSsh.RemoteFileUnreadable({
              message: "remote file is unreadable",
            }),
          ),
        resolve: () => Effect.succeed(""),
      }),
    ),
  )((test) => {
    test.effect("reports an unreadable remote Codex Config File distinctly", () =>
      Effect.gen(function* () {
        const snapshot = yield* CodexConfigFile.readConfig({
          target: {
            alias: "workstation",
            type: "ssh",
          },
        });

        assert.deepStrictEqual(snapshot, {
          configFamily: "codex",
          error: "remote file is unreadable",
          managedFile: "config.toml",
          path: "workstation:~/.codex/config.toml",
          state: "unreadable",
        });
      }),
    );
  });
});

describe("OpenSSH", () => {
  vitestTest("rejects SSH aliases that could be parsed as options", () => {
    assert.throws(
      () => OpenSsh.unsafeOpenSshInternals.validateAlias("-oProxyCommand=ignored"),
      OpenSsh.ConnectionFailed,
    );
  });

  vitestTest("allows remote home expansion while quoting the rest of the read path", () => {
    assert.strictEqual(
      OpenSsh.unsafeOpenSshInternals.remoteReadCommand("~/.codex/config.toml"),
      [
        "if [ ! -e ~/'.codex/config.toml' ]; then exit 2; fi",
        "if [ ! -r ~/'.codex/config.toml' ]; then exit 3; fi",
        "cat -- ~/'.codex/config.toml'",
      ].join("; "),
    );
  });

  vitestTest("quotes non-home remote read paths as a single shell argument", () => {
    assert.strictEqual(
      OpenSsh.unsafeOpenSshInternals.remoteReadCommand("/tmp/agent's config.toml"),
      [
        "if [ ! -e '/tmp/agent'\\''s config.toml' ]; then exit 2; fi",
        "if [ ! -r '/tmp/agent'\\''s config.toml' ]; then exit 3; fi",
        "cat -- '/tmp/agent'\\''s config.toml'",
      ].join("; "),
    );
  });
});

describe("Managed File Snapshots", () => {
  layer(
    AgentFileSystem.layer(() =>
      Effect.fail(
        new AgentFileSystem.FileNotFound({
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
        readFile: (alias, path) => {
          assert.strictEqual(alias, "workstation");
          assert.strictEqual(path, "~/.codex/config.toml");

          return Effect.succeed('model = "gpt-5"');
        },
        resolve: () => Effect.succeed(""),
      }),
    ),
  )((test) => {
    test.effect("reads a remote Codex Config File from an SSH-Known Machine", () =>
      Effect.gen(function* () {
        const snapshot = yield* CodexConfigFile.readConfig({
          target: {
            alias: "workstation",
            type: "ssh",
          },
        });

        assert.deepStrictEqual(snapshot, {
          configFamily: "codex",
          contents: 'model = "gpt-5"',
          managedFile: "config.toml",
          path: "workstation:~/.codex/config.toml",
          state: "present",
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
    ),
  )((test) => {
    test.effect("reports SSH connection failure distinctly for remote Codex config reads", () =>
      Effect.gen(function* () {
        const snapshot = yield* CodexConfigFile.readConfig({
          target: {
            alias: "workstation",
            type: "ssh",
          },
        });

        assert.deepStrictEqual(snapshot, {
          configFamily: "codex",
          error: "ssh: connect to host workstation port 22: Connection refused",
          managedFile: "config.toml",
          path: "workstation:~/.codex/config.toml",
          state: "connection-failed",
        });
      }),
    );
  });
});
