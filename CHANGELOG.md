# 变更记录

格式遵循 Keep a Changelog；版本号遵循语义化版本。本仓库在 1.0.0 之前没有变更记录，
因此 1.0.0 条目覆盖的是整个开发周期的净结果，而不是相对某个已发布版本的增量。

## [1.5.1] - 2026-09-24

把 1.5.0 新加的关系图改成能用的视图，并修掉一个自己造出来的排版缺陷。

### 新增

- **关系图可平移缩放**。视图状态 `{scale, x, y}` 与模型状态完全分开：每次重绘都重置，一个为某张图调好的偏移不会留在下一张图上。缩放范围 0.25–4，步进 1.25，滚轮以指针为锚点（指针下的点在缩放前后停在原地），按钮则以画布中心为锚点。平移用指针拖拽，位移按增量累加——指针移出舞台再移回来不会把画布甩出去；松手发生在舞台外时没有 `pointerup` 到达，因此 `buttons` 归零就是拖拽结束的唯一诚实信号。拖拽超过 3px 才记为平移，所以落在节点上的点击仍然是点击。三个按钮（放大/缩小/重置视图）在还没有图时隐藏，`#diagram-stage` 上回写 `data-diagram-scale`/`-x`/`-y`/`-panning`，视图状态因此可被观测，不必去解析 transform 字符串。

### 修复

- **"另存为快照"按钮把保存行撑出面板**。按钮标签里塞进了 88 字符的 `architecture/snapshots/<64hex>.json`，三个按钮同一行放不下。现在三个写入按钮一律只用动词（`创建`/`另存为快照`/`覆盖写入`），完整路径本来就在上方的目标状态行和结果卡里；快照路径另加到该按钮的 `title` 供悬停查看。`.save-actions .button` 同时加上省略号约束，避免以后再有长标签把同行按钮挤出可见区域。
- **同一条快照路径在目标状态行里仍然撑出横向滚动条**。按钮改短之后，那 88 字符无空格的 token 又原样出现在 `#save-state` 的说明文字里，而 `.save-state` 是面板里唯一漏了断词规则的文本容器——其余 8 个能承载路径的容器（`.metadata dd`、`.detail-id`、`.result-card li` 等）都已有 `overflow-wrap: anywhere`。补上之后状态行与文档都不再产生横向溢出；`.analysis-status` 同样补上，因为分析失败信息里也会带模型路径。实测：加规则前 `#save-state` 的 `scrollWidth` 619 > `clientWidth` 453、文档 653 > 518；加规则后两者各自相等。

### 变更

- `manifest.json` 与 `package.json` 版本号 1.5.0 → 1.5.1。

### 工程细节

- `node --test tests/*.test.js` 350 → **352**：`tests/panel-interactions.test.js` 新增两条——"关系图平移缩放是视图状态、不碰模型"（控件显隐、缩放上下限、指针拖拽与 slop、`buttons` 归零结束拖拽、滚轮无 `deltaY` 时不动视图、重绘不继承旧偏移）与"每条能承载路径的状态行都允许断词"（从渲染器 `<style>` 里读 `.save-state`/`.analysis-status` 的规则体，断言含 `overflow-wrap: anywhere`；harness 看不到布局，所以断在规则被写下的地方）。harness 的 `dispatch` 支持传入事件对象，原有调用不受影响。前一条测试做过变异检查：删掉 `.save-state` 的 `overflow-wrap` 后它立刻失败。
- 缩放锚点以 `#diagram-surface` 自身的布局盒为基准，不是 `#diagram-stage` 的 border box：两者相差舞台的边框与内边距，直接用舞台 rect 计算会让指针下的点在每档缩放时漂移几像素。`getBoundingClientRect()` 返回的是已变换的盒，而 `transform-origin: 0 0` 时平移量正好等于它移动的距离，减掉当前偏移就得到布局位置——不需要读任何布局常量。
- 关系图默认视图不变：`max-width: 100%` 保留，因此 1504px 宽的画布在 458px 舞台里仍然整体可见，缩放与平移是在这个适配视图之上叠加，而不是先把它裁掉。

## [1.5.0] - 2026-09-24

把"采集即得模型"补成一条完整的使用路径：关系图看得见、变更集说得清、漂移查得出。**没有新增任何 agent 工具**——三个新能力全部只从面板进入，因为它们要么需要整个模型（图），要么是一次刻意的全工作区扫描（漂移）。

