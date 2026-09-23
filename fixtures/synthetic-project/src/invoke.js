import './store.ts';

export function run(...values) {
  return values.filter((value) => value !== undefined).length;
}
