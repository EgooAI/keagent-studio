export const Strategy = Object.freeze({
  COOKIE: "cookie",
  UI: "ui",
});

export interface OpenCliArg {
  name: string;
  type?: string;
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  help?: string;
  choices?: string[];
}

export interface OpenCliCommand {
  site: string;
  name: string;
  access: "read" | "write";
  description?: string;
  domain?: string;
  strategy?: string;
  browser?: boolean;
  navigateBefore?: boolean | string;
  args: OpenCliArg[];
  columns?: string[];
  func(
    page: unknown,
    kwargs: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>>;
}

const registry = new Map<string, OpenCliCommand>();

/**
 * OpenCLI adapters register themselves through `cli(...)`. AutoUp keeps that
 * registration shape so the vendored command bodies remain unchanged.
 */
export function cli(command: OpenCliCommand): void {
  if (command.access !== "read" && command.access !== "write") {
    throw new Error(
      `Command ${command.site}/${command.name} must declare access: 'read' | 'write'`,
    );
  }
  const strategy =
    command.strategy ??
    (command.browser === false ? "public" : Strategy.COOKIE);
  const browser =
    command.browser ?? (strategy !== "public" && strategy !== "local");
  let navigateBefore = command.navigateBefore;
  if (navigateBefore === undefined) {
    if (strategy === Strategy.COOKIE && command.domain) {
      navigateBefore = `https://${command.domain}`;
    } else if (browser) {
      navigateBefore = true;
    }
  }
  registry.set(`${command.site}/${command.name}`, {
    ...command,
    strategy,
    browser,
    navigateBefore,
  });
}

export function getRegistry(): ReadonlyMap<string, OpenCliCommand> {
  return registry;
}
