# Shared Core Package Owns Domain Logic

agenv should place machine inventory, Managed File Snapshot types, and Config Family logic in a shared core package rather than inside the API app. The local API should wrap the core model for HTTP clients, while CLI, TUI, and future clients can share the same behavior instead of rediscovering it.

This keeps the server boundary from becoming the product model. It also makes the first visibility module easier to test without running the local server.
