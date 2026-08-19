import { truncateUtf8Prefix } from "./wireValidation";

export const MAX_SEARCH_QUERY_BYTES = 4_096;

/** Keep search state bounded without cutting a UTF-16 surrogate in half. */
export function boundSearchQuery(value: string): string {
  return truncateUtf8Prefix(value, MAX_SEARCH_QUERY_BYTES);
}

/** Normalize only for matching; callers can retain the original display text. */
export function normalizeSearchQuery(value: string): string {
  return boundSearchQuery(value.trim().toLocaleLowerCase());
}
