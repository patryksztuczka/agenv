import { AgentFileSystem, MachineInventory, OpenSsh } from "@agenv/core";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { runCli } from "./index.js";

const sha256 = (contents: string) => createHash("sha256").update(contents).digest("hex");

describe("CLI Host Visibility", () => {
  layer(
    Layer.mergeAll(
      AgentFileSystem.layer((path) => {
        if (path === "/home/example/.codex/config.toml") {
          return Effect.succeed('model = "gpt-4"');
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

    test.effect("returns Effect CLI help output from the command seam", () =>
      Effect.gen(function* () {
        const result = yield* runCli(["--help"]);

        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stdout, /USAGE/);
        assert.match(result.stdout, /agenv <subcommand> \[flags\]/);
        assert.match(result.stdout, /SUBCOMMANDS/);
        assert.match(result.stdout, /list/);
        assert.match(result.stdout, /inspect/);
        assert.match(result.stdout, /diff/);
        assert.strictEqual(result.stderr, "");
      }),
    );

    test.effect("returns Effect CLI parse errors from the command seam", () =>
      Effect.gen(function* () {
        const result = yield* runCli(["inspect", "codex", "config", "--unknown"]);

        assert.strictEqual(result.exitCode, 1);
        assert.match(result.stdout, /USAGE/);
        assert.match(result.stdout, /agenv inspect codex config/);
        assert.match(result.stderr, /--unknown/);
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
          contentByteCount: Buffer.byteLength('model = "gpt-4"', "utf8"),
          contentSha256: sha256('model = "gpt-4"'),
          contentsPreview: 'model = "gpt-4"',
          contentsRedacted: false,
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

    test.effect("renders a unified Codex config diff for a Host alias", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli(["diff", "codex", "config", "--host", "workstation"]).pipe(
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
        assert.match(result.stdout, /Codex Config Diff/);
        assert.match(result.stdout, /Host: workstation/);
        assert.match(result.stdout, /--- \/home\/example\/\.codex\/config\.toml/);
        assert.match(result.stdout, /\+\+\+ workstation:~\/\.codex\/config\.toml/);
        assert.match(result.stdout, /-model = "gpt-4"/);
        assert.match(result.stdout, /\+model = "gpt-5"/);
      }),
    );

    test.effect("renders structured Codex config diff output for agents", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli([
          "diff",
          "codex",
          "config",
          "--host",
          "workstation",
          "--json",
        ]).pipe(
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

        const body = JSON.parse(result.stdout);
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(body.reason, null);
        assert.strictEqual(body.left.path, "/home/example/.codex/config.toml");
        assert.strictEqual(body.left.target.type, "local");
        assert.strictEqual(body.right.path, "workstation:~/.codex/config.toml");
        assert.strictEqual(body.right.target.alias, "workstation");
        assert.strictEqual(body.diffRedacted, false);
        assert.match(body.diff, /--- \/home\/example\/\.codex\/config\.toml/);
      }),
    );
  });

  const localConfigWithSecrets = [
    'model = "gpt-5"',
    'api_key = "sk-test-do-not-use-local"',
    'env = { OPENAI_API_KEY = "sk-test-do-not-use-inline" }',
    "[mcp_servers.demo.env]",
    'ANTHROPIC_API_KEY = "sk-test-do-not-use-env"',
    "",
  ].join("\n");
  const remoteConfigWithSecrets = [
    'model = "gpt-4.1"',
    'token = "sk-test-do-not-use-remote"',
    "",
  ].join("\n");
  const fakeSecretPattern = /sk-test-do-not-use/;

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer((path) => {
        assert.strictEqual(path, "/home/example/.codex/config.toml");

        return Effect.succeed(localConfigWithSecrets);
      }),
      OpenSsh.layer({
        readFile: (alias, path) => {
          assert.strictEqual(alias, "workstation");
          assert.strictEqual(path, "~/.codex/config.toml");

          return Effect.succeed(remoteConfigWithSecrets);
        },
        resolve: () => Effect.succeed(""),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("redacts sensitive inspect text by default", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli(["inspect", "codex", "config"]).pipe(
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
        assert.isFalse(fakeSecretPattern.test(result.stdout));
        assert.match(result.stdout, /model = "gpt-5"/);
        assert.match(result.stdout, /api_key = "<redacted>"/);
        assert.match(result.stdout, /env = "<redacted>"/);
        assert.match(result.stdout, /ANTHROPIC_API_KEY = "<redacted>"/);
      }),
    );

    test.effect("redacts sensitive inspect JSON by default", () =>
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

        const body = JSON.parse(result.stdout);

        assert.strictEqual(result.exitCode, 0);
        assert.isFalse(fakeSecretPattern.test(result.stdout));
        assert.strictEqual(body.contents, undefined);
        assert.strictEqual(body.contentsRedacted, true);
        assert.match(body.contentsPreview, /api_key = "<redacted>"/);
        assert.match(body.contentsPreview, /ANTHROPIC_API_KEY = "<redacted>"/);
      }),
    );

    test.effect("redacts sensitive diff and sync output by default", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const diffResult = yield* runCli(["diff", "codex", "config", "--host", "workstation"]).pipe(
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

        process.env.HOME = "/home/example";
        const syncResult = yield* runCli([
          "push",
          "codex",
          "config",
          "--host",
          "workstation",
          "--json",
        ]).pipe(
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

        const syncBody = JSON.parse(syncResult.stdout);

        assert.strictEqual(diffResult.exitCode, 0);
        assert.isFalse(fakeSecretPattern.test(diffResult.stdout));
        assert.match(diffResult.stdout, /token = "<redacted>"/);
        assert.match(diffResult.stdout, /api_key = "<redacted>"/);
        assert.strictEqual(syncResult.exitCode, 0);
        assert.isFalse(fakeSecretPattern.test(syncResult.stdout));
        assert.strictEqual(syncBody.diffRedacted, true);
        assert.strictEqual(syncBody.source.contents, undefined);
        assert.strictEqual(syncBody.destination.contents, undefined);
        assert.match(syncBody.diff, /token = "<redacted>"/);
        assert.match(syncBody.diff, /api_key = "<redacted>"/);
      }),
    );

    test.effect("exposes raw config output only with --raw", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const inspectResult = yield* runCli(["inspect", "codex", "config", "--json", "--raw"]).pipe(
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

        process.env.HOME = "/home/example";
        const diffResult = yield* runCli([
          "diff",
          "codex",
          "config",
          "--host",
          "workstation",
          "--raw",
        ]).pipe(
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

        assert.strictEqual(inspectResult.exitCode, 0);
        assert.match(inspectResult.stdout, fakeSecretPattern);
        assert.strictEqual(JSON.parse(inspectResult.stdout).contents, localConfigWithSecrets);
        assert.strictEqual(diffResult.exitCode, 0);
        assert.match(diffResult.stdout, fakeSecretPattern);
      }),
    );
  });

  let missingDestinationWrite: string | undefined;

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer((path) => {
        assert.strictEqual(path, "/home/example/.codex/config.toml");

        return Effect.succeed('model = "gpt-5"\n');
      }),
      OpenSsh.layer({
        readFile: () =>
          missingDestinationWrite === undefined
            ? Effect.fail(
                new OpenSsh.RemoteFileNotFound({
                  message: "remote file is missing",
                }),
              )
            : Effect.succeed(missingDestinationWrite),
        resolve: () => Effect.succeed(""),
        writeFile: (_alias, _path, contents) =>
          Effect.sync(() => {
            missingDestinationWrite = contents;
          }),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("creates a missing destination during push apply", () =>
      Effect.gen(function* () {
        missingDestinationWrite = undefined;

        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli([
          "push",
          "codex",
          "config",
          "--host",
          "workstation",
          "--apply",
        ]).pipe(
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
        assert.strictEqual(missingDestinationWrite, 'model = "gpt-5"\n');
        assert.match(result.stdout, /Applied and verified\./);
      }),
    );
  });

  let writeAfterMissingSource = false;

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(
        () =>
          Effect.fail(
            new AgentFileSystem.FileNotFound({
              message: "Codex Config File is missing",
            }),
          ),
        () =>
          Effect.sync(() => {
            writeAfterMissingSource = true;
          }),
      ),
      OpenSsh.layer({
        readFile: () => Effect.succeed('model = "gpt-4.1"\n'),
        resolve: () => Effect.succeed(""),
        writeFile: () =>
          Effect.sync(() => {
            writeAfterMissingSource = true;
          }),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("fails missing push source without writing", () =>
      Effect.gen(function* () {
        writeAfterMissingSource = false;

        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli([
          "push",
          "codex",
          "config",
          "--host",
          "workstation",
          "--apply",
          "--json",
        ]).pipe(
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

        const parsed = JSON.parse(result.stdout);

        assert.strictEqual(result.exitCode, 1);
        assert.strictEqual(writeAfterMissingSource, false);
        assert.strictEqual(parsed.error, "Source is missing.");
        assert.strictEqual(parsed.source.state, "missing");
      }),
    );
  });

  let writtenRemoteContents: string | undefined;
  let remoteReadCount = 0;

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer((path) => {
        assert.strictEqual(path, "/home/example/.codex/config.toml");

        return Effect.succeed('model = "gpt-5"\n');
      }),
      OpenSsh.layer({
        readFile: () =>
          Effect.sync(() => {
            remoteReadCount += 1;

            if (remoteReadCount === 1) {
              return 'model = "gpt-4.1"\n';
            }

            return writtenRemoteContents ?? "";
          }),
        resolve: () => Effect.succeed(""),
        writeFile: (alias, path, contents) =>
          Effect.sync(() => {
            assert.strictEqual(alias, "workstation");
            assert.strictEqual(path, "~/.codex/config.toml");
            writtenRemoteContents = contents;
          }),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("applies push writes and verifies the remote destination", () =>
      Effect.gen(function* () {
        writtenRemoteContents = undefined;
        remoteReadCount = 0;

        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli([
          "push",
          "codex",
          "config",
          "--host",
          "workstation",
          "--apply",
        ]).pipe(
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
        assert.strictEqual(writtenRemoteContents, 'model = "gpt-5"\n');
        assert.strictEqual(remoteReadCount, 2);
        assert.match(result.stdout, /Applied and verified\./);
      }),
    );
  });

  let localWriteCount = 0;

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(
        () => Effect.succeed('model = "gpt-5"\n'),
        () =>
          Effect.sync(() => {
            localWriteCount += 1;
          }),
      ),
      OpenSsh.layer({
        readFile: () => Effect.succeed('model = "gpt-5"\n'),
        resolve: () => Effect.succeed(""),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("does not write when apply finds no diff", () =>
      Effect.gen(function* () {
        localWriteCount = 0;

        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli([
          "pull",
          "codex",
          "config",
          "--host",
          "workstation",
          "--apply",
        ]).pipe(
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
        assert.strictEqual(localWriteCount, 0);
        assert.match(result.stdout, /No changes\./);
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

    test.effect("renders missing snapshots as a diff state summary", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli(["diff", "codex", "config", "--host", "workstation"]).pipe(
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
        assert.match(result.stdout, /Codex Config Diff/);
        assert.match(result.stdout, /No textual diff available: left snapshot is missing/);
        assert.match(result.stdout, /Left/);
        assert.match(result.stdout, /State: missing/);
        assert.isFalse(/^--- /m.test(result.stdout));
        assert.isFalse(/^\+\+\+ /m.test(result.stdout));
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

describe("CLI Codex Config Push/Pull", () => {
  layer(
    Layer.mergeAll(
      AgentFileSystem.layer((path) => {
        assert.strictEqual(path, "/home/example/.codex/config.toml");

        return Effect.succeed('model = "gpt-5"\n');
      }),
      OpenSsh.layer({
        readFile: (alias, path) => {
          assert.strictEqual(alias, "workstation");
          assert.strictEqual(path, "~/.codex/config.toml");

          return Effect.succeed('model = "gpt-4.1"\n');
        },
        resolve: () => Effect.succeed(""),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("previews push from local Codex config to a Host without writing", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli(["push", "codex", "config", "--host", "workstation"]).pipe(
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
        assert.match(result.stdout, /--- workstation:~\/\.codex\/config\.toml/);
        assert.match(result.stdout, /\+\+\+ \/home\/example\/\.codex\/config\.toml/);
        assert.match(result.stdout, /-model = "gpt-4\.1"/);
        assert.match(result.stdout, /\+model = "gpt-5"/);
        assert.strictEqual(result.stderr, "");
      }),
    );

    test.effect("previews pull from a Host Codex config to local without writing", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli(["pull", "codex", "config", "--host", "workstation"]).pipe(
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
        assert.match(result.stdout, /--- \/home\/example\/\.codex\/config\.toml/);
        assert.match(result.stdout, /\+\+\+ workstation:~\/\.codex\/config\.toml/);
        assert.match(result.stdout, /-model = "gpt-5"/);
        assert.match(result.stdout, /\+model = "gpt-4\.1"/);
      }),
    );

    test.effect("renders structured JSON for preview mode", () =>
      Effect.gen(function* () {
        const originalHome = process.env.HOME;
        process.env.HOME = "/home/example";
        const result = yield* runCli([
          "push",
          "codex",
          "config",
          "--host",
          "workstation",
          "--json",
        ]).pipe(
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
        const body = JSON.parse(result.stdout);

        assert.strictEqual(body.applied, false);
        assert.strictEqual(body.changed, true);
        assert.strictEqual(body.direction, "push");
        assert.strictEqual(body.mode, "preview");
        assert.strictEqual(body.verified, false);
        assert.strictEqual(body.diffRedacted, false);
        assert.strictEqual(body.destination.contents, undefined);
        assert.strictEqual(body.destination.contentsPreview, 'model = "gpt-4.1"\n');
        assert.strictEqual(
          body.destination.contentByteCount,
          Buffer.byteLength('model = "gpt-4.1"\n', "utf8"),
        );
        assert.strictEqual(body.destination.contentSha256, sha256('model = "gpt-4.1"\n'));
        assert.strictEqual(body.source.contents, undefined);
        assert.strictEqual(body.source.contentsPreview, 'model = "gpt-5"\n');
        assert.strictEqual(
          body.source.contentByteCount,
          Buffer.byteLength('model = "gpt-5"\n', "utf8"),
        );
        assert.strictEqual(body.source.contentSha256, sha256('model = "gpt-5"\n'));
        assert.strictEqual(
          body.diff,
          "--- workstation:~/.codex/config.toml\n" +
            "+++ /home/example/.codex/config.toml\n" +
            "@@ -1 +1 @@\n" +
            '-model = "gpt-4.1"\n' +
            '+model = "gpt-5"\n',
        );
      }),
    );
  });

  layer(
    Layer.mergeAll(
      AgentFileSystem.layer(() => Effect.succeed("")),
      OpenSsh.layer({
        resolve: () => Effect.succeed(""),
      }),
      MachineInventory.emptyLayer,
    ),
  )((test) => {
    test.effect("requires an explicit Host for push writes", () =>
      Effect.gen(function* () {
        const result = yield* runCli(["push", "codex", "config"]);

        assert.strictEqual(result.exitCode, 2);
        assert.strictEqual(result.stdout, "");
        assert.match(result.stderr, /--host is required/);
      }),
    );
  });
});