### 新增

- **面板内 SVG 交互关系图**（`architecture.diagram` 通道 + `src/core/diagram.js`）。按 `parentId` 链分层的确定性布局，层内先按 id 排序再做一次重心 refinement，因此同一模型两次渲染字节相同。点图中节点或右侧节点索引都会把该节点设为焦点：焦点、它的直接邻居与相连边保持不透明，其余降到 0.22 透明度（SVG 内联 `<style>`，零 JS）。节点/边各有预算（默认 120/240），超了会明确说省略了多少——一张被裁掉的图不是一张小图。导出预览里的 `svg` 格式是另一回事：那是给交付物的扁平简图，不执行布局，两者互不替代。
- **变更集影响**（`architecture.impact` 的 `targets` 现在可以是一批文件路径，并返回 `changeSet` 汇总）。`requested`/`resolved`/`unresolved`/`complete` 四个字段回答一个问题：你给的这些路径里有没有哪个根本没被建模。没有它，"受影响节点为空"会被读成"没有影响"，而真相是"这些文件不在模型里"。面板新增"变更集影响"表单，接受逗号或空格分隔的路径列表。
- **架构漂移检查**（`architecture.drift` 通道 + `src/core/drift.js` + `src/host/drift-check.js`）。把已声明的模型和一次全新的只读工作区扫描对比，只看文件路径，分四类报告：模型引用但扫描没找到、文件仍在但采集器已不建模、存在却未被模型引用、以及因扫描不完整而无法判定的。 verdict 只有三种：`aligned`/`drifted`/`incomplete`——空枚举或模型没引用任何路径都判 `incomplete`，绝不会因为没东西可查就报"一致"。

### 变更

- **首页主操作改为"采集并生成模型"**（`.button primary`），"读取模型"降为后面的高级入口（`.button secondary`）。原来顺序相反，于是一打开面板最显眼的是"先有一个模型文件"，而插件真正的价值在于不需要事先有文件。
- `architecture_impact` 的工具描述改为明确说明一批路径就是变更集、以及结果会报告未解析目标的数量。
- `manifest.json` 与 `package.json` 版本号 1.4.1 → 1.5.0；`i18n.safetyNotes` 补上"绘图与漂移检查均为只读"。
- 运行时集合 41 → **44 文件**（新增 `src/core/diagram.js`、`src/core/drift.js`、`src/host/drift-check.js`）。

### 工程细节

- `computeImpact` 新增 `changeSet` 字段，成功与失败路径都会返回，失败时用原始 `targets` 的长度填 `requested`，不谎报 0。
- `main.js` 的"解析当前模型"逻辑原先在导出预览分支里各写一遍，现收敛为 `resolvePanelModel()`，绘图通道复用同一规则，避免两条通道对"当前模型"产生不同理解。
- `src/host/drift-check.js` 只做一次遍历：先取文件列表，再把同一份列表喂给采集器，比较的两边因此永远落在同一个文件集合上。
- 漂移不读 Git、不读文件内容，因此"文件还在且仍被引用"不等于"内容没变"——这条限制写进结果的 `limits`，面板在每条结论旁重复它。
- 面板 SVG 注入后用能力判断挂点击：浏览器有 `querySelectorAll`，测试替身没有，猜任何一边都是对用户能点什么说谎。

### 测试

- `node --test tests/*.test.js` 304 → **350**：新增 `tests/diagram.test.js`（18）、`tests/drift.test.js`（19）、`tests/error-code-spelling.test.js`（4）、面板交互 +3、宿主适配器 +2。
- 变更集测试钉住"粘贴的路径列表不得悄悄丢条目"与"未解析 1 个、结论完整：否"。
- 漂移测试覆盖四类发现、三种 verdict、空枚举判 `incomplete`、`maxFindings` 截断与畸形 `observed`。
- 绘图测试覆盖确定性（两次渲染字节相同）、敌意节点名无法逃逸 XML、未知焦点返回 `invalid_option`、垃圾输入不抛异常。

## [1.4.1] - 2026-09-24

修复一个只影响 CI 的测试缺陷。**运行时与打包集合均无变化**（仍是 41 文件、同样的字节），因此这一版不带来任何行为差异。

