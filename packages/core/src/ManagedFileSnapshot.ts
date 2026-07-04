/**
 * Stable state machine for Managed File Snapshots.
 *
 * Clients should branch on this value instead of scraping error strings.
 */
export type SnapshotState = "present" | "missing" | "unreadable" | "connection-failed";

/**
 * Display-ready envelope for a managed native config file.
 *
 * `contents` is present only when the file is readable. Empty string contents
 * still mean `state: "present"`, not missing.
 */
interface ManagedFileSnapshotBase {
  readonly configFamily: "codex";
  readonly managedFile: "config.toml";
  readonly path: string;
}

export type ManagedFileSnapshot =
  | (ManagedFileSnapshotBase & {
      readonly contents: string;
      readonly error?: never;
      readonly state: "present";
    })
  | (ManagedFileSnapshotBase & {
      readonly contents?: never;
      readonly error: string;
      readonly state: Exclude<SnapshotState, "present">;
    });
