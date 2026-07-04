# Diagnostics

Use `agenv diagnostics package-manager-config` when collecting package-manager
configuration for support, QA notes, CI logs, or bug reports.

The command inspects npm and pnpm configuration through agenv and redacts values
for token-like keys before anything is printed. Use
`agenv diagnostics package-manager-config --json` when an agent or automation
needs structured output.

Redaction currently applies to keys containing token, password, secret,
credential, auth, and `_authToken`-style names. The output is still a native
diagnostic view, but sensitive values are replaced with `<redacted>`.
