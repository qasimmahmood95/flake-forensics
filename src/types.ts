/** Internal run/test model, decoupled from the Playwright report shape. */

export interface AttemptError {
  message: string;
  stack?: string;
}

export interface Attempt {
  /** Playwright result status: passed | failed | timedOut | skipped | interrupted. */
  status: string;
  retry: number;
  error?: AttemptError;
}

/**
 * Final per-run outcome of one test:
 * - passed:   passed on the first attempt
 * - rescued:  at least one attempt failed, final attempt passed (the flake signature)
 * - failed:   final attempt failed (retries exhausted, or none configured)
 * - skipped:  did not run
 */
export type FinalOutcome = 'passed' | 'rescued' | 'failed' | 'skipped';

export interface TestOccurrence {
  testId: string;
  file: string;
  title: string;
  outcome: FinalOutcome;
  attempts: Attempt[];
}

export interface RunRecord {
  runId: string;
  commit: string;
  /** ISO 8601 timestamp of the run. */
  timestamp: string;
  /** Report file this run was loaded from. */
  sourceFile: string;
  tests: TestOccurrence[];
}
