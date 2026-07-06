const STORAGE_PREFIX = "labelau:";

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

export function readStoredString(key: string, fallbackValue = ""): string {
  const storage = getStorage();
  if (!storage) {
    return fallbackValue;
  }

  return storage.getItem(`${STORAGE_PREFIX}${key}`) ?? fallbackValue;
}

export function writeStoredString(key: string, value: string): void {
  getStorage()?.setItem(`${STORAGE_PREFIX}${key}`, value);
}

export function removeStoredValue(key: string): void {
  getStorage()?.removeItem(`${STORAGE_PREFIX}${key}`);
}

export function readStoredNumber(
  key: string,
  fallbackValue: number,
  options: { min?: number; max?: number } = {},
): number {
  const rawValue = getStorage()?.getItem(`${STORAGE_PREFIX}${key}`);
  if (!rawValue?.trim()) {
    return fallbackValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    return fallbackValue;
  }

  const minValue = options.min ?? Number.NEGATIVE_INFINITY;
  const maxValue = options.max ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(parsedValue, minValue), maxValue);
}

export function writeStoredNumber(key: string, value: number): void {
  writeStoredString(key, String(value));
}

export function readStoredJson<TValue>(
  key: string,
  fallbackValue: TValue,
): TValue {
  const rawValue = readStoredString(key);
  if (!rawValue) {
    return fallbackValue;
  }

  try {
    return JSON.parse(rawValue) as TValue;
  } catch {
    return fallbackValue;
  }
}

export function writeStoredJson<TValue>(key: string, value: TValue): void {
  writeStoredString(key, JSON.stringify(value));
}
