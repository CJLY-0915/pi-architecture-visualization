'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { exportPreview, FORMATS } = require('../src/core/export-preview');
const fixture = require('../fixtures/valid-minimal-model.json');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('every planned format has a bounded in-memory export preview contract', () => {
  for (const format of FORMATS) {
    const result = exportPreview(clone(fixture), format);
    assert.equal(result.ok, true, format);
    assert.equal(result.format, format);
    assert.equal(result.metadata.schemaVersion, 1);
    assert.deepEqual(result.metadata.scopeRoots, ['.', 'src']);
    assert.equal(result.metadata.sourceRevision, fixture.sourceRevision);
    assert.equal(result.metadata.generatedAt, fixture.generatedAt);
    assert.equal(result.legend.length, 3);
    assert.ok(result.limitations.some((entry) => entry.includes('仅内存预览')));
    assert.ok(result.limitations.some((entry) => entry.includes('新鲜度未在导出时重新验证')));
  }
});

test('textual previews are deterministic and retain declared model metadata', () => {
  for (const format of FORMATS.filter((value) => value !== 'png')) {
    const before = clone(fixture);
    const first = exportPreview(before, format);
    const second = exportPreview(clone(fixture), format);
    assert.equal(first.supported, true, format);
    assert.equal(first.content, second.content, format);
    assert.match(first.content, /b7c1f2a9d4e5f60718293a4b5c6d7e8f90123456/);
    assert.deepEqual(before, fixture);
  }
});

test('PNG is explicit unsupported output rather than fabricated binary data', () => {
  const result = exportPreview(clone(fixture), 'png');
  assert.equal(result.ok, true);
  assert.equal(result.supported, false);
  assert.equal(result.content, null);
  assert.ok(result.limitations.some((entry) => entry.includes('不生成或伪造 PNG')));
});

test('invalid format and invalid model fail without throwing', () => {
  assert.deepEqual(exportPreview(clone(fixture), 'pdf'), {
    ok: false,
    error: { code: 'invalid_option', message: 'Choose a supported in-memory preview format.' },
  });
  const invalid = clone(fixture);
  invalid.nodes[0].id = '';
  const result = exportPreview(invalid, 'json');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_model');
  assert.equal(result.validation.valid, false);
  assert.doesNotThrow(() => exportPreview(null, 'markdown'));
});
