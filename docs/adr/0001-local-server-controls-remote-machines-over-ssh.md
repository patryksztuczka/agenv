# Local Server Controls Remote Machines Over SSH

agenv clients should talk to a local agenv server on the user's current machine. The local server may inspect and sync SSH-Known Machines over SSH, but agenv should not require a daemon to be installed on every managed machine before those machines can be useful.

This keeps the first architecture easy to bootstrap and easy to explain: CLI, TUI, and future desktop clients share one local API, while remote machines remain ordinary SSH targets. A per-machine daemon may be introduced later if remote coordination needs outgrow SSH, but it is not part of the initial architecture.
