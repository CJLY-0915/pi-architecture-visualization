'use strict';

const { validateModel } = require('./validation');

const FORMATS = Object.freeze(['structurizr', 'dot', 'mermaid', 'drawio', 'markdown', 'json', 'svg', 'png', 'html']);
const MIME_TYPES = Object.freeze({
  structurizr: 'text/plain', dot: 'text/vnd.graphviz', mermaid: 'text/plain', drawio: 'application/xml',
  markdown: 'text/markdown', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', html: 'text/html',
});
const MAX_PREVIEW_CHARS = 12000;

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[char]));
}

function escapeDot(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeToken(value) { return Array.from(String(value)).map((char) => char.codePointAt(0).toString(16)).join('_'); }
function cleanLine(value) { return String(value).replace(/[\r\n]+/g, ' '); }
function markdownCell(value) { return cleanLine(value).replace(/\|/g, '\\|'); }

function sorted(items) {
  return [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function metadata(model) {
  return {
    schemaVersion: model.schemaVersion,
    projectId: model.project.id,
    projectName: model.project.name || model.project.id,
    scopeRoots: [...model.scope.roots],
    sourceRevision: model.sourceRevision,
    generatedAt: model.generatedAt,
    coverage: { filesScanned: model.coverage.filesScanned, complete: model.coverage.complete },
  };
}

function limitations(model, format) {
  const items = [
    '仅内存预览：本插件不会保存、下载或写入该导出。',
    '证据内容、Git 状态和证据新鲜度未在导出时重新验证。',
    model.coverage.complete ? '模型声明覆盖完整；该声明未由导出器独立验证。' : '模型声明覆盖不完整；导出不代表完整架构。',
    format === 'json' ? 'JSON 保留模型原始集合；预览内容仍可能受字符预算截断。' : '此格式主要渲染 nodes/edges；除 Markdown/HTML 的 unknowns 外，其它已声明集合、节点扩展字段与证据正文未被完整表达。',
  ];
  if (format === 'svg') items.push('SVG 为确定性简图，不执行自动布局或渲染外部资源。');
  if (format === 'drawio') items.push('Draw.io XML 是基础图形预览，导入后可能需要人工布局。');
  if (format === 'html') items.push('离线 HTML 不含脚本、远程资源或交互。');
  return items;
}

function legend() {
  return [
    { mark: 'node', meaning: '模型中的架构节点' },
    { mark: 'edge', meaning: '有向关系，标签为关系类型' },
    { mark: 'evidence', meaning: '模型声明的证据引用，不代表已重新验证源内容' },
  ];
}

function header(model, prefix) {
  const meta = metadata(model);
  return `${prefix} model schemaVersion=${meta.schemaVersion}; project=${meta.projectId}; scope=${meta.scopeRoots.join(',')}; sourceRevision=${meta.sourceRevision ?? 'unknown'}; generatedAt=${meta.generatedAt}; coverage=${meta.coverage.complete ? 'complete' : 'incomplete'}:${meta.coverage.filesScanned}`;
}

function structurizr(model) {
  const lines = [header(model, '//'), 'workspace "Architecture preview" "In-memory, read-only preview" {', '  model {'];
  for (const node of sorted(model.nodes)) lines.push(`    n_${safeToken(node.id)} = softwareSystem "${cleanLine(node.name).replace(/"/g, '\\"')}" "${node.type}/${node.status}/${node.confidence}"`);
  for (const edge of sorted(model.edges)) lines.push(`    n_${safeToken(edge.source)} -> n_${safeToken(edge.target)} "${cleanLine(edge.type).replace(/"/g, '\\"')}"`);
  lines.push('  }', '}');
  return lines.join('\n');
}

function dot(model) {
  const lines = [header(model, '//'), 'digraph architecture {', '  rankdir=LR;', '  node [shape=box];'];
  for (const node of sorted(model.nodes)) lines.push(`  "${escapeDot(node.id)}" [label="${escapeDot(node.name)}\\n${escapeDot(node.type)}/${escapeDot(node.status)}/${escapeDot(node.confidence)}"];`);
  for (const edge of sorted(model.edges)) lines.push(`  "${escapeDot(edge.source)}" -> "${escapeDot(edge.target)}" [label="${escapeDot(edge.type)}"];`);
  lines.push('}');
  return lines.join('\n');
}

function mermaid(model) {
  const lines = [header(model, '%%'), 'flowchart LR'];
  for (const node of sorted(model.nodes)) lines.push(`  n_${safeToken(node.id)}["${cleanLine(node.name).replace(/"/g, '\\"')}"]`);
  for (const edge of sorted(model.edges)) lines.push(`  n_${safeToken(edge.source)} -->|${cleanLine(edge.type).replace(/"/g, '\\"')}| n_${safeToken(edge.target)}`);
  return lines.join('\n');
}

function markdown(model) {
  const lines = [`# ${markdownCell(metadata(model).projectName)}`, '', `> ${header(model, 'Model')}`, '', '## 限制', ...limitations(model, 'markdown').map((item) => `- ${item}`), '', '## 节点', '', '| ID | 名称 | 类型 | 状态 | 置信度 |', '| --- | --- | --- | --- | --- |'];
  for (const node of sorted(model.nodes)) lines.push(`| ${markdownCell(node.id)} | ${markdownCell(node.name)} | ${markdownCell(node.type)} | ${markdownCell(node.status)} | ${markdownCell(node.confidence)} |`);
  lines.push('', '## 关系', '', '| ID | 来源 | 目标 | 类型 | 状态 | 置信度 |', '| --- | --- | --- | --- | --- | --- |');
  for (const edge of sorted(model.edges)) lines.push(`| ${markdownCell(edge.id)} | ${markdownCell(edge.source)} | ${markdownCell(edge.target)} | ${markdownCell(edge.type)} | ${markdownCell(edge.status)} | ${markdownCell(edge.confidence)} |`);
  lines.push('', '## 已声明未知项', ...sorted(model.unknowns).map((item) => `- ${markdownCell(item.id)}: ${markdownCell(item.question || '未提供问题')}`));
  return lines.join('\n');
}

function drawio(model) {
  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  sorted(model.nodes).forEach((node, index) => cells.push(`<mxCell id="n:${escapeXml(node.id)}" value="${escapeXml(cleanLine(node.name))}" vertex="1" parent="1"><mxGeometry x="${40 + (index % 4) * 190}" y="${40 + Math.floor(index / 4) * 110}" width="150" height="56" as="geometry"/></mxCell>`));
  sorted(model.edges).forEach((edge) => cells.push(`<mxCell id="e:${escapeXml(edge.id)}" value="${escapeXml(cleanLine(edge.type))}" edge="1" source="n:${escapeXml(edge.source)}" target="n:${escapeXml(edge.target)}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`));
  return `<!-- ${escapeXml(header(model, ''))} -->\n<mxfile host="app.diagrams.net"><diagram name="Architecture"><mxGraphModel><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

function svg(model) {
  const width = 920; const rowHeight = 88; const height = Math.max(180, 80 + model.nodes.length * rowHeight, 100 + model.edges.length * 22);
  const nodes = sorted(model.nodes).map((node, index) => `<g><rect x="55" y="${50 + index * rowHeight}" width="330" height="52" rx="8" fill="#102938" stroke="#55c8e8"/><text x="70" y="${72 + index * rowHeight}" fill="#e6edf5" font-family="sans-serif" font-size="14">${escapeXml(cleanLine(node.name))}</text><text x="70" y="${91 + index * rowHeight}" fill="#91a0b3" font-family="monospace" font-size="10">${escapeXml(node.id)} · ${escapeXml(node.type)} · ${escapeXml(node.status)}</text></g>`).join('');
  const edges = sorted(model.edges).map((edge, index) => `<text x="430" y="${76 + index * 22}" fill="#91a0b3" font-family="monospace" font-size="11">${escapeXml(`${edge.source} → ${edge.target} · ${edge.type}`)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Architecture preview"><rect width="100%" height="100%" fill="#0b111b"/><text x="32" y="28" fill="#55c8e8" font-family="monospace" font-size="12">${escapeXml(header(model, ''))}</text>${nodes}${edges}</svg>`;
}

function html(model) {
  const body = markdown(model).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeXml(metadata(model).projectName)} — 架构预览</title><style>body{margin:32px;max-width:960px;background:#0b111b;color:#e6edf5;font:14px/1.5 system-ui}pre{white-space:pre-wrap;background:#101925;padding:20px;border:1px solid #283749} </style><body><pre>${body}</pre></body></html>`;
}

function exportPreview(model, format) {
  try {
    if (!FORMATS.includes(format)) return fail('invalid_option', 'Choose a supported in-memory preview format.');
    const validation = validateModel(model);
    if (!validation.valid) return { ...fail('invalid_model', 'Export preview requires a valid v1 architecture model.'), validation };
    const meta = metadata(model);
    if (format === 'png') {
      return { ok: true, format, mimeType: MIME_TYPES[format], supported: false, content: null, metadata: meta, legend: legend(), limitations: [...limitations(model, format), 'PNG 需要图形渲染栈；当前零依赖只读插件不生成或伪造 PNG 二进制。'] };
    }
    const renderers = { structurizr, dot, mermaid, drawio, markdown, json: () => `${JSON.stringify(model, null, 2)}\n`, svg, html };
    const fullContent = renderers[format](model); const contentTruncated = fullContent.length > MAX_PREVIEW_CHARS;
    return { ok: true, format, mimeType: MIME_TYPES[format], supported: true, content: fullContent.slice(0, MAX_PREVIEW_CHARS), contentTruncated, metadata: meta, legend: legend(), limitations: contentTruncated ? [...limitations(model, format), `内容预览已限制为前 ${MAX_PREVIEW_CHARS} 个字符；未输出或保存其余内容。`] : limitations(model, format) };
  } catch {
    return fail('internal_error', 'Export preview failed unexpectedly; no complete preview was produced.');
  }
}

module.exports = { exportPreview, FORMATS, MIME_TYPES };
