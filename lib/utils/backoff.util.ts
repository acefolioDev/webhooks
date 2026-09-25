import { toMs } from './duration.util.js';
import type { Duration } from '../interfaces/duration.interface.js';
import type { WebhookRetryOptions, WebhooksModuleOptions } from '../interfaces/webhooks-module-options.interface.js';
import type { WebhookDelivery } from '../interfaces/webhook-delivery.interface.js';

const DEFAULT_ATTEMPTS = 10;

/**
 * 5s, 20s, 80s, 5m20s, 21m, 85m, 5.7h, 22.7h, then 1d: nine waits, about 54 hours at most
 * and 40 on average with equal jitter. The Standard Webhooks spec recommends "a retry
 * schedule spanning multiple days, with an exponential backoff" and jitter.
 */
const DEFAULT_BACKOFF = { delay: 5_000, factor: 4, maxDelay: 86_400_000, jitter: 'equal' } as const;

const JITTERS: readonly unknown[] = ['full', 'equal', 'none'];

type BackoffFn = (attempt: number, error: unknown, delivery: WebhookDelivery) => Duration;

type ResolvedBackoff =
  | { delay: number; factor: number; maxDelay: number; jitter: 'full' | 'equal' | 'none' }
  | BackoffFn;

export interface ResolvedRetry {
  attempts: number;
  backoff: ResolvedBackoff;
  retryIf?: WebhookRetryOptions['retryIf'];
}

/** Resolves the `retry` option once, at startup: bad values fail naming the option. */
export function resolveRetry(retry: WebhooksModuleOptions['retry']): ResolvedRetry {
  const options: WebhookRetryOptions =
    retry === false ? { attempts: 1 } : typeof retry === 'number' ? { attempts: retry } : (retry ?? {});

  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(
      `WebhooksModule: retry.attempts must be a whole number of at least 1 (got ${attempts}). Use \`retry: false\` for a single attempt.`,
    );
  }

  const { backoff, retryIf } = options;
  if (retryIf !== undefined && typeof retryIf !== 'function') {
    throw new TypeError(`WebhooksModule: retry.retryIf must be a function (got ${typeof retryIf})`);
  }

  if (typeof backoff === 'function') {
    return { attempts, backoff, retryIf };
  }

  if (backoff !== undefined && (backoff === null || typeof backoff !== 'object')) {
    throw new TypeError(
      'WebhooksModule: retry.backoff must be { delay, factor, maxDelay, jitter } or a function ' +
        `(got ${backoff === null ? 'null' : typeof backoff}). For a fixed wait, use { delay: ${String(backoff)}, factor: 1 }.`,
    );
  }

  const factor = backoff?.factor ?? DEFAULT_BACKOFF.factor;
  if (!(factor >= 1)) {
    throw new TypeError(`WebhooksModule: retry.backoff.factor must be at least 1 (got ${factor})`);
  }

  const jitter = backoff?.jitter ?? DEFAULT_BACKOFF.jitter;
  if (!JITTERS.includes(jitter)) {
    throw new TypeError(`WebhooksModule: retry.backoff.jitter must be "full", "equal" or "none" (got ${JSON.stringify(jitter)})`);
  }

  return {
    attempts,
    retryIf,
    backoff: {
      delay: optionMs(backoff?.delay ?? DEFAULT_BACKOFF.delay, 'retry.backoff.delay'),
      factor,
      maxDelay: optionMs(backoff?.maxDelay ?? DEFAULT_BACKOFF.maxDelay, 'retry.backoff.maxDelay'),
      jitter,
    },
  };
}

/** `toMs()` for a module option: the error names the option. */
export function optionMs(value: Duration, option: string): number {
  try {
    return toMs(value);
  } catch (error) {
    throw new TypeError(`WebhooksModule: ${option}: ${(error as Error).message}`);
  }
}

/** A module option that must be a duration longer than zero. */
export function positiveMs(value: Duration, option: string): number {
  const ms = optionMs(value, option);
  if (ms <= 0) {
    throw new TypeError(`WebhooksModule: ${option} must be longer than 0 (got ${String(value)})`);
  }
  return ms;
}

/** Delay before the next attempt, after attempt number `attempt` (1-based) failed. */
export function computeBackoff(
  backoff: ResolvedBackoff,
  attempt: number,
  error: unknown,
  delivery: WebhookDelivery,
  random: () => number = Math.random,
): number {
  if (typeof backoff === 'function') {
    return Math.floor(toMs(backoff(attempt, error, delivery)));
  }

  const { delay, factor, maxDelay, jitter } = backoff;
  const ceiling = Math.min(maxDelay, delay * factor ** (attempt - 1));

  switch (jitter) {
    case 'none':
      return Math.floor(ceiling);
    case 'full':
      return Math.floor(random() * ceiling);
    default:
      return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
  }
}

// The three HTTP-date forms (RFC 9110 §5.6.7). `Date.parse()` alone would read almost anything as a
// date ("1.5" is January 2001), turning a malformed value into "retry now" instead of ignoring it.
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE = /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

/** A `Retry-After` value (seconds or an HTTP date) in ms from `now`, or undefined. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  let date = Number.NaN;
  if (IMF_FIXDATE.test(trimmed) || RFC850_DATE.test(trimmed)) {
    date = Date.parse(trimmed);
  } else if (ASCTIME_DATE.test(trimmed)) {
    // asctime carries no zone, and HTTP dates are always GMT.
    date = Date.parse(`${trimmed} GMT`);
  }

  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
