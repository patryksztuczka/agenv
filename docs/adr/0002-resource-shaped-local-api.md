# Resource-Shaped Local API

agenv's local server should expose inspectable resources rather than command-shaped RPC endpoints. CLI, TUI, and future desktop clients should all be able to list Syncable Machines and request Managed File Snapshots through stable resource endpoints.

This keeps the API aligned with agenv's goal of making agent environments visible and understandable. Command names may still exist in clients, but the shared server contract should describe what exists, not just which action to run.
