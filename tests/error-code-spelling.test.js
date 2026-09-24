'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The "model failed structural validation" condition is spelled three
// different ways across this repository, and error-codes.js says an existing
// code must never be renamed. This suite does not try to fix that; it pins the
// actual distribution so a fourth spelling cannot appear silently, and so the
// split stays visible to whoever finally unifies it.
const UPPER = 'INVALID_MODEL';
const LOWER = 'invalid_model';
const UNSUPPORTED = 'unsupported_input';

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

function count(source, literal) {
  return [...source.matchAll(new RegExp(`['"]${literal}['"]`, 'g'))].length;
}

test('the invalid-model condition keeps exactly two literal spellings and no third', () => {
  // `unsupported_input` is deliberately not counted here: it is a general
  // "this input is not supported" code used for many conditions, so counting
  // it would flag any unrelated use. impact.js's mapping onto it is asserted
  // separately below.
  const files = ['src/host/read-model.js', 'src/host/save-model.js', 'src/core/export-preview.js',
    'src/core/diagram.js', 'src/core/drift.js', 'src/core/impact.js'];
  const spellings = new Set();
  for (const file of files) {
    const source = read(file);
    for (const literal of [UPPER, LOWER]) {
      if (count(source, literal) > 0) spellings.add(literal);
    }
  }
  assert.deepEqual([...spellings].sort(), [LOWER, UPPER].sort(),
    'the invalid-model condition must stay at two known spellings, not grow a third');
  // Both spellings must actually be in use: if one side migrated to the other,
  // the split would be gone and this suite would be asserting a fiction.
  assert.equal(count(read('src/host/read-model.js'), UPPER) > 0, true, 'the host layer must still use the uppercase spelling');
  assert.equal(count(read('src/core/export-preview.js'), LOWER) > 0, true, 'the core layer must still use the lowercase spelling');
});
test('the host layer and the core layer each keep their own spelling', () => {
  // A caller switching on this condition has to accept both, so neither side
  for (const file of ['src/host/read-model.js', 'src/host/save-model.js']) {
    assert.ok(count(read(file), UPPER) > 0, `${file} must keep the uppercase spelling`);
    assert.equal(count(read(file), LOWER), 0, `${file} must not also use the lowercase spelling`);
  }
  for (const file of ['src/core/export-preview.js', 'src/core/diagram.js', 'src/core/drift.js']) {
    assert.ok(count(read(file), LOWER) > 0, `${file} must keep the lowercase spelling`);
    assert.equal(count(read(file), UPPER), 0, `${file} must not also use the uppercase spelling`);
  }
});

test('error-codes.js declares no invalid-model key, so every spelling is a literal', () => {
  const codes = read('src/core/error-codes.js');
  assert.equal(count(codes, UPPER), 0, 'error-codes.js must not invent an INVALID_MODEL key');
  assert.equal(count(codes, LOWER), 0, 'error-codes.js must not invent an invalid_model key');
  // The split is documented at the source rather than left to be rediscovered.
  assert.match(codes, /Known spelling split/, 'error-codes.js must record the split it cannot fix');
});

test('impact reports the same condition as unsupported_input, not as a model code', () => {
  const impact = read('src/core/impact.js');
  assert.match(impact, /INVALID_MODEL: CODES\.UNSUPPORTED_INPUT/,
    'impact must keep mapping its invalid-model condition onto unsupported_input');
});
