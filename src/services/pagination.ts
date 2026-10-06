import { HttpError } from './httpError';

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

const maxOffset = 2147483647;

function invalidParameter(field: 'page' | 'limit'): never {
  throw new HttpError(400, `El parámetro ${field} no es válido`, { code: 'validation_error', field });
}

function positiveInteger(value: unknown, field: 'page' | 'limit', fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return invalidParameter(field);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) return invalidParameter(field);
  return number;
}

export function parsePagination(query: { page?: unknown; limit?: unknown }): Pagination {
  const page = positiveInteger(query.page, 'page', 1, maxOffset);
  const limit = positiveInteger(query.limit, 'limit', 50, 200);
  const skip = (page - 1) * limit;
  if (!Number.isSafeInteger(skip) || skip > maxOffset) return invalidParameter('page');
  return { page, limit, skip };
}

export function pageResult<T>(rows: T[], { page, limit }: Pagination) {
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit), page, limit, hasMore, nextPage: hasMore ? page + 1 : null };
}

export function paginationHeaders(result: { hasMore: boolean; nextPage: number | null }) {
  return {
    'X-Has-More': String(result.hasMore),
    'X-Next-Page': result.nextPage === null ? '' : String(result.nextPage)
  };
}
