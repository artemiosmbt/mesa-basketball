// Supabase's API returns at most 1,000 rows per request, silently: a query
// that matches more just comes back cut off, with no error. In Nov 2026 the
// payroll sync's registrations read crossed 1,000 matches and the newest ~40
// bookings (most of a week's sessions) never reached the payroll sheet.
// Any read that isn't narrowed to a handful of rows goes through here.
//
// `build` must return a FRESH query each call (a query builder can only be
// awaited once). Pages are ordered by `id` (after any order the query
// already has) so rows can't shift between pages.

const PAGE_SIZE = 1000;

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}
interface RangeableQuery<T> extends PromiseLike<PageResult<T>> {
  order(column: string, opts?: { ascending?: boolean }): RangeableQuery<T>;
  range(from: number, to: number): PromiseLike<PageResult<T>>;
}
// The row type of a Supabase query, so callers keep the same typing they
// had from awaiting the query directly.
type RowOf<Q> = Q extends PromiseLike<{ data: (infer R)[] | null }> ? R : never;

export async function fetchAllRows<Q extends PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>>(
  build: () => Q
): Promise<{ data: RowOf<Q>[]; error: { message: string } | null }> {
  const all: RowOf<Q>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const query = build() as unknown as RangeableQuery<RowOf<Q>>;
    const { data, error } = await query.order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) return { data: all, error };
    const page = data || [];
    all.push(...page);
    if (page.length < PAGE_SIZE) return { data: all, error: null };
  }
}

// `.in(column, ids)` puts every id in the URL; a few hundred UUIDs is past
// what the API accepts. Splits the ids into chunks and merges the results.
export async function fetchInChunks<Q extends PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>>(
  ids: string[],
  build: (chunk: string[]) => Q,
  chunkSize = 200
): Promise<{ data: RowOf<Q>[]; error: { message: string } | null }> {
  const all: RowOf<Q>[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await build(ids.slice(i, i + chunkSize));
    if (error) return { data: all, error };
    all.push(...((data || []) as RowOf<Q>[]));
  }
  return { data: all, error: null };
}