### 修复

- `tests/export-preview.test.js` 的"预览预算足够完整导出真实规模模型"直接读
  `architecture/model.json`，而 `architecture/` 在 `.gitignore` 里。于是这条守卫在作者机器上
  一直绿，在三个平台的 CI 上一直 `ENOENT`——**从它写下起就没在 CI 跑过一次**。本地能过纯属
  巧合：目录恰好存在。
- 改为读 `fixtures/realistic-model.json`——`architecture/model.json` 在 1.4.0 时的快照
  （20 节点 / 27 边 / 30 证据 / 8 视图），并把这三个计数钉在测试里，快照被悄悄换掉会立刻红。
- 新增守卫 `tests/package-scope.test.js` 的"no test reads a local-only directory"：任何测试文件
  用 `path.join` 或 `require` 触及 `architecture`/`dist`/`Temp`/`.pi`/`node_modules`/`coverage`/
  `.cache` 即失败。用带病灶的探针文件双向验证过：`path.join` 与 `require` 两种形状都能抓住。
  测试里出现的裸 `'architecture/model.json'` 字符串是喂给桩宿主的内存路径，不算违规。
- 验收方式：把 `architecture/` 临时改名后跑全量，304/304 通过——即 CI 上的真实状态。

### 测试

- `node --test tests/*.test.js` 303 → 304。

## [1.4.0] - 2026-09-24

面板可以把一次采集结果写进工作区了。写入前先展示目标状态，默认不覆盖已有文件。

### 新增

- **面板保存采集模型**（`architecture.save` 通道）：不带 `decision` 时只做规划，返回目标路径、
  `targetState`（`missing`/`present`/`unknown`）、目标字节数、内容寻址快照路径，以及新旧两边的
  节点/关系/证据数与 `sourceRevision`。三种决策：`create`（目标不存在才写，否则 `TARGET_EXISTS`）、
  `snapshot`（写 `architecture/snapshots/<sha256>.json`，内容寻址、幂等，同样内容已在盘上则报告
  `alreadyPresent` 且不重复写）、`overwrite`（唯一允许替换已有文件的动作；目标无法 inspect 时以
  `TARGET_STATE_UNKNOWN` 拒绝）。每个决策在写入时都重新 `stat`，面板展示的计划不背着过期结论。
- **闭环**：写入标准路径成功后，面板立即用同一路径重新读取，来源标记从"来自本次采集（未落盘）"
  变为"来自文件 …"，保存区块随之隐藏。

### 权限

- 申请 `fs.write`，并首次声明 `manifest.fs.write = {root:"workspace", scope:["architecture/**"]}`。
  `fs.write` 属宿主 `HIGH_RISK_PERMISSIONS`，与 `net.fetch`/`agent.prompt.inject` 同级，因此由用户
  在插件页显式授予；`architecture/**` 之外的路径一个字节都写不到。
- 补上 1.3.0 遗漏的 `clipboard.write`：宿主 `clipboard.writeText` 会
  `assertPermission(loaded,"clipboard.write")`（`app.asar` `out/main/index.js:101097-101098`），
  未声明时"复制到剪贴板"在真实宿主必然被拒。`tests/registration-contract.test.js` 新增"面板宿主桥
  通道→权限映射"守卫，新通道不在映射表或权限没声明即测试失败。

### 修复

- 采集区块的 HTML 有一个多余的 `</form>`；顺带清掉。
- `renderCollect` 的"边界"卡片仍写着"模型只在内存：没有写入磁盘。要长期保留，请把导出预览的 JSON
  存成 architecture/model.json 后重新读取"——保存通道已存在，该指引过期。
- 采集结果卡片里的 `previewCard` 文案在 1.2.0 已修，但采集区块自己的三处"不写入/不保存"措辞与新
  的保存入口矛盾，一并改为准确表述。

### 安全

- 主进程重新校验模型（`validateModel` + `planSnapshotSave`），结构性不合格返回 `INVALID_MODEL`，
  一个字节都不写；沿用文件模型的 2 Mi 字符预算。
- 宿主 `pi.fs.writeText` 是 `mkdirSync` + `writeFileSync` 直接覆盖，没有原子 rename、没有 CAS。
  因此写入后再 `stat` 一次，字节数不符返回 `WRITE_UNVERIFIED`，不把结果谎报成已保存。
