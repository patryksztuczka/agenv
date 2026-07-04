# OpenSSH CLI Is the SSH Authority

agenv should use the user's installed OpenSSH CLI for SSH-known machine resolution and remote file reads in the initial visibility module. The core should call OpenSSH for behavior such as alias resolution, configuration includes, authentication, and error messages instead of reimplementing SSH config semantics in Node.

This keeps agenv aligned with the user's existing SSH setup and avoids taking ownership of private key handling or partial SSH compatibility too early.
