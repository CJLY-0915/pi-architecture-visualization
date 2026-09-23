'use strict';

const { validateModel } = require('./validation');
const { CODES } = require('./error-codes');

const FORMATS = Object.freeze(['structurizr', 'c4', 'dot', 'mermaid', 'drawio', 'markdown', 'json', 'svg', 'png', 'html']);
const MIME_TYPES = Object.freeze({
  structurizr: 'text/plain', c4: 'text/plain', dot: 'text/vnd.graphviz', mermaid: 'text/plain', drawio: 'application/xml',
  markdown: 'text/markdown', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', html: 'text/html',
});
// Bounded preview budget for the panel bridge. It has to be large enough that a
// realistic model still exports completely, because the caller writes this text
// to disk as the deliverable: a truncated export is a corrupt file, not a
// smaller one. Truncation is still reported, never hidden.
const MAX_PREVIEW_CHARS = 24000;

// A C4 level is a depth filter over the focus node's parentId subtree, never a
// separate model. An empty level is a modelling gap, so it is refused rather
// than rendered as an empty diagram.
const C4_LEVELS = Object.freeze([1, 2, 3]);
const DEFAULT_C4_LEVEL = 1;
const C4_KEYWORDS = Object.freeze({
  actor: 'person', system: 'softwareSystem', container: 'container',
  component: 'component', module: 'component', datastore: 'container', external: 'externalSystem',
});

// An editable file must not imply more certainty than the model claims, so a
// fact that is not confirmed/high is marked three ways: label suffix, fill
// colour and a dashed outline. Confirmed/high facts stay unmarked.
const DRAWIO_NODE_STYLE = Object.freeze({
  confirmed: { fill: '#dae8fc', stroke: '#6c8ebf' },
  inferred: { fill: '#fff2cc', stroke: '#d6b656' },
  assumed: { fill: '#ffe6cc', stroke: '#d79b00' },
  unknown: { fill: '#f5f5f5', stroke: '#808080' },
});

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[char]));
}

