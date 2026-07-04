# agenv

agenv is the control plane for agent environments: the settings, tools, and local state that make agents behave differently across machines.

## Language

**Agent Environment**:
The collection of agent-related configuration, tools, skills, MCP servers, prompts, profiles, permissions, and local overrides present on a machine.
_Avoid_: setup, dotfiles, agent state

**SSH-Known Host**:
A host entry that agenv can identify through the user's SSH configuration.
_Avoid_: discovered machine, scanned machine, remote machine

**Host Inventory**:
The set of SSH-Known Hosts agenv can inspect as possible agent environment targets, with each entry tied to the source that made it visible.
_Avoid_: machine inventory, server list, fleet

**Syncable Host**:
An SSH-Known Host that agenv can present as an agent environment target.
_Avoid_: proper machine, valid machine, server

**Resolved Host Metadata**:
The minimal SSH connection details agenv can report for a Syncable Host, such as alias, host name, user, port, and source.
_Avoid_: host profile, machine details

**Sync Direction**:
The selected flow of agent environment changes for a sync operation, either from the current machine to an SSH-Known Host or from an SSH-Known Host to the current machine.
_Avoid_: bidirectional sync, replication

**Push**:
A sync operation that applies selected agent environment changes from the current machine to an SSH-Known Host.
_Avoid_: upload, deploy

**Pull**:
A sync operation that applies selected agent environment changes from an SSH-Known Host to the current machine.
_Avoid_: download, import

**Preview**:
The non-mutating presentation of what an agenv operation would change if applied.
_Avoid_: dry run, plan

**Apply**:
The explicit mutating execution of a previously previewable agenv operation.
_Avoid_: run, execute, confirm

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
The ability to list Syncable Hosts and display selected Managed Files from the current machine or an SSH-Known Host without changing them.
_Avoid_: discovery, sync, inspection

**Managed File Snapshot**:
The current readable state of a Managed File on the current machine or an SSH-Known Host, including enough metadata for clients to render missing and unreadable states without guessing.
_Avoid_: file response, config blob, read result

**Snapshot State**:
The status of a Managed File Snapshot, such as present, missing, unreadable, or connection failed.
_Avoid_: status, result, outcome
