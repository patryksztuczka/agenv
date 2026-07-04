import { Context, Effect, Layer, Schema } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);

export type PackageManager = "npm" | "pnpm";

export interface CommandOutput {
  readonly stderr: string;
  readonly stdout: string;
}

export class PackageManagerConfigUnavailable extends Schema.TaggedErrorClass<PackageManagerConfigUnavailable>()(
  "PackageManagerConfigUnavailable",
  {
    message: Schema.String,
    stderr: Schema.String,
    stdout: Schema.String,
  },
) {}

export class PackageManagerConfigFailed extends Schema.TaggedErrorClass<PackageManagerConfigFailed>()(
  "PackageManagerConfigFailed",
  {
    message: Schema.String,
    stderr: Schema.String,
    stdout: Schema.String,
  },
) {}

export type ConfigReadFailure = PackageManagerConfigUnavailable | PackageManagerConfigFailed;

export interface ConfigDiagnostic {
  readonly error?: string;
  readonly output: string;
  readonly packageManager: PackageManager;
  readonly redacted: true;
  readonly source: "package-manager-config";
  readonly status: "failed" | "ok" | "unavailable";
  readonly stderr: string;
}

export interface DiagnosticsReport {
  readonly packageManagerConfigs: readonly ConfigDiagnostic[];
}

export class PackageManagerConfigReader extends Context.Service<
  PackageManagerConfigReader,
  {
    readonly read: (
      packageManager: PackageManager,
    ) => Effect.Effect<CommandOutput, ConfigReadFailure>;
  }
>()("PackageManagerConfigReader") {}

export const layer = (
  read: (packageManager: PackageManager) => Effect.Effect<CommandOutput, ConfigReadFailure>,
) =>
  Layer.succeed(PackageManagerConfigReader)({
    read,
  });

export const liveLayer = layer((packageManager) =>
  Effect.tryPromise({
    catch: (error) => classifyConfigReadFailure(error),
    try: async () => {
      const result = await execFilePromise(packageManager, ["config", "list"], {
        maxBuffer: 1024 * 1024,
      });

      return {
        stderr: result.stderr,
        stdout: result.stdout,
      };
    },
  }),
);

export const inspectPackageManagerConfigs = Effect.fn(
  "PackageManagerDiagnostics.inspectPackageManagerConfigs",
)(function* (
  options: {
    readonly packageManagers?: readonly PackageManager[];
  } = {},
) {
  const reader = yield* PackageManagerConfigReader;
  const packageManagers = options.packageManagers ?? defaultPackageManagers;
  const diagnostics: ConfigDiagnostic[] = [];

  for (const packageManager of packageManagers) {
    const diagnostic: ConfigDiagnostic = yield* reader.read(packageManager).pipe(
      Effect.match({
        onFailure: (failure) =>
          ({
            error: redactPackageManagerConfig(failure.message),
            output: redactPackageManagerConfig(failure.stdout),
            packageManager,
            redacted: true,
            source: "package-manager-config",
            status: failure instanceof PackageManagerConfigUnavailable ? "unavailable" : "failed",
            stderr: redactPackageManagerConfig(failure.stderr),
          }) satisfies ConfigDiagnostic,
        onSuccess: (output) =>
          ({
            output: redactPackageManagerConfig(output.stdout),
            packageManager,
            redacted: true,
            source: "package-manager-config",
            status: "ok",
            stderr: redactPackageManagerConfig(output.stderr),
          }) satisfies ConfigDiagnostic,
      }),
    );

    diagnostics.push(diagnostic);
  }

  return {
    packageManagerConfigs: diagnostics,
  } satisfies DiagnosticsReport;
});

export const redactPackageManagerConfig = (output: string) =>
  output
    .split(/(\r?\n)/)
    .map((part) => (part === "\n" || part === "\r\n" ? part : redactConfigLine(part)))
    .join("");

const defaultPackageManagers = ["npm", "pnpm"] as const satisfies readonly PackageManager[];
const redaction = "<redacted>";
const tokenLiteralPatterns = [
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bnpm_[A-Za-z0-9_]{8,}\b/g,
] as const;
const bearerTokenPattern = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi;

const redactConfigLine = (line: string) => {
  const equalMatch = /^(\s*(?:[;#]\s*)?)([^=\s][^=]*?)(\s*=\s*)(.*)$/.exec(line);

  if (equalMatch !== null) {
    const [, prefix, key, separator, value] = equalMatch;

    if (isSensitiveConfigKey(key ?? "")) {
      return `${prefix}${key}${separator}${redactedValue(value ?? "")}`;
    }
  }

  const colonMatch = /^(\s*)(["']?[A-Za-z0-9_.-]+["']?)(\s*:\s*)(.*)$/.exec(line);

  if (colonMatch !== null) {
    const [, prefix, key, separator, value] = colonMatch;

    if (isSensitiveConfigKey(key ?? "")) {
      return `${prefix}${key}${separator}${redactedValue(value ?? "")}`;
    }
  }

  return redactTokenLiterals(line);
};

const isSensitiveConfigKey = (key: string) => {
  const normalizedKey = key
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  const segments = normalizedKey.split(/[^a-z0-9]+/).filter((segment) => segment.length > 0);

  return segments.some(
    (segment) =>
      segment === "auth" ||
      segment.includes("authtoken") ||
      segment.includes("token") ||
      segment.includes("password") ||
      segment.includes("secret") ||
      segment.includes("credential"),
  );
};

const redactedValue = (value: string) => {
  const leadingWhitespaceLength = value.length - value.trimStart().length;
  const leadingWhitespace = value.slice(0, leadingWhitespaceLength);
  const trimmedValue = value.trim();
  const trailingComma = trimmedValue.endsWith(",") ? "," : "";
  const withoutComma =
    trailingComma.length === 0 ? trimmedValue : trimmedValue.slice(0, -trailingComma.length);
  const quote = withoutComma.startsWith('"') ? '"' : withoutComma.startsWith("'") ? "'" : "";

  return `${leadingWhitespace}${quote}${redaction}${quote}${trailingComma}`;
};

const redactTokenLiterals = (value: string) =>
  tokenLiteralPatterns
    .reduce((currentValue, pattern) => currentValue.replace(pattern, redaction), value)
    .replace(bearerTokenPattern, `$1${redaction}`);

const classifyConfigReadFailure = (error: unknown): ConfigReadFailure => {
  const failure = {
    message: errorMessage(error),
    stderr: outputText(error, "stderr"),
    stdout: outputText(error, "stdout"),
  };

  if (isCommandUnavailable(error)) {
    return new PackageManagerConfigUnavailable(failure);
  }

  return new PackageManagerConfigFailed(failure);
};

const isCommandUnavailable = (error: unknown) => {
  if (typeof error === "object" && error !== null && "code" in error) {
    return error.code === "ENOENT";
  }

  return false;
};

const outputText = (error: unknown, key: "stderr" | "stdout") => {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Partial<Record<"stderr" | "stdout", unknown>>)[key];

    return typeof value === "string" ? value : "";
  }

  return "";
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Package manager config inspection failed";