- `stat` 失败一律记为 `unknown` 而不是 `missing`：把看不见的目标说成不存在，正是一次静默覆盖的开始。
- `pi.fs.writeText` 在 `main.js` 中只出现一次（`writeHost()`）；没有任何 Agent 工具的 schema 带得了
  整个模型，因此保存没有 agent 入口。

### 测试

- `node --test tests/*.test.js` 277 → 303。新增 `tests/save-model.test.js`（16 条），`host-adapter`
  +5、`panel-interactions` +3、`registration-contract` +1、`analysis-tools` 的写权限 scope 守卫各若干。
- **未在真实宿主确认**：`fs.write` 授权生效后的实际写入（记为 A15）。

## [1.0.0] - 2026-09-23

首个标记为稳定的版本。插件能力：从一个仓库采集证据充分的当前状态模型，并在模型之上
做校验、图查询、影响分析、快照比较、健康检查与内存预览。全程只读，不申请 `fs.write`。

### 新增

- **右侧工作面板视图**：`contributes.views` + `ui.view` 权限，同一个只读工作台同时存在于
  右侧工作面板与浮动面板窗口，共用同一份 `renderer/index.html` 与同一套 preload bridge。
- **13 个架构技能**（1 个路由 + 12 个场景/格式）与 `extensions/workflow-rule.mjs` 常驻路由
  规则；每条技能在 manifest 里带显式 `id`。
- **7 个 Agent 工具**：`architecture_validate`、`architecture_collect`、`architecture_query`、
  `architecture_impact`、`architecture_compare`、`architecture_snapshot_plan`、`architecture_health`。
- **内存导出预览**：Structurizr DSL、DOT、Mermaid、Draw.io XML、Markdown、JSON、SVG 与离线
  HTML；PNG 明确报告为受限，不生成也不伪造二进制。
- CI：三平台 `node --test tests/*.test.js`。

### 修复

- **13 个技能只注册了 1 个**：所有技能文件都叫 `SKILL.md`，宿主按基名派生 id，导致同 id
  撞车只有首个注册。改为 manifest 显式 `id` 后宿主日志确认 `plugin.skills.register count=13`。
- **coverage 账本落盘后消失**：`filesListed` / `filesSkipped` 原先只存在于返回值，写进模型
  就丢了，只读模型文件的消费者看不出有文件被扣留。现已持久化，schema 将三个计数列为可选
  属性，README 修正了"`filesListed = filesScanned + filesSkipped`"这一在文件被策略忽略时
  不成立的恒等式。
- **整个范围都被忽略时误报 complete**：新增 `no_files_in_scope`，`listed > 0` 但
  `candidates === 0` 时判为不完整并给出诊断。
- **`pom.xml` / `build.gradle` 被静默忽略**：文档此前声称这两个适配器"已实现"，实际上
  `src/collectors/infra.js` 的 `match()` 从不匹配它们，既不产出节点也不产生任何诊断——
  Maven/Gradle 项目会看起来像"没有基础设施"。现改为匹配并明确报 `unsupported_input`，
  把静默缺口变成可见缺口；错误陈述已更正，并有回归测试固定真实行为。
- **`renderer/index.html` 的 `.masthead` 无条件声明 `-webkit-app-region: drag`**：停靠视图
  里没有窗口可拖，这个 drag 区只会吞点击与文本选择。现按宿主设置的
  `data-pi-plugin-panel-shape` 限定为仅浮动面板生效。
- `package.json` 的 `repository` 对象里有一个重复的 `"type"` 键。

### 内部整理

- `compareStrings` 原有 4 份相同实现，收敛为 `src/core/compare-strings.js` 一处。
- 三个同名不同实现的 `normalizeOptions` 分别改名为 `normalizeCollectOptions`、
  `normalizeQueryOptions`、`normalizeImpactOptions`。
- 三处同名不同值的 `DEFAULT_MAX_DEPTH`（3 / 5 / 32）分别改名为 `DEFAULT_QUERY_DEPTH`、
  `DEFAULT_IMPACT_DEPTH`、`DEFAULT_MAX_DIRECTORY_DEPTH`。
- 删除 21 个没有任何模块或测试引用的导出名。

### 已知限制（记录在案，未修复）

