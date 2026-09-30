/**
 * The most characters an incoming webhook's id, and a receiver's inbox consumer name, may have. The outbox's inbox keeps
 * both in key columns of 255 characters on MySQL (`MySqlOutboxStore`): a longer id would pass verification, then fail
 * to be recorded at every redelivery, so the verifier refuses it (and a longer consumer name fails at startup).
 */
export const MAX_INBOX_KEY_LENGTH = 255;

/** Whether `value` has more than `MAX_INBOX_KEY_LENGTH` characters, counted as MySQL counts them: code points. */
export function exceedsInboxKey(value: string): boolean {
  // At most as many code points as UTF-16 units: counted only when the units are over the limit.
  return value.length > MAX_INBOX_KEY_LENGTH && [...value].length > MAX_INBOX_KEY_LENGTH;
}
