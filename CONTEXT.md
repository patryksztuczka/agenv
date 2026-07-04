# agenv

agenv is the control plane for agent environments: the settings, tools, and local state that make agents behave differently across machines.

## Language

**Agent Environment**:
The collection of agent-related configuration, tools, skills, MCP servers, prompts, profiles, permissions, and local overrides present on a machine.
_Avoid_: setup, dotfiles, agent state

**SSH-Known Machine**:
A remote machine that agenv can identify through the user's SSH configuration.
_Avoid_: discovered machine, scanned host, remote machine

**Machine Inventory**:
The set of machines agenv can inspect as possible agent environment targets, with each entry tied to the source that made it visible.
_Avoid_: host list, server list, fleet

**Syncable Machine**:
An SSH-Known Machine that agenv can present as an agent environment target.
_Avoid_: proper machine, valid host, server

**Resolved Machine Metadata**:
The minimal SSH connection details agenv can report for a Syncable Machine, such as alias, host name, user, port, and source.
_Avoid_: machine profile, host details

**Sync Direction**:
The selected flow of agent environment changes for a sync operation, either from the current machine to an SSH-Known Machine or from an SSH-Known Machine to the current machine.
_Avoid_: bidirectional sync, replication

**Push**:
A sync operation that applies selected agent environment changes from the current machine to an SSH-Known Machine.
_Avoid_: upload, deploy

**Pull**:
A sync operation that applies selected agent environment changes from an SSH-Known Machine to the current machine.
_Avoid_: download, import

**Config Family**:
A coherent group of native agent environment files owned by one agent tool or ecosystem.
_Avoid_: integration, provider, platform

**Codex Config Family**:
The Config Family for Codex-related native files.
_Avoid_: OpenAI config, first adapter

**Managed File**:
A native agent environment file that agenv may inspect, diff, preview, back up, and apply during a sync operation.
_Avoid_: resource, artifact, asset

**Codex Config File**:
The `~/.codex/config.toml` file within the Codex Config Family.
_Avoid_: Codex settings, Codex state

**Config Display**:
The presentation of a Managed File's native contents without advice, linting, or interpretation.
_Avoid_: hints, linting, validation

**Visibility**:
The ability to list Syncable Machines and display selected Managed Files from the current machine or an SSH-Known Machine without changing them.
_Avoid_: discovery, sync, inspection

**Managed File Snapshot**:
The current readable state of a Managed File on the current machine or an SSH-Known Machine, including enough metadata for clients to render missing and unreadable states without guessing.
_Avoid_: file response, config blob, read result

**Snapshot State**:
The status of a Managed File Snapshot, such as present, missing, unreadable, or connection failed.
_Avoid_: status, result, outcome
