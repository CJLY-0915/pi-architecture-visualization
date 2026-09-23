export interface StoredValue {
  key: string;
}

export function store(values: string[]): number {
  return values.length;
}