function escapeDot(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function escapeDsl(value) { return cleanLine(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function safeToken(value) { return Array.from(String(value)).map((char) => char.codePointAt(0).toString(16)).join('_'); }
function cleanLine(value) { return String(value).replace(/[\r\n]+/g, ' '); }
function markdownCell(value) { return cleanLine(value).replace(/\|/g, '\\|'); }

// A fact is firm only when the model both proves it and trusts it. Everything
// else is marked in every format that can carry a mark.
function isFirmFact(fact) { return fact.status === 'confirmed' && fact.confidence === 'high'; }
function certaintySuffix(fact) { return isFirmFact(fact) ? '' : ` [${fact.status} · ${fact.confidence}]`; }

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
  if (format === 'drawio') items.push('Draw.io XML 用标签后缀、填充色与虚线 outline 表达 status/confidence；证据正文与 id-only 集合（views/findings/decisions/migrationSlices/unknowns）不在文件里，网格布局导入后需人工整理。');
  if (format === 'html') items.push('离线 HTML 不含脚本、远程资源或交互。');
  if (format === 'drawio') items.push('Draw.io XML 用标签后缀、填充色与虚线 outline 表达 status/confidence；证据正文与 id-only 集合（views/findings/decisions/migrationSlices/unknowns）不在文件里，网格布局导入后需人工整理。');
  if (format === 'c4') {
    items.push('C4 层级只由 parentId 链决定：模型若没有该深度的节点，该层以 no_nodes_at_c4_level 拒绝而不是输出空图。');
    items.push('焦点系统在模型中没有直接边时，L1 只剩焦点系统一个框——这是模型欠建模的信号，不是渲染缺陷。');
    items.push('actor 一律映射为 C4 person；模型若用 actor 表示非人类执行者，需在模型里改用 external 类型，渲染器不代判。');
  }
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
  sorted(model.nodes).forEach((node, index) => {
    const style = DRAWIO_NODE_STYLE[node.status] || DRAWIO_NODE_STYLE.unknown;
    const dash = node.status === 'confirmed' ? '' : 'dashed=1;';
    cells.push(`<mxCell id="n:${escapeXml(node.id)}" value="${escapeXml(cleanLine(node.name) + certaintySuffix(node))}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${style.fill};strokeColor=${style.stroke};${dash}" vertex="1" parent="1"><mxGeometry x="${40 + (index % 4) * 190}" y="${40 + Math.floor(index / 4) * 110}" width="150" height="56" as="geometry"/></mxCell>`);
  });
  sorted(model.edges).forEach((edge) => {
    const dash = edge.status === 'confirmed' ? '' : 'dashed=1;';
    cells.push(`<mxCell id="e:${escapeXml(edge.id)}" value="${escapeXml(cleanLine(edge.type) + certaintySuffix(edge))}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;${dash}" edge="1" source="n:${escapeXml(edge.source)}" target="n:${escapeXml(edge.target)}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  });
  const legend = 'Marking rule: a fact that is not confirmed/high carries a label suffix and a dashed outline; fill colour encodes status (confirmed=blue, inferred=amber, assumed=orange, unknown=grey). Evidence bodies and the id-only collections are not in this file.';
  return `<!-- ${escapeXml(header(model, ''))} -->\n<!-- ${escapeXml(legend)} -->\n<mxfile host="app.diagrams.net"><diagram name="Architecture"><mxGraphModel><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

// Depth of a node inside the focus subtree: the focus is 0, its children 1 and
// so on. A node outside the subtree is -1, which is what keeps an external from
// ever being drawn inside the boundary.
function depthInside(node, focusId, byId) {
  if (node.id === focusId) return 0;
  let depth = 0;
  let current = node;
  while (current && current.parentId) {
    if (current.parentId === focusId) return depth + 1;
    current = byId.get(current.parentId);
    depth += 1;
    if (depth > 64) return -1;
  }
  return -1;
}

function c4Selection(model, focusId, level) {
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const depth = new Map(model.nodes.map((node) => [node.id, depthInside(node, focusId, byId)]));
  const levelNodes = model.nodes.filter((node) => depth.get(node.id) === level - 1);
  if (levelNodes.length === 0) return null;
  const drawn = new Set(levelNodes.map((node) => node.id));
  // The focus is the boundary box every level draws, and the ancestors of the
  // level nodes are the boxes between it and them.
  drawn.add(focusId);
  for (const node of levelNodes) {
    let current = node.parentId ? byId.get(node.parentId) : null;
    while (current && current.id !== focusId && !drawn.has(current.id)) {
      drawn.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : null;
    }
  }
  const insideIds = new Set(model.nodes.filter((node) => depth.get(node.id) >= 0).map((node) => node.id));
  const neighbours = new Map(model.nodes.map((node) => [node.id, new Set()]));
  for (const edge of model.edges) {
    if (neighbours.has(edge.source) && neighbours.has(edge.target)) {
      neighbours.get(edge.source).add(edge.target);
      neighbours.get(edge.target).add(edge.source);
    }
  }
  // Outside the boundary but adjacent to anything inside it: the users and
  // dependencies a context or container diagram is expected to name.
  for (const id of insideIds) {
    for (const other of neighbours.get(id)) if (!insideIds.has(other)) drawn.add(other);
  }
  const drawnEdges = model.edges.filter((edge) => drawn.has(edge.source) && drawn.has(edge.target));
  return { focus: byId.get(focusId), depth, drawnNodes: model.nodes.filter((node) => drawn.has(node.id)), drawnEdges, droppedEdges: model.edges.length - drawnEdges.length };
}

// Structurizr identifiers allow [A-Za-z0-9_-] while model ids use ':' and '#',
// so ids are slugged and the original is kept in the element description.
function dslToken(value, used) {
  const base = String(value).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
  if (!used.has(base)) { used.add(base); return base; }
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  const token = `${base}_${suffix}`;
  used.add(token);
  return token;
}

function c4Element(node, token, indent) {
  const keyword = C4_KEYWORDS[node.type] || 'softwareSystem';
  return `${indent}${token} = ${keyword} "${escapeDsl(node.name)}" "${escapeDsl(`${node.type}/${node.status}/${node.confidence} · ${node.id}`)}"`;
}

function c4(model, options = {}) {
  const selection = c4Selection(model, options.focus, options.level);
  if (!selection) {
    return fail(CODES.NO_NODES_AT_C4_LEVEL, `C4 L${options.level} has no node at that depth below ${options.focus}; the model does not describe that level.`);
  }
  const used = new Set();
  const tokens = new Map(selection.drawnNodes.map((node) => [node.id, dslToken(node.id, used)]));
  const drawnIds = new Set(selection.drawnNodes.map((node) => node.id));
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const children = new Map();
  for (const node of selection.drawnNodes) {
    const parent = selection.depth.get(node.id) > 0 && node.parentId && drawnIds.has(node.parentId) ? node.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  const lines = [header(model, '//'), 'workspace {', '  model {'];
  const emit = (parentId, indent) => {
    for (const node of sorted(children.get(parentId) || [])) {
      const hasChildren = (children.get(node.id) || []).length > 0;
      lines.push(`${c4Element(node, tokens.get(node.id), indent)}${hasChildren ? ' {' : ''}`);
      if (hasChildren) {
        emit(node.id, `${indent}  `);
        lines.push(`${indent}}`);
      }
    }
  };
  emit(null, '    ');
  for (const edge of sorted(selection.drawnEdges)) {
    // parentId already expresses containment; a contains edge for the same pair
    // would be a second source of truth for one fact.
    if (edge.type === 'contains' && byId.get(edge.target) && byId.get(edge.target).parentId === edge.source) continue;
    lines.push(`    ${tokens.get(edge.source)} -> ${tokens.get(edge.target)} "${escapeDsl(edge.type)}" "${escapeDsl(`${edge.status}/${edge.confidence} · ${edge.id}`)}"`);
  }
  lines.push('  }', '  views {');
  const focusToken = tokens.get(selection.focus.id);
  if (options.level === 3) {
    const withComponents = selection.drawnNodes.filter((node) => selection.depth.get(node.id) === 1 && (children.get(node.id) || []).length > 0);
    for (const container of sorted(withComponents)) {
      lines.push(`    component ${tokens.get(container.id)} "c4-l3-${tokens.get(container.id)}" "L3 components inside ${escapeDsl(container.name)}" {`, '      include *', '      autolayout lr', '    }');
    }
  } else {
    lines.push(`    ${options.level === 1 ? 'systemContext' : 'container'} ${focusToken} "c4-l${options.level}" "C4 L${options.level} derived from ${escapeDsl(options.focus)}" {`, '      include *', '      autolayout lr', '    }');
  }
  lines.push('  }', '}');
  return lines.join('\n');
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

// `options` only carries C4 selection: a focus node id and a level 1-3. Every
// other format ignores it, so a caller cannot smuggle state into a renderer.
function c4Options(model, options) {
  const level = options.level === undefined ? DEFAULT_C4_LEVEL : options.level;
  if (!C4_LEVELS.includes(level)) {
    return { error: fail(CODES.INVALID_OPTION, `C4 level must be one of ${C4_LEVELS.join(', ')}.`) };
  }
  let focus = options.focus;
  if (focus === undefined) {
    focus = (sorted(model.nodes.filter((node) => node.type === 'system'))[0] || {}).id;
  }
  if (typeof focus !== 'string' || !model.nodes.some((node) => node.id === focus)) {
    return { error: fail(CODES.INVALID_OPTION, 'C4 focus must be the id of a declared node.') };
  }
  return { focus, level };
}

function exportPreview(model, format, options = {}) {
  try {
    if (!FORMATS.includes(format)) return fail('invalid_option', 'Choose a supported in-memory preview format.');
    const validation = validateModel(model);
    if (!validation.valid) return { ...fail('invalid_model', 'Export preview requires a valid v1 architecture model.'), validation };
    const meta = metadata(model);
    if (format === 'png') {
      return { ok: true, format, mimeType: MIME_TYPES[format], supported: false, content: null, metadata: meta, legend: legend(), limitations: [...limitations(model, format), 'PNG 需要图形渲染栈；当前零依赖只读插件不生成或伪造 PNG 二进制。'] };
    }
    let fullContent;
    if (format === 'c4') {
      const selection = c4Options(model, options);
      if (selection.error) return selection.error;
      fullContent = c4(model, { focus: selection.focus, level: selection.level });
      if (typeof fullContent !== 'string') return fullContent;
    } else {
      const renderers = { structurizr, dot, mermaid, drawio, markdown, json: () => `${JSON.stringify(model, null, 2)}\n`, svg, html };
      fullContent = renderers[format](model);
    }
    const contentTruncated = fullContent.length > MAX_PREVIEW_CHARS;
    const notes = limitations(model, format);
    if (contentTruncated) {
      notes.push(`内容预览已限制为前 ${MAX_PREVIEW_CHARS} 个字符；未输出或保存其余内容。`);
      if (format === 'drawio') notes.push('内容被截断，这份 XML 不完整：写盘会得到一个被切断的文件。不要把它当作交付物，改用更小的模型或分层导出。');
    }
    return { ok: true, format, mimeType: MIME_TYPES[format], supported: true, content: fullContent.slice(0, MAX_PREVIEW_CHARS), contentTruncated, metadata: meta, legend: legend(), limitations: notes };
  } catch {
    return fail('internal_error', 'Export preview failed unexpectedly; no complete preview was produced.');
  }
}

module.exports = { exportPreview, FORMATS };