- **右侧停靠视图只验证了一半**：`ui.view` 授权与插件重载已确认生效，但视图标签页尚未在
  真实宿主中被打开过一次。宿主没有供插件自行打开视图的 API（`pi.ui` 只有
  `openPanel`/`closePanel`/`showToast`），因此命令保留为浮动面板入口。
- **Java/Maven/Gradle 依赖采集未实现**：只保证不静默忽略，不产出节点或边。
- **模型不是 C4 形状**：7 个 `module` 节点直接挂 `system`，跳过 container/component，
  因此 L3/L4 不可切、L2 只剩 3 个 container。
- **Draw.io 导出器丢弃 `status` / `confidence`**，不满足 drawio 技能"visibly 标记低置信度"
  的规则；当前给人工标记指南，不改插件产出的 XML。
- **legacy-system-visualizer 是场景错配下的验收**：本仓库文档密度高于典型遗留系统。
- **实际保存/发布未实现**：宿主 `pi.fs.writeText` 是直接覆盖，没有原子替换、排他创建或
  条件写入，因此不把先读后写宣传为安全发布。
- **命令注销（A4）只有单测覆盖**，未在真实宿主确认卸载后命令从命令面板消失。
- 三个采集适配器均为面向行的启发式，不是完整解析器；各自已知限制写在文件头注释中。

## [1.1.0] - 2026-09-23

功能性加固版：闭合 C4 层级、Draw.io 确定性标记、遗留场景错配三项记录在案的缺口。不宣称完整——第五节列出的未闭合项原样保留。

### 新增

- **C4 层级导出格式 `c4`**：按 `parentId` 链切 L1/L2/L3，元素类型按节点类型映射，
  `status`/`confidence` 与模型 id 保留在每个元素上；模型没有该深度节点时以
  `no_nodes_at_c4_level` 拒绝，不输出空图。`structurizr` 保持拍平变体不变。
- `docs/positioning-and-value.md`：核心作用与定位、六个具体使用场景（每个都写清
  "得到什么/得不到什么"）、对工程实践的可观察提升、以及三项缺口的改进方案与验证标准。
- `fixtures/legacy-sparse-project/` + `fixtures/legacy-sparse-model.json`：真正证据稀疏的
  遗留系统夹具（无文档、无测试、无 owner、动态 require、硬编码主机、无 owner 的调度表）。
- `architecture/views/c4-l3-component.structurizr.dsl`。
- `tests/legacy-sparse-evidence.test.js`：5 条用例固定稀疏证据路径。

### 修复

- **Draw.io 导出丢弃 `status`/`confidence`**：非 `confirmed`/`high` 的事实现在带三重标记
  （标签后缀、状态填充色、虚线轮廓），规则写在 XML 注释里。`skills/drawio/SKILL.md` 的
  规则从"你要标记"改为"验证标记存活，不要手工加第二套"——实现与规则不再互相矛盾。
- **预览预算会截断 Draw.io 导出**：12000 字符对 20 节点/27 边的模型就会截断，而截断后的
  XML 是被切断的文件，不是"小一点的文件"。预算提高到 24000，且截断时对 drawio 追加
  "不要把它当作交付物"的限制。
- **本仓库模型不是 C4 形状**：7 个 `module`（实为源码目录，C4 语义上就是组件）改为
  `component` 并挂到正确容器；新增 `container:skills-catalog`/`container:verification`/
  `container:documentation`；补 8 条容器级聚合边；`actor:agent` 是 LLM 不是人，改为
  `external:agent`。L1/L2/L3 现在全部可切。
- **`legacy-system-visualizer` 是场景错配下验收的**：该技能此前只在本插件仓库（文档密集）
  上跑过。现已在 `fixtures/legacy-sparse-project/` 上补验，产出
  `architecture/legacy-inventory-sparse.md`，行为由回归测试固定。
- 新增稳定诊断码 `no_nodes_at_c4_level`。

### 已知限制（记录在案，未修复）

- **右侧停靠视图的生命周期细节未逐项演练**：`ui.view` 授权、插件重载、标签页打开与读取/查询/影响均已由用户确认（2026-09-23）；重复打开/关闭后的残留注册与重复面板未单独检查。宿主没有供插件自行打开视图的 API，因此只能由用户在工作面板点开。
- **采集器读取但不建模的文件类型静默无诊断**：`fixtures/legacy-sparse-project/` 实测
  `config/app.properties` 与三个 ops 脚本被读取，却不产生节点也不产生诊断。已记录在
  `legacy-inventory-sparse.md`，没有伪装成覆盖；不凭空实现解析器。
