import { run } from './invoke.js';
import leftPad from 'left-pad';
import missing from 'not-declared-pkg';

const specifier = './optional.js';
const mod = await import(specifier);
const legacy = require('missing-local');
const other = require('./store');

export function main() {
  return run(leftPad, missing, mod, legacy, other);
}
