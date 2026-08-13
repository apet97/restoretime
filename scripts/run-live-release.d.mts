export interface RedactedLiveOutput {
  readonly output: string;
  readonly leakedSecretNames: readonly string[];
}

export function redactLiveSecrets(
  rawOutput: string,
  childEnvironment: Readonly<Record<string, string | undefined>>,
): RedactedLiveOutput;

export function inspectLiveRun(output: string): {
  readonly skipped: boolean;
  readonly incomplete: boolean;
};
