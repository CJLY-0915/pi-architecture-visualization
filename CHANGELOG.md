# 变更记录

格式遵循 Keep a Changelog；版本号遵循语义化版本。本仓库在 1.0.0 之前没有变更记录，
因此 1.0.0 条目覆盖的是整个开发周期的净结果，而不是相对某个已发布版本的增量。

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

- **右侧停靠视图只验证了一半**：`ui.view` 授权与插件重载已确认，用户也已在真实宿主打开该
  标签页并看到界面；视图内的读取与查询路径尚未逐项确认。宿主没有供插件自行打开视图的 API，因此只能由用户在工作面板点开。
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
