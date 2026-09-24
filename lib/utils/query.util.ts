/**
 * `limit` and `offset` as a store hands them to SQL: whole numbers, or absent. A partner API
 * passes them from the query string; a `NaN` or a negative would fail in the store instead.
 */
export function checkPage<Q extends { limit?: number; offset?: number }>(query: Q, where: string): Q {
  const { limit, offset } = query;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new TypeError(`${where}: limit must be a whole number of at least 1 (got ${limit})`);
  }
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new TypeError(`${where}: offset must be a whole number of at least 0 (got ${offset})`);
  }
  return query;
}
