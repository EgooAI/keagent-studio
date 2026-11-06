export const EXIT_CODES = Object.freeze({
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
  TEMPFAIL: 75,
  NOPERM: 77,
});

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly exitCode: number = EXIT_CODES.GENERIC_ERROR,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class CommandExecutionError extends CliError {
  constructor(message: string, hint?: string) {
    super("COMMAND_EXEC", message, hint);
  }
}

export class AuthRequiredError extends CliError {
  constructor(
    readonly domain: string,
    message?: string,
  ) {
    super(
      "AUTH_REQUIRED",
      message ?? `Not logged in to ${domain}`,
      `Please open Chrome or Chromium and log in to https://${domain}`,
      EXIT_CODES.NOPERM,
    );
  }
}

export class TimeoutError extends CliError {
  constructor(label: string, seconds: number, hint?: string) {
    super(
      "TIMEOUT",
      `${label} timed out after ${seconds}s`,
      hint ??
        "Try again, or increase timeout with --timeout <seconds> (or OPENCLI_BROWSER_COMMAND_TIMEOUT for the global default)",
      EXIT_CODES.TEMPFAIL,
    );
  }
}

export class ArgumentError extends CliError {
  constructor(message: string, hint?: string) {
    super("ARGUMENT", message, hint, EXIT_CODES.USAGE_ERROR);
  }
}
