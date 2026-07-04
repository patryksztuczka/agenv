import { Effect } from "effect";
import type { ManagedFileSnapshot, SnapshotState } from "./ManagedFileSnapshot.js";

export interface SnapshotMetadata {
  readonly configFamily: "codex";
  readonly error?: string;
  readonly managedFile: "config.toml";
  readonly path: string;
  readonly state: SnapshotState;
}

export interface PreviewOptions {
  readonly left: ManagedFileSnapshot;
  readonly right: ManagedFileSnapshot;
}

export interface Preview {
  readonly diff: string | null;
  readonly left: SnapshotMetadata;
  readonly reason: string | null;
  readonly right: SnapshotMetadata;
}

type DiffOperation =
  | {
      readonly line: string;
      readonly type: "same";
    }
  | {
      readonly line: string;
      readonly type: "remove";
    }
  | {
      readonly line: string;
      readonly type: "add";
    };

export const preview = Effect.fn("CodexConfigDiff.preview")((options: PreviewOptions) =>
  Effect.succeed(makePreview(options)),
);

const makePreview = (options: PreviewOptions) => {
  const left = metadataFor(options.left);
  const right = metadataFor(options.right);

  if (options.left.state !== "present") {
    return {
      diff: null,
      left,
      reason: `left snapshot is ${options.left.state}`,
      right,
    } satisfies Preview;
  }

  if (options.right.state !== "present") {
    return {
      diff: null,
      left,
      reason: `right snapshot is ${options.right.state}`,
      right,
    } satisfies Preview;
  }

  return {
    diff: unifiedDiff({
      leftContents: options.left.contents,
      leftPath: options.left.path,
      rightContents: options.right.contents,
      rightPath: options.right.path,
    }),
    left,
    reason: null,
    right,
  } satisfies Preview;
};

const metadataFor = (snapshot: ManagedFileSnapshot): SnapshotMetadata => {
  if (snapshot.state === "present") {
    return {
      configFamily: snapshot.configFamily,
      managedFile: snapshot.managedFile,
      path: snapshot.path,
      state: snapshot.state,
    };
  }

  return {
    configFamily: snapshot.configFamily,
    error: snapshot.error,
    managedFile: snapshot.managedFile,
    path: snapshot.path,
    state: snapshot.state,
  };
};

const unifiedDiff = (options: {
  readonly leftContents: string;
  readonly leftPath: string;
  readonly rightContents: string;
  readonly rightPath: string;
}) => {
  const operations = diffLines(splitLines(options.leftContents), splitLines(options.rightContents));

  return [
    `--- ${options.leftPath}`,
    `+++ ${options.rightPath}`,
    "@@ -1 +1 @@",
    ...operations.map(renderOperation),
  ].join("\n");
};

const splitLines = (contents: string) => {
  if (contents.length === 0) {
    return [];
  }

  const lines = contents.split("\n");

  if (lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }

  return lines;
};

const diffLines = (left: readonly string[], right: readonly string[]) => {
  const lengths = longestCommonSubsequenceLengths(left, right);
  const operations: Array<DiffOperation> = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length || rightIndex < right.length) {
    const leftLine = left[leftIndex];
    const rightLine = right[rightIndex];

    if (leftLine !== undefined && rightLine !== undefined && leftLine === rightLine) {
      operations.push({
        line: leftLine,
        type: "same",
      });
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      rightLine !== undefined &&
      (leftLine === undefined ||
        matrixValue(lengths, leftIndex, rightIndex + 1) >=
          matrixValue(lengths, leftIndex + 1, rightIndex))
    ) {
      operations.push({
        line: rightLine,
        type: "add",
      });
      rightIndex += 1;
    } else if (leftLine !== undefined) {
      operations.push({
        line: leftLine,
        type: "remove",
      });
      leftIndex += 1;
    }
  }

  return operations;
};

const longestCommonSubsequenceLengths = (left: readonly string[], right: readonly string[]) => {
  const rows: Array<Array<number>> = [];

  for (let leftIndex = 0; leftIndex <= left.length; leftIndex += 1) {
    const row: Array<number> = [];

    for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
      row.push(0);
    }

    rows.push(row);
  }

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const row = rows[leftIndex];

      if (row !== undefined) {
        row[rightIndex] =
          left[leftIndex] === right[rightIndex]
            ? matrixValue(rows, leftIndex + 1, rightIndex + 1) + 1
            : Math.max(
                matrixValue(rows, leftIndex + 1, rightIndex),
                matrixValue(rows, leftIndex, rightIndex + 1),
              );
      }
    }
  }

  return rows;
};

const matrixValue = (
  matrix: ReadonlyArray<ReadonlyArray<number>>,
  rowIndex: number,
  columnIndex: number,
) => matrix[rowIndex]?.[columnIndex] ?? 0;

const renderOperation = (operation: DiffOperation) => {
  switch (operation.type) {
    case "add":
      return `+${operation.line}`;
    case "remove":
      return `-${operation.line}`;
    case "same":
      return ` ${operation.line}`;
  }
};
