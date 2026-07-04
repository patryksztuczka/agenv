import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as vitestTest } from "vitest";
import {
  AgentFileSystem,
  CodexConfigDiff,
  CodexConfigFile,
  MachineInventory,
  OpenSsh,
} from "./index.js";

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

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(() =>
        Effect.succeed(
          [
            "Host dev # temporary alias",
            "  HostName dev.local",
            'Host "quoted#alias" # comment words',
          ].join("\n"),
        ),
      ),
      OpenSsh.layer({
        resolve: (alias) =>
          Effect.succeed(["user agent", `hostname ${alias}.local`, "port 22"].join("\n")),
      }),
    ),
  )((test) => {
    test.effect("ignores inline Host comments before resolving aliases", () =>
      Effect.gen(function* () {
        const inventory = yield* MachineInventory.load({
          sshConfigPath: "/home/example/.ssh/config",
        });

        assert.deepStrictEqual(
          inventory.machines.map((machine) => machine.alias),
          ["dev", '"quoted#alias"'],
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

describe("OpenSSH live process harness", () => {
  vitestTest("reads present and missing remote files through OpenSSH argv joining", async () => {
    await withFakeOpenSsh(async ({ remoteHome }) => {
      await mkdir(join(remoteHome, ".codex"), {
        recursive: true,
      });
      await writeFile(join(remoteHome, ".codex", "config.toml"), 'model = "gpt-5"\n');

      const present = await Effect.runPromise(
        CodexConfigFile.readConfig({
          target: {
            alias: "workstation",
            type: "ssh",
          },
        }).pipe(Effect.provide(OpenSsh.liveLayer)),
      );
      const missing = await Effect.runPromise(
        CodexConfigFile.readConfig({
          remoteConfigPath: "~/.codex/missing.toml",
          target: {
            alias: "workstation",
            type: "ssh",
          },
        }).pipe(Effect.provide(OpenSsh.liveLayer)),
      );

      assert.deepStrictEqual(present, {
        configFamily: "codex",
        contents: 'model = "gpt-5"\n',
        managedFile: "config.toml",
        path: "workstation:~/.codex/config.toml",
        state: "present",
      });
      assert.strictEqual(missing.state, "missing");
      assert.strictEqual(missing.path, "workstation:~/.codex/missing.toml");
    });
  });

  vitestTest("push apply writes over SSH and verifies through live OpenSSH", async () => {
    await withFakeOpenSsh(async ({ remoteHome }) => {
      const localConfigPath = join(remoteHome, "..", "local-home", ".codex", "config.toml");
      const remoteConfigPath = join(remoteHome, ".codex", "config.toml");
      await mkdir(dirname(localConfigPath), {
        recursive: true,
      });
      await mkdir(dirname(remoteConfigPath), {
        recursive: true,
      });
      await writeFile(localConfigPath, 'model = "gpt-5"\n');
      await writeFile(remoteConfigPath, 'model = "gpt-4.1"\n');

      const result = await Effect.runPromise(
        CodexConfigFile.syncConfig({
          direction: "push",
          host: "workstation",
          localConfigPath,
          mode: "apply",
        }).pipe(Effect.provide(Layer.mergeAll(realFileSystemLayer, OpenSsh.liveLayer))),
      );

      assert.strictEqual(result.applied, true);
      assert.strictEqual(result.changed, true);
      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.destination.state, "present");
      assert.strictEqual(await readFile(remoteConfigPath, "utf8"), 'model = "gpt-5"\n');
    });
  });
});

describe("Managed File Snapshots", () => {
  const originalHome = process.env.HOME;
  const restoreHome = () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  };

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

  layer(AgentFileSystem.layer(() => Effect.succeed("unused")))((test) => {
    test.effect("reports unreadable when the local config default path cannot be resolved", () =>
      Effect.gen(function* () {
        process.env.HOME = "";

        const snapshot = yield* CodexConfigFile.readConfig({
          target: {
            type: "local",
          },
        });

        restoreHome();

        assert.deepStrictEqual(snapshot, {
          configFamily: "codex",
          error: "Could not determine home directory for Codex config",
          managedFile: "config.toml",
          path: "<unknown>",
          state: "unreadable",
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            restoreHome();
          }),
        ),
      ),
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

describe("Codex Config Diff Preview", () => {
  it.effect("produces a textual diff when local and host snapshots are present", () =>
    Effect.gen(function* () {
      const preview = yield* CodexConfigDiff.preview({
        left: {
          configFamily: "codex",
          contents: 'model = "gpt-5"\napproval_policy = "on-request"\n',
          managedFile: "config.toml",
          path: "/home/example/.codex/config.toml",
          state: "present",
        },
        right: {
          configFamily: "codex",
          contents: 'model = "gpt-5"\napproval_policy = "never"\n',
          managedFile: "config.toml",
          path: "workstation:~/.codex/config.toml",
          state: "present",
        },
      });

      assert.strictEqual(preview.reason, null);
      assert.match(preview.diff ?? "", /--- \/home\/example\/\.codex\/config\.toml/);
      assert.match(preview.diff ?? "", /\+\+\+ workstation:~\/\.codex\/config\.toml/);
      assert.match(preview.diff ?? "", /-approval_policy = "on-request"/);
      assert.match(preview.diff ?? "", /\+approval_policy = "never"/);
    }),
  );

  it.effect("reports snapshot states instead of creating an empty-file diff", () =>
    Effect.gen(function* () {
      const preview = yield* CodexConfigDiff.preview({
        left: {
          configFamily: "codex",
          error: "No such file or directory",
          managedFile: "config.toml",
          path: "/home/example/.codex/config.toml",
          state: "missing",
        },
        right: {
          configFamily: "codex",
          contents: 'model = "gpt-5"\n',
          managedFile: "config.toml",
          path: "workstation:~/.codex/config.toml",
          state: "present",
        },
      });

      assert.strictEqual(preview.diff, null);
      assert.strictEqual(preview.reason, "left snapshot is missing");
    }),
  );
});

interface FakeOpenSshHarness {
  readonly remoteHome: string;
}

const withFakeOpenSsh = async (run: (harness: FakeOpenSshHarness) => Promise<void>) => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "agenv-openssh-"));
  const binDirectory = join(tempDirectory, "bin");
  const remoteHome = join(tempDirectory, "remote-home");
  const fakeSshPath = join(binDirectory, "ssh");
  const originalPath = process.env.PATH;

  await mkdir(binDirectory, {
    recursive: true,
  });
  await mkdir(remoteHome, {
    recursive: true,
  });
  await writeFile(fakeSshPath, fakeSshScript(remoteHome));
  await chmod(fakeSshPath, 0o700);

  process.env.PATH = originalPath === undefined ? binDirectory : `${binDirectory}:${originalPath}`;

  try {
    await run({
      remoteHome,
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    await rm(tempDirectory, {
      force: true,
      recursive: true,
    });
  }
};

const fakeSshScript = (remoteHome: string) => `#!/bin/sh
set -eu

if [ "\${1:-}" = "-G" ]; then
  printf '%s\\n' 'user agent' 'hostname workstation.local' 'port 22'
  exit 0
fi

if [ "$#" -lt 2 ]; then
  echo "fake ssh expected a host alias and remote command" >&2
  exit 255
fi

host_alias=$1
shift

if [ "$host_alias" != "workstation" ]; then
  echo "unknown fake ssh host: $host_alias" >&2
  exit 255
fi

export HOME=${quoteShellForTest(remoteHome)}
remote_command="$*"
exec sh -c "$remote_command"
`;

const quoteShellForTest = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const realFileSystemLayer = AgentFileSystem.layer(
  (path) =>
    Effect.tryPromise({
      catch: AgentFileSystem.classifyReadFailure,
      try: () => readFile(path, "utf8"),
    }),
  (path, contents) =>
    Effect.tryPromise({
      catch: AgentFileSystem.classifyReadFailure,
      try: async () => {
        await mkdir(dirname(path), {
          recursive: true,
        });
        await writeFile(path, contents, {
          mode: 0o600,
        });
      },
    }),
);