- **Java/Maven/Gradle 依赖采集未实现**：只保证不静默忽略。
- **模型不是完整 C4 形状**：L4（Code）刻意不切，模块密度图归 `graphviz`；`datastore` 映射为
  C4 `container`，因为 Structurizr DSL 没有独立的数据库元素。
- **Draw.io 导出器仍不表达证据正文与 id-only 集合**（`views`/`findings`/`decisions`/
  `migrationSlices`/`unknowns`）。
- **`actor` 一律映射为 C4 `person`**：模型若用 `actor` 表示非人类执行者，需改用 `external`
  类型，渲染器不代判（本仓库的 `actor:agent` 已因此改为 `external:agent`）。
- **实际保存/发布未实现**：宿主 `pi.fs.writeText` 是直接覆盖，没有原子替换、排他创建或
  条件写入，因此不把先读后写宣传为安全发布。
- **命令注销（A4）只有单测覆盖**，未在真实宿主确认卸载后命令从命令面板消失。
- 三个采集适配器均为面向行的启发式，不是完整解析器；各自已知限制写在文件头注释中。
## [1.2.0] - 2026-09-23

采集探测进面板：没有模型时也能先问"采集器能看见什么"。仍是只读、仍不落盘。

### 新增

- **面板第六个通道 `architecture.collect`**：`main.js` 的 `PANEL_ANALYSIS_CHANNELS` 与
  `onPanelInvoke` 分派该通道，只接受 `scopeRoots` 与 `maxFiles`，其余 key 返回
  `invalid_option`；实现委托 `collectCurrentState`，与命令、Agent 工具走同一份采集器，
  不引入第二套逻辑。
- **采集表单**放在 `renderer/index.html` 的 `<div id="reader" hidden>` 之外：整个分析区
  要载入模型后才出现，而采集是引导步骤，必须在没有模型时可达。结果只渲染摘要卡片
  （计数、覆盖账本、盲区、上限、边界），不把有界摘要伪装成可浏览的模型。
- `tests/host-adapter.test.js` 与 `tests/panel-interactions.test.js` 各补采集通道用例：
  无模型也可扫、`scopeRoots`/`maxFiles` 生效、四类坏 payload 拒绝、非法文件预算本地拒绝。

### 修复

- **`previewCard` 的预算文案过期**：面板写着"12,000 字符内存预览预算"，而
  `MAX_PREVIEW_CHARS` 早已是 24000。文案改为 24000。

### 已知限制（记录在案，未修复）

- **`architecture.collect` 面板通道尚未在真实宿主点击过**：代码路径与 Node 侧测试已覆盖，
  但宿主里的实机确认仍缺（`docs/host-acceptance.md` A14）。
- **右侧停靠视图的生命周期细节未逐项演练**：重复打开/关闭后的残留注册与重复面板未单独检查。
- **采集器读取但不建模的文件类型静默无诊断**：`.properties`/`.sh`/`.py` 已记录，未扩适配器。
- **Java/Maven/Gradle 依赖采集未实现**：只保证不静默忽略。
- **模型不是完整 C4 形状**：L4（Code）刻意不切；`datastore` 映射为 C4 `container`。
- **Draw.io 导出器仍不表达证据正文与 id-only 集合**。
- **`actor` 一律映射为 C4 `person`**：非人类执行者需在模型侧改用 `external` 类型。
- **实际保存/发布未实现**：宿主 `pi.fs.writeText` 是直接覆盖，没有原子替换或条件写入。
- **命令注销（A4）只有单测覆盖**，未在真实宿主确认。
- 三个采集适配器均为面向行的启发式，不是完整解析器。

## [1.3.0] - 2026-09-23

采集即得模型：面板里的一个按钮直接生成可用的架构模型，不必先在会话里让 agent 建模，也不落盘。

### 新增

