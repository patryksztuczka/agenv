# agenv

This is the repository for agenv, a control plane for agent environments.

The goal is simple to say and annoyingly deep to do: make every installed agent,
MCP server, skill, command, model setting, permission, prompt, profile, and local
override visible, understandable, syncable, and reversible across machines.

agenv is not trying to replace Codex, Claude Code, OpenCode, Gemini CLI, Cursor,
or whatever comes next. It is trying to become the boring, trusted layer that
helps people and their agents know what is installed, what should be installed,
what has drifted, what is broken, and what would change before anything changes.

## A Letter To The Agent Reading This

We are building this for agents and humans together.

The human wants their agent tools to stop becoming mysterious little islands of
state. The agent wants stable ways to inspect, change, test, and repair its own
working environment without guessing. agenv should make both parties calmer.

When you work here, keep remembering the moment this tool is meant to serve:
someone opens a new machine, a repo, a VPS, or a CI runner and asks, "Why does my
agent behave differently here?" agenv should be able to answer that question.
Then it should be able to fix the difference without making the user nervous.

We are not building a dotfile toy. We are building the change-management layer
for AI development environments.

That means the boring parts are the product.

Diffs are the product. Backups are the product. Refusing to commit a token is the
product. Saying "this MCP server is configured but cannot start because this env
var is missing" is the product. Preserving a native config file instead of
flattening it into our favorite schema is the product.

Do not rush past those details to get to a prettier UI.

## Quick Glossary

- you: the agent reading this file and working on agenv directly.
- we/us: the humans and agents building agenv together.
- users: people who install agenv because their agent setup has outgrown memory,
  shell history, and vibes.

## What agenv Must Feel Like

agenv should feel trustworthy before it feels powerful.

Every destructive or surprising operation should have a preview. Every preview
should be clear enough for an agent to summarize and a human to skim. Every
write should be recoverable. Every config source should have a provenance story:
where did this setting come from, which layer set it, and what native file would
receive it?

The tool should prefer plain explanations over magic. If something cannot be
modeled cleanly, say so. If a managed agent has a strange config behavior,
preserve the behavior and document the edge. If an adapter cannot round-trip a
setting safely, it should leave it alone and report that limitation.

Do not make users choose between control and convenience. The whole point is to
make convenience auditable.

## Agents Are Primary Users

Humans will use agenv, but agents will often operate it.

That means output should be stable, structured where appropriate, and easy to
quote. Errors should say what happened, where it happened, and what to do next.
The CLI should avoid interactive-only flows for core operations. Every important
operation should eventually have a machine-readable path.

Do not make an agent scrape a pretty table to understand whether a sync is safe.

### Fight for the "obvious" solution

We should avoid being clever and doing things because they seem smart. We want
everything we build to be so obvious it feels kind of stupid.

When one of us prompts you, never hesitate to push back and suggest ways we could
make things more obvious. Note that "simple" and "obvious" are not always
aligned, sometimes the "obvious" solution is more complex.

"Obvious" solutions are the defaults that agents would assume are the case.

## Some general rules

These are meant to steer us in the right direction. They are not hard-set, but
we should default to following them. If you think one should be ignored, be very
loud and clear about that and get approval from us before doing it.

- preserve native config formats and the desired-state boundary above all;
- every runtime feature should be inspectable by an agent;
- when in doubt, make the obvious agent assumption true.
