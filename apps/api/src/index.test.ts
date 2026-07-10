import { assert, describe, it } from "@effect/vitest";
import { AgentFileSystem, InstalledSkills, MachineInventory, OpenSsh } from "@agenv/core";
import { Effect, Layer } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
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
              state: "resolved",
              user: "agent",
            },
          ],
        }),
        AgentFileSystem.layer(() =>
          Effect.fail(
            new AgentFileSystem.FileNotFound({
              message: "Codex Config File is missing",
            }),
          ),
        ),
        inertOpenSshLayer,
        emptyInstalledSkillsLayer,
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
          state: "resolved",
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
        inertOpenSshLayer,
        emptyInstalledSkillsLayer,
      ),
    });
    const response = await app.request("/codex/config?target=local");

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      configFamily: "codex",
      contents: "",
      managedFile: "config.toml",
      path: join(process.env.HOME ?? homedir(), ".codex", "config.toml"),
      state: "present",
    });
  });

  it("returns a remote Codex Config File for an SSH-Known Machine", async () => {
    const app = createApp({
      layer: Layer.mergeAll(
        MachineInventory.layer({
          machines: [],
        }),
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
        emptyInstalledSkillsLayer,
      ),
    });
    const response = await app.request("/codex/config?target=ssh&alias=workstation");

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      configFamily: "codex",
      contents: 'model = "gpt-5"',
      managedFile: "config.toml",
      path: "workstation:~/.codex/config.toml",
      state: "present",
    });
  });

  it("returns connection-failed when OpenSSH cannot read remote Codex config", async () => {
    const app = createApp({
      layer: Layer.mergeAll(
        MachineInventory.layer({
          machines: [],
        }),
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
        emptyInstalledSkillsLayer,
      ),
    });
    const response = await app.request("/codex/config?target=ssh&alias=workstation");

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      configFamily: "codex",
      error: "ssh: connect to host workstation port 22: Connection refused",
      managedFile: "config.toml",
      path: "workstation:~/.codex/config.toml",
      state: "connection-failed",
    });
  });

  it("returns installed skills from the core inventory", async () => {
    const app = createApp({
      layer: Layer.mergeAll(
        MachineInventory.layer({ machines: [] }),
        AgentFileSystem.layer(() => Effect.succeed("")),
        inertOpenSshLayer,
        InstalledSkills.layer({
          skills: [
            {
              agent: "claude-code",
              description: "Review code",
              metadataState: "parsed",
              name: "review",
              path: "/repo/.claude/skills/review",
              skillFilePath: "/repo/.claude/skills/review/SKILL.md",
              source: {
                agent: "claude-code",
                path: "/repo/.claude/skills",
                scope: "project",
                state: "scanned",
              },
            },
            {
              agent: "opencode",
              metadataState: "parsed",
              name: "debug",
              path: "/repo/.opencode/skills/debug",
              skillFilePath: "/repo/.opencode/skills/debug/SKILL.md",
              source: {
                agent: "opencode",
                path: "/repo/.opencode/skills",
                scope: "project",
                state: "scanned",
              },
            },
          ],
          sources: [
            {
              agent: "claude-code",
              path: "/repo/.claude/skills",
              scope: "project",
              state: "scanned",
            },
            {
              agent: "opencode",
              path: "/repo/.opencode/skills",
              scope: "project",
              state: "scanned",
            },
          ],
          target: { type: "local" },
        }),
      ),
    });

    const response = await app.request("/skills?target=local");

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      skills: [
        {
          agent: "claude-code",
          description: "Review code",
          metadataState: "parsed",
          name: "review",
          path: "/repo/.claude/skills/review",
          skillFilePath: "/repo/.claude/skills/review/SKILL.md",
          source: {
            agent: "claude-code",
            path: "/repo/.claude/skills",
            scope: "project",
            state: "scanned",
          },
        },
        {
          agent: "opencode",
          metadataState: "parsed",
          name: "debug",
          path: "/repo/.opencode/skills/debug",
          skillFilePath: "/repo/.opencode/skills/debug/SKILL.md",
          source: {
            agent: "opencode",
            path: "/repo/.opencode/skills",
            scope: "project",
            state: "scanned",
          },
        },
      ],
      sources: [
        {
          agent: "claude-code",
          path: "/repo/.claude/skills",
          scope: "project",
          state: "scanned",
        },
        {
          agent: "opencode",
          path: "/repo/.opencode/skills",
          scope: "project",
          state: "scanned",
        },
      ],
      target: { type: "local" },
    });
  });

  it("filters installed skills by tool", async () => {
    const app = createApp({
      layer: Layer.mergeAll(
        MachineInventory.layer({ machines: [] }),
        AgentFileSystem.layer(() => Effect.succeed("")),
        inertOpenSshLayer,
        InstalledSkills.layer({
          skills: [
            {
              agent: "claude-code",
              metadataState: "parsed",
              name: "review",
              path: "/repo/.claude/skills/review",
              skillFilePath: "/repo/.claude/skills/review/SKILL.md",
              source: {
                agent: "claude-code",
                path: "/repo/.claude/skills",
                scope: "project",
                state: "scanned",
              },
            },
            {
              agent: "opencode",
              metadataState: "parsed",
              name: "debug",
              path: "/repo/.opencode/skills/debug",
              skillFilePath: "/repo/.opencode/skills/debug/SKILL.md",
              source: {
                agent: "opencode",
                path: "/repo/.opencode/skills",
                scope: "project",
                state: "scanned",
              },
            },
          ],
          sources: [
            {
              agent: "claude-code",
              path: "/repo/.claude/skills",
              scope: "project",
              state: "scanned",
            },
            {
              agent: "opencode",
              path: "/repo/.opencode/skills",
              scope: "project",
              state: "scanned",
            },
          ],
          target: { type: "local" },
        }),
      ),
    });

    const response = await app.request("/skills?target=local&tool=opencode");

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      skills: [
        {
          agent: "opencode",
          metadataState: "parsed",
          name: "debug",
          path: "/repo/.opencode/skills/debug",
          skillFilePath: "/repo/.opencode/skills/debug/SKILL.md",
          source: {
            agent: "opencode",
            path: "/repo/.opencode/skills",
            scope: "project",
            state: "scanned",
          },
        },
      ],
      sources: [
        {
          agent: "opencode",
          path: "/repo/.opencode/skills",
          scope: "project",
          state: "scanned",
        },
      ],
      target: { type: "local" },
    });
  });

  it("returns remote installed skills and forwards projectPath", async () => {
    const app = createApp({
      layer: Layer.mergeAll(
        MachineInventory.layer({ machines: [] }),
        AgentFileSystem.layer(() =>
          Effect.fail(new AgentFileSystem.FileNotFound({ message: "unused" })),
        ),
        OpenSsh.layer({
          readDirectory: (alias, path) => {
            assert.strictEqual(alias, "workstation");

            if (path === "/srv/repo/.claude/skills") {
              return Effect.succeed([{ isDirectory: true, name: "review" }]);
            }

            return Effect.fail(new OpenSsh.RemoteFileNotFound({ message: "missing" }));
          },
          readFile: (_alias, path) => {
            assert.strictEqual(path, "/srv/repo/.claude/skills/review/SKILL.md");

            return Effect.succeed("---\nname: review\n---\nBody");
          },
          resolve: () => Effect.succeed(""),
        }),
        InstalledSkills.liveLayer,
      ),
    });

    const response = await app.request(
      "/skills?target=ssh&alias=workstation&tool=claude-code&projectPath=/srv/repo",
    );

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      skills: [
        {
          agent: "claude-code",
          metadataState: "parsed",
          name: "review",
          path: "/srv/repo/.claude/skills/review",
          skillFilePath: "/srv/repo/.claude/skills/review/SKILL.md",
          source: {
            agent: "claude-code",
            path: "/srv/repo/.claude/skills",
            scope: "project",
            state: "scanned",
          },
        },
      ],
      sources: [
        {
          agent: "claude-code",
          path: "/srv/repo/.claude/skills",
          scope: "project",
          state: "scanned",
        },
        {
          agent: "claude-code",
          error: "missing",
          path: "~/.claude/skills",
          scope: "user",
          state: "missing",
        },
      ],
      target: { alias: "workstation", type: "ssh" },
    });
  });

  it("rejects invalid installed skills targets", async () => {
    const app = createApp({
      layer: Layer.mergeAll(
        MachineInventory.layer({ machines: [] }),
        AgentFileSystem.layer(() => Effect.succeed("")),
        inertOpenSshLayer,
        emptyInstalledSkillsLayer,
      ),
    });

    const response = await app.request("/skills?target=ssh");

    assert.strictEqual(response.status, 400);
    assert.deepStrictEqual(await response.json(), {
      error: "target must be local or ssh with alias",
    });
  });
});

const inertOpenSshLayer = OpenSsh.layer({
  readFile: () =>
    Effect.fail(
      new OpenSsh.ConnectionFailed({
        message: "OpenSSH is not expected in this test",
      }),
    ),
  resolve: () =>
    Effect.fail(
      new OpenSsh.ConnectionFailed({
        message: "OpenSSH is not expected in this test",
      }),
    ),
});

const emptyInstalledSkillsLayer = InstalledSkills.layer({
  skills: [],
  sources: [],
  target: { type: "local" },
});
