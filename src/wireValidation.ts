const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function stripTrailingUnpairedSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return value.slice(0, -1);
  if (last >= 0xdc00 && last <= 0xdfff) {
    const previous = value.charCodeAt(value.length - 2);
    if (!(previous >= 0xd800 && previous <= 0xdbff)) return value.slice(0, -1);
  }
  return value;
}

/** Return the longest UTF-8 bounded prefix without splitting a surrogate pair. */
export function truncateUtf8Prefix(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return stripTrailingUnpairedSurrogate(value);
  if (!(maxBytes > 0)) return "";
  let low = 0;
  let high = Math.min(value.length, Math.floor(maxBytes));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return stripTrailingUnpairedSurrogate(value.slice(0, low));
}

export function isWireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Keep JavaScript wire values representable by Rust `f32` fields. */
export function isFiniteF32(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

export function isBoundedUtf8String(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) return false;
  return utf8ByteLength(value) <= maxBytes;
}