- **采集结果当场成为活动模型**：`architecture.collect` 接受 `includeModel`，除原有界摘要外一并回传完整模型；面板把它载入阅读器，节点列表、筛选、详情、证据、关联边与 unknowns 立即可用，图查询、影响分析、健康检查与导出预览都在这份模型上跑。全程不写任何文件。
- **内存模型分析通道**：`architecture.query`、`architecture.impact`、`architecture.health`、`architecture.exportPreview` 的面板入口接受 `model` 字段代替 `path`。主进程对回传的模型重新跑 `validateModel`，结构性不合格直接拒绝，不分析。
- 阅读器头部显示模型来源（`来自文件 <path>` 或 `来自本次采集（未落盘）`），有界摘要与已保存文件不会被误认。
- `architecture.compare` 仍然只读两个文件，并明确拒绝内存模型，不猜变更来源。

### 安全边界

- **Agent 工具契约不变**：三个分析工具的 schema 都是 `additionalProperties: false`，`model` 字段在到达主进程前就被拒绝。内存模型这条路只有面板能走，回归测试固定了这一点。
- inline 模型沿用文件模型的 2 Mi 字符预算，超限报 `MODEL_TOO_LARGE`，不静默截断。

### 已知限制（记录在案，未修复）

- **`architecture.collect` 面板通道尚未在真实宿主点击过**：代码路径与 Node 侧测试已覆盖，实机确认仍缺（`docs/host-acceptance.md` A14）。
- **采集的模型无法从面板存成文件**：宿主 `pi.fs.writeText` 是直接覆盖，没有原子替换、排他创建或条件写入。要长期保留，请用导出预览的 JSON 自行保存后重新读取。内容寻址快照方案已记录在 `architecture/decisions/no-safe-publish-primitive.md`，等 `fs.write` 授权。
- **右侧停靠视图的生命周期细节未逐项演练**：重复打开/关闭后的残留注册与重复面板未单独检查。
- **采集器读取但不建模的文件类型静默无诊断**：`.properties`/`.sh`/`.py` 已记录，未扩适配器。
- **Java/Maven/Gradle 依赖采集未实现**：只保证不静默忽略。
- **模型不是完整 C4 形状**：L4（Code）刻意不切；`datastore` 映射为 C4 `container`。
- **Draw.io 导出器仍不表达证据正文与 id-only 集合**。
- **`actor` 一律映射为 C4 `person`**：非人类执行者需在模型侧改用 `external` 类型。
- **命令注销（A4）只有单测覆盖**，未在真实宿主确认。
- 三个采集适配器均为面向行的启发式，不是完整解析器。
## [1.3.1] - 2026-09-24

采集出来的模型在面板里显示成一个 UUID。

### 修复

- **采集模型的 `project.name` 缺失**：`collectCurrentState` 只把宿主上报的
  `projectId` 写进 `project.id`，而宿主那个 id 是内部 UUID。面板的项目标题取
  `project.name || project.id`，于是"采集并生成模型"之后，当前档案显示的是
  `431709df-a724-4e91-ac3d-7fa82e6c2688` 这样的字符串，读一个已有模型文件却又
  显示正常名字——同一块区域两种含义，且 UUID 那种不可核对。现在 `project.id`
  仍是宿主那个稳定身份，工作区名字写进 `project.name`（schema 一直允许该可选
  字段，此前没人写）。不传 `projectName` 时对象与之前逐字节相同。
- 顺带修掉本轮编辑中三处被覆盖的行：`options.js` 的 `sourceRevision` 归一化与
  `scopeRoots` 赋值、`index.js` 的 `scope` 字段。三者都由回归测试固定（缺失时
  模型校验直接失败），但它们是编辑事故而非设计变更，记录在此以免下次被当成
  有意删除。

### 已知限制（记录在案，未修复）

- **宿主未提供工作区名字时仍会回退到 id**：`pi.workspace.get()` 不返回 `name`
  的会话里，面板只能显示 `project.id`。已如实回退，不编造名字。
- **`architecture.collect` 面板通道尚未在真实宿主点击过**：实机确认仍缺
  （`docs/host-acceptance.md` A14）。
- 其余限制与 1.3.0 相同：停靠视图生命周期未逐项演练、采集器读取但不建模的
  文件类型静默无诊断、Java/Maven/Gradle 依赖采集未实现、模型不是完整 C4 形状、
  Draw.io 导出器不表达证据正文、`actor` 一律映射为 C4 `person`、实际保存/发布
  未实现、命令注销只有单测覆盖、三个采集适配器均为面向行的启发式。
