'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('drawio marks every fact the model does not hold firmly', () => {
  const result = exportPreview(clone(fixture), 'drawio');
  assert.equal(result.ok, true);
  const content = result.content;

  // A fact that is neither proven nor trusted carries all three marks: a label
  // suffix, a fill colour and a dashed outline.
  const unknownNode = content.match(/<mxCell id="n:actor\.operator"[^>]*>/)[0];
  assert.match(unknownNode, /value="Billing Operator \[unknown · unknown\]"/);
  assert.match(unknownNode, /fillColor=#f5f5f5/);
  assert.match(unknownNode, /dashed=1/);

  const lowNode = content.match(/<mxCell id="n:datastore\.billingdb"[^>]*>/)[0];
  assert.match(lowNode, /value="Billing Database \[inferred · low\]"/);
  assert.match(lowNode, /fillColor=#fff2cc/);
  assert.match(lowNode, /dashed=1/);

  // A confirmed/high fact stays unmarked, so the marks mean something.
  const firmNode = content.match(/<mxCell id="n:container\.api"[^>]*>/)[0];
  assert.match(firmNode, /value="Billing API"/);
  assert.doesNotMatch(firmNode, /\[/);
  assert.doesNotMatch(firmNode, /dashed=1/);
  assert.match(firmNode, /fillColor=#dae8fc/);

  const softEdge = content.match(/<mxCell id="e:edge\.operator\.api"[^>]*>/)[0];
  assert.match(softEdge, /value="calls \[unknown · unknown\]"/);
  assert.match(softEdge, /dashed=1/);
  const firmEdge = content.match(/<mxCell id="e:edge\.api\.invoice"[^>]*>/)[0];
  assert.match(firmEdge, /value="contains"/);
  assert.doesNotMatch(firmEdge, /dashed=1/);
});

test('drawio keeps the node and edge id sets exactly and states the marking rule', () => {
  const result = exportPreview(clone(fixture), 'drawio');
  const nodeCells = [...result.content.matchAll(/<mxCell id="n:([^"]+)"/g)].map((match) => match[1]);
  const edgeCells = [...result.content.matchAll(/<mxCell id="e:([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(nodeCells.sort(), fixture.nodes.map((node) => node.id).sort());
  assert.deepEqual(edgeCells.sort(), fixture.edges.map((edge) => edge.id).sort());
  for (const edge of fixture.edges) {
    assert.ok(nodeCells.includes(edge.source), `${edge.id} source must resolve to a drawn node`);
    assert.ok(nodeCells.includes(edge.target), `${edge.id} target must resolve to a drawn node`);
  }
  // The rule that makes the colours readable is stated in the file itself.
  assert.match(result.content, /Marking rule: a fact that is not confirmed\/high/);
  assert.ok(result.limitations.some((entry) => entry.includes('标签后缀') && entry.includes('status/confidence')));
});

test('c4 cuts the parentId chain into L1, L2 and L3 without flattening it', () => {
  const l1 = exportPreview(clone(fixture), 'c4', { level: 1 });
  assert.equal(l1.ok, true);
  assert.match(l1.content, /sys_billing = softwareSystem "Billing System"/);
  // The container and the module are inside the system, so L1 must not draw them.
  assert.doesNotMatch(l1.content, /container_api/);
  assert.doesNotMatch(l1.content, /module_invoice/);
  assert.match(l1.content, /systemContext sys_billing/);

  const l2 = exportPreview(clone(fixture), 'c4', { level: 2 });
  assert.equal(l2.ok, true);
  // The system is the boundary box and the container nests inside it.
  assert.match(l2.content, /sys_billing = softwareSystem "Billing System"[^\n]*\{/);
  assert.match(l2.content, /\n\s+container_api = container "Billing API"/);
  assert.doesNotMatch(l2.content, /module_invoice/);
  assert.match(l2.content, /container sys_billing/);

  const l3 = exportPreview(clone(fixture), 'c4', { level: 3 });
  assert.equal(l3.ok, true);
  assert.match(l3.content, /sys_billing = softwareSystem "Billing System"[^\n]*\{/);
  assert.match(l3.content, /\n\s+container_api = container "Billing API"[^\n]*\{/);
  assert.match(l3.content, /\n\s+module_invoice = component "Invoice Module"/);
  assert.match(l3.content, /component container_api/);
});

test('c4 keeps status and confidence on every element and traces ids', () => {
  const result = exportPreview(clone(fixture), 'c4', { level: 3 });
  for (const node of fixture.nodes) {
    assert.match(result.content, new RegExp(`"${node.type}/${node.status}/${node.confidence} · ${node.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), `${node.id} must carry its type/status/confidence and id`);
  }
  // parentId already expresses containment, so a contains edge for the same pair
  // is never drawn as a second source of truth.
  assert.doesNotMatch(result.content, /->[^\n]*"contains"/);
});

test('c4 refuses a level the model does not describe instead of drawing an empty diagram', () => {
  const result = exportPreview(clone(fixture), 'c4', { level: 3, focus: 'sys.billing' });
  assert.equal(result.ok, true, 'the fixture has a module under a container, so L3 exists');

  const shallow = clone(fixture);
  shallow.nodes = shallow.nodes.filter((node) => node.type !== 'module');
  shallow.edges = shallow.edges.filter((edge) => edge.target !== 'module.invoice' && edge.source !== 'module.invoice');
  const empty = exportPreview(shallow, 'c4', { level: 3 });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'no_nodes_at_c4_level');
  assert.match(empty.error.message, /sys\.billing/);
});

test('c4 rejects an unknown level or focus and defaults to the first system', () => {
  assert.equal(exportPreview(clone(fixture), 'c4', { level: 4 }).error.code, 'invalid_option');
  assert.equal(exportPreview(clone(fixture), 'c4', { focus: 'nope' }).error.code, 'invalid_option');
  const defaulted = exportPreview(clone(fixture), 'c4');
  assert.equal(defaulted.ok, true);
  assert.match(defaulted.content, /systemContext sys_billing/);
  assert.ok(defaulted.limitations.some((entry) => entry.includes('parentId')));
});

test('a truncated drawio export is reported as unusable rather than as a smaller file', () => {
  // The caller writes this text to disk as the deliverable, so truncation is a
  // corrupt file, not a partial one. Build a model large enough to cross the
  // budget and assert the export says so.
  const big = clone(fixture);
  for (let index = 0; index < 200; index += 1) {
    big.nodes.push({ id: `module.pad${index}`, name: `Padding module ${index}`, type: 'module', state: 'current', status: 'confirmed', confidence: 'high', evidenceIds: ['ev.invoice'], parentId: 'container.api' });
  }
  const result = exportPreview(big, 'drawio');
  assert.equal(result.ok, true);
  assert.equal(result.contentTruncated, true);
  assert.equal(result.content.length, 24000);
  assert.ok(result.limitations.some((entry) => entry.includes('内容预览已限制为前 24000 个字符')));
  assert.ok(result.limitations.some((entry) => entry.includes('不要把它当作交付物')), 'a truncated drawio export must be refused as a deliverable');
});

test('the preview budget is large enough for a complete export of a realistic model', () => {
  // fixtures/realistic-model.json is a snapshot of this repository's own
  // architecture/model.json at 1.4.0 (20 nodes, 27 edges, 30 evidence, 8 views).
  // architecture/ is gitignored, so no test may read it directly: CI has no
  // such file, and a budget guard that cannot run is worse than no guard at
  // all. Refresh the snapshot by copying architecture/model.json over this
  // fixture and updating the pinned counts below.
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'realistic-model.json'), 'utf8'));
  assert.equal(model.nodes.length, 20, 'the snapshot must stay the realistic 20-node case');
  assert.equal(model.edges.length, 27);
  assert.equal(model.evidence.length, 30);
  for (const format of FORMATS) {
    if (format === 'png') continue;
    const result = exportPreview(clone(model), format, format === 'c4' ? { level: 3 } : undefined);
    assert.equal(result.ok, true, format);
    assert.equal(result.contentTruncated, false, `${format} must export this repository model completely`);
  }
});
