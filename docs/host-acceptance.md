# 宿主验收清单

`docs/host-compatibility.md` 记录"哪些宿主合同已核实"，本文件记录"还差哪些验收动作、怎么算过"。
每条都给出操作、预期结果和可复核证据。**没有证据行的状态一律写"未验证"**，不用静态检查冒充运行时验收。

状态图例：✅ 已验证（附证据）／⬜ 未验证／🧪 仅单测覆盖（未在真实宿主复跑）。

## A. 宿主生命周期（对应 S2）

| # | 验收项 | 操作 | 预期 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| A1 | dev 插件加载与热重载 | 改 `manifest.json` 或任意源文件 | 宿主自动 `plugin.unload` → `plugin.load.success` → `plugin.reload.success` | `logs/app/plugin.log` | ✅ 本轮多次出现 |
| A2 | 13 个技能全部注册 | 加载插件 | `plugin.skills.register count=13`，无 `DUPLICATE` | `logs/app/plugin.log` | ✅ 本轮确认（修复前为 `count=1`） |
| A3 | agent 扩展注册 | 加载插件 | 无 `plugin.agentExtensions.skipped`；插件能力含 `agentExtension` | `~/.pi-desktop/plugins/registry.json` | ✅ |
| A4 | 命令注册与注销 | 命令面板执行三条命令；卸载插件 | 三条命令可执行；卸载后不再出现 | 命令面板 + `plugin.log` | 🧪 `tests/registration-contract.test.js` |
| A5 | Agent 工具注册与调用 | 在 Agent 模式调用 7 个工具 | 公开名带 `plugin_local_architecture_visualization_` 前缀，均返回结构化结果 | `logs/app/tool.log` 中 `plugin.tool.executed ok=true` | ✅ collect/validate/impact/health 本轮真实调用；query/compare/snapshot_plan 为历史调用 |
| A6 | 面板核心只读路径 | 打开工作台，载入模型，跑查询/影响/比较/预览/健康 | 核心路径正常，PNG 明确报受限 | 用户面板确认（`PLAN.md:391`） | ✅ 历史 |
| A7 | 面板生命周期 | 重复打开/关闭面板；切项目；宿主销毁面板 | 无残留注册、无泄漏计时器、无重复面板 | 面板行为 + `plugin.log` | ✅ 用户本轮确认 |
| A8 | 权限撤销行为 | 在插件页撤销 `agent.prompt.inject` 后提问 | 技能目录不再到达模型；恢复后重新到达 | 系统提示技能目录 + `plugin.skills.skipped PERMISSION_DENIED` | ✅ 用户本轮确认 |
| A9 | 禁用/启用/卸载 | 禁用→启用→卸载插件 | 命令、工具、面板、订阅全部清理；无孤儿目录 | `plugin.log` + `plugins/installed` 目录 | ✅ 用户本轮确认 |
| A10 | `.piplug` 安装回归 | 干净环境安装→启用→升级→禁用→卸载 | 全通过；权限扩大被要求重新审核 | 安装流程截图/日志 | ✅ 用户本轮确认 |
| A11 | fs 符号链接逃逸 | 目标项目放置指向区外的符号链接 | 宿主拒绝或记录为覆盖缺口，不静默读取 | `architecture_collect` 的 `unresolved` | ✅ 用户本轮确认 |
| A12 | Plan 模式门控与工具超时 | Plan 模式下调工具；构造慢读取 | 明确拒绝/超时，不挂起 | Agent 会话 | ✅ 用户本轮确认 |
| A13 | 右侧停靠视图 | 在插件页授予 `ui.view` 后重载插件；在右侧工作面板点开 Architecture 标签 | 视图出现并与浮动面板同样可读模型、可跑查询；无残留注册、无重复面板 | 注册表 `permissions`/`capabilities` + `plugin.log`（授权与重载）；工作面板（视图本身） | ✅ 用户本轮确认：`ui.view` 授权生效、插件无错误重载（注册表 `permissions` 含 `ui.view`、`capabilities` 含 `views`；`plugin.log` 中 `plugin.uninstalled` → `skills.register count=13` → `load.success` → `reload.success`）；标签页已打开，读取模型、查询与影响分析均正常（2026-09-23，用户证言）。未单独检查：重复打开/关闭后的残留注册与重复面板（模型记 `unknown:docked-view-lifecycle-residue`） |
| A14 | 面板采集并生成模型 | 不载入模型，直接在浮动面板或停靠视图点"采集并生成模型" | 返回有界摘要（计数、覆盖账本、盲区、上限）并当场生成完整模型；阅读器立即可用，图查询/影响/健康/导出都在这份内存模型上跑；非正整数文件预算本地拒绝；结构性不合格的模型被拒绝而非分析 | 面板行为 + `tests/host-adapter.test.js`、`tests/panel-interactions.test.js` | ⬜ 本轮新增，待宿主确认 |
| A15 | 面板保存采集模型 | 授予 `fs.write` 并重载；点"采集并生成模型"→"确认目标状态"→"创建"；再点一次确认 `TARGET_EXISTS` 而不是覆盖 | 工作区出现 `architecture/model.json`；面板 `model-source` 变为"来自文件 …"；保存区块隐藏；已有目标时只给快照与显式覆盖；`plugin.log` 无 `PERMISSION_DENIED` | 注册表 `permissions`（含 `fs.write`/`clipboard.write`）+ `plugin.log` + 工作面板 + 工作区文件 | ⬜ 本轮新增，待宿主确认 |
> A7–A12 由用户在本轮确认通过。本轮未保留日志或截图副本，因此证据列是用户证言而非日志摘录；如需日志级证据，复现时取 `logs/app/plugin.log` 与 `plugins/installed` 目录状态即可补行。

## B. 场景技能验收（对应 S3）

机器可校的部分已进 CI：`tests/skill-contract.test.js` 校验 13 个技能的 id 唯一、描述 ≤240（宿主截断阈值）、路由表只指向已声明技能、技能只调用已声明工具、不出现 shell/网络/写指令。下表是**人工验收**部分——每个场景至少问一次，要求同一轮产出且 `architecture_validate` 通过。

| 技能 | 提问示例 | 预期首产物 | 状态 |
| --- | --- | --- | --- |
| explore（路由） | 这个仓库是什么系统 | 任一场景技能的首产物 | ✅ 本轮路由 4 次 |
| system-modeler | 这个插件工作区的系统结构是什么 | `architecture/model.json` + 一个视图 | ✅ `model.json`(17 节点) + `views/current-state.dot`，validate ok |
| evolution-planner | 要做得更完善还差什么 | `architecture/current-vs-target.md` | ✅ 含 11 差距 + 10 切片 + decision 伴生文档 |
| dependency-impact-analyzer | 改 `src/core` 会影响什么 | `architecture/views/blast-radius-<change>.dot` | ✅ `blast-radius-module-core-model.dot`，impact ok:true，截断原因入图 |
| architecture-health | 这个模型健康吗 | health 发现清单 | ✅ ok:true、0 errors、7 findings（5 unknown + 2 low confidence）；模型刷新后复跑为 3 findings（3 declared unknown）、0 errors |
| flow-visualizer | 一次"校验模型"请求经过哪些节点 | 单条路径的 `.dot`/`.mmd` | ✅ `views/flow-validate-request.dot`。`architecture_query mode=paths` 得 `actor:agent →calls→ module:host-adapters →reads→ datastore:target-model`，**两条边均 inferred/medium**，无 confirmed 运行时证据；3 个缺口画成 unknown 并附定案检查 |
| deployment-topology-analyzer | 它跑在哪里、如何发布 | 容器/服务清单 | ✅ `deployment-inventory.md`。可部署单元按声明确认 4 行；**本仓库无 compose/K8s/Terraform/Dockerfile**，唯一 `docker-compose.yml` 是 `fixtures/` 测试夹具，按技能规则明确排除；runtime 一节 5 项全 unknown 各附定案检查 |
| risk-quality-reviewer | 这个架构有什么风险 | 排序风险表，每条带文件路径 | ✅ `risk-register.md`。6 条风险各带 8 字段（含 acceptance）；排序用 `architecture_impact`：`module:core-model` 13 节点 depth 5 **截断**、`module:contract` 14 节点 depth 4 未截断；另附 3 条技术债与 3 项覆盖缺口 |
| legacy-system-visualizer | （换到无文档仓库）这系统是什么 | unknowns-first 清单 | ✅ `legacy-inventory.md`（本仓库，文档密集故 unknown 分"未经运行时证实"与"无主"两类）+ **2026-09-23 在真正稀疏的 `fixtures/legacy-sparse-project/` 上补验**，产出 `legacy-inventory-sparse.md`：8 节点里 5 个 unknown/assumed、3 个 confirmed，未知多于事实；开篇即未知项，每条带责任角色与定案步骤；`collectModel` 在该夹具上实测 3 条 `unsupported_input`，`orders→store` 这条隐藏依赖确实抓不到并已记录 |
| architecture-communicator | 给管理层讲清楚这个插件 | 单一受众视图 | ✅ `views/executive.dot` + `communication-notes.md`。受众=决定是否继续投入者，决策写成一句；保留稳定 id 与出处簇；5 条"翻译时没有洗掉的约束"显式列出（含 A7–A12 的证据性质是用户证言） |
| c4model | 出一张 C4 图 | L1/L2/L3 C4 视图 | ✅ `views/c4-l1-system-context.structurizr.dsl` + `views/c4-l2-container.structurizr.dsl` + `views/c4-l3-component.structurizr.dsl` + `c4-fit-notes.md`。**2026-09-23 已闭合**：当时发现 7 个 `module` 直接挂 `system` 导致 L3/L4 不可切；现已重塑为 6 container + 7 component，并新增插件侧 `c4` 导出格式按 `parentId` 深度切层，L1/L2/L3 全部可切。L4 仍刻意不切 |
| graphviz | 出一张关系密度高的 DOT | `.dot` 源 | ✅ `views/module-relations.dot`。27 条边**全部带关系类型标签**，DOT id 即模型 id；`rankdir=TB`、形状按图例统一；孤点按模型原样保留，不为构图补边 |
| drawio | 给我可编辑的 .drawio | `.drawio` XML | ✅ `views/current-state.drawio`（14271 字节，由插件自己的 `export-preview` drawio 渲染器生成，非手写；20 节点 + 27 边，id 集合与模型完全一致，边端点全部可解析）+ `drawio-export-notes.md`。**2026-09-23 冲突已闭合**：导出器现在对非 `confirmed`/`high` 的事实带标签后缀、状态填充色与虚线轮廓，规则写在 XML 注释里；技能规则改为"验证标记存活"。同轮修掉预览预算截断 drawio 导出的缺陷 |

> 13 项全部问过。回答均来自模型/工具而非目录列表；产物落盘在 `architecture/`（本地、不入库）。两条当时的保留意见**均已在 2026-09-23 闭合**：
> 1. ~~**legacy-system-visualizer 是场景错配下的验收**~~ → 已在 `fixtures/legacy-sparse-project/`（真正稀疏：无文档、无测试、无 owner）上补验，产出 `architecture/legacy-inventory-sparse.md`，行为由 `tests/legacy-sparse-evidence.test.js` 固定。
> 2. ~~**drawio 暴露了实现与技能规则的冲突**~~ → 导出器改为表达 `status`/`confidence`，技能规则同步改写。两边不再矛盾。

## C. 1.1.0（2026-09-23）已沉淀的工程基线

- `tests/registration-contract.test.js`：从 manifest 派生命令/工具/激活事件/面板白名单的期望集合，双向比对注册与注销。
- `tests/skill-contract.test.js`：技能描述长度、路由表、工具引用、常驻规则指向的技能名、禁 shell/写指令。
- `tests/manifest-contract.test.js`：技能显式 id 与唯一性（修复"13 个 SKILL.md 撞同一 id"的回归）。
- `.github/workflows/ci.yml`：三平台 `node --test tests/*.test.js`。
- `main.js`：validate/collect 的声明改为从 manifest 派生，消除第二份 schema 字面量。
- 全套 268 个用例通过；`PluginCheck` 通过（1 条高风险权限 warning）。
- `.github/workflows/ci.yml` 的三平台 `node --test tests/*.test.js` **已全绿**：commit `bb03244` 的 run 中 macos-latest 9s、ubuntu-latest 5s、windows-latest 18s 全部 Success（总 21s）。证据是用户在 GitHub Actions 页面提供的运行截图，本机读不到（GitHub API 未认证返回 403）。

## D. 1.1.0（2026-09-23）闭合的三项记录在案缺口

- **C4 层级不可切**：新增导出格式 `c4`（`{focus, level}` 按 `parentId` 深度切 L1/L2/L3，元素类型按节点类型映射，`status`/`confidence` 与模型 id 保留在描述里，`parentId` 已表达的包含关系不再画 `contains` 边，模型没有该深度节点时以 `no_nodes_at_c4_level` 拒绝）；本仓库模型重塑为 6 container + 7 component，`actor:agent` 改为 `external:agent`（LLM 不是人，C4 `person` 会误导）；新增 `views/c4-l3-component.structurizr.dsl`，`c4-l1`/`c4-l2` 与 `current-state.drawio` 重新生成。
- **Draw.io 丢弃 status/confidence**：非 `confirmed`/`high` 的事实带标签后缀、状态填充色（confirmed 蓝/inferred 琥珀/assumed 橙/unknown 灰）与虚线轮廓，规则写在 XML 注释里；`skills/drawio/SKILL.md` 规则改为"验证标记存活，不要手工加第二套"。顺带修掉预览预算 12000 字符会截断 20 节点/27 边模型的 drawio 导出——截断后的 XML 是被切断的文件，预算提高到 24000 且截断时明确"不可作交付物"。
- **legacy 场景错配**：`fixtures/legacy-sparse-project/`（11 文件，无 README/docs/tests/CI/LICENSE/CODEOWNERS）+ `fixtures/legacy-sparse-model.json`（8 节点 / 4 边 / 5 unknowns）+ `tests/legacy-sparse-evidence.test.js`（5 条）+ `architecture/legacy-inventory-sparse.md`。
- 新增 `docs/positioning-and-value.md`：定位与边界、六个使用场景（各写清"得到/得不到"）、六条可观察的工程提升、以及上述三项的改进方案与验证标准。
- 版本 1.0.0 → 1.1.0；`node --test tests/*.test.js` 268/268。
- **仍未闭合**：A13 生命周期细节（重复打开/关闭停靠视图后的残留注册与重复面板）、A14 面板采集探测通道、1.2.0 `.piplug` 安装回归（1.0.0/1.1.0 的包也未重做）、A4 命令注销、采集器读取但不建模的文件类型（`.properties`/`.sh`/`.py`）静默无诊断、Java/Maven/Gradle 依赖采集、实际保存/发布、L4 Code 层。逐条性质与状态见 `docs/positioning-and-value.md` 第五节。

## E. 1.2.0（2026-09-23）新增：面板采集探测

- 面板新增第六个通道 `architecture.collect`：`main.js` 的 `PANEL_ANALYSIS_CHANNELS` 与 `onPanelInvoke` 分派该通道，只接受 `scopeRoots` 与 `maxFiles`，其余 key 返回 `invalid_option`，实现委托 `collectCurrentState`——与命令/Agent 工具走同一份采集器，不引入第二套逻辑。
- 采集表单位置在 `<div id="reader" hidden>` **之外**（`path-help` 之后）：整个分析区要载入模型后才出现，而采集是引导步骤，必须在没有模型时可达。结果只渲染摘要卡片（计数、覆盖账本、盲区、上限、边界），不把有界摘要伪装成可浏览的模型。
- 回归覆盖：`tests/host-adapter.test.js`（无模型也可扫、`scopeRoots`/`maxFiles`、四类坏 payload 拒绝）与 `tests/panel-interactions.test.js`（payload 解析、盲区渲染、非法预算本地拒绝），共 +2 条。
- 顺带修掉 `previewCard` 里过时的"12,000 字符内存预览预算"——`MAX_PREVIEW_CHARS` 早已是 24000。
- 版本 1.1.0 → 1.2.0；`node --test tests/*.test.js` 270/270。
- **采集结果当场成为活动模型**：`architecture.collect` 接受 `includeModel` 一并回传完整模型，面板载入阅读器；四个分析通道的面板入口接受 `model` 代替 `path`，主进程重新校验后才使用。Agent 工具契约不变（`additionalProperties: false` 已拒绝 `model`），内存模型这条路只有面板能走。
- 版本 1.2.0 → 1.3.0；`node --test tests/*.test.js` 273/273。

## F. 1.4.0（2026-09-24）新增：面板保存采集模型（用户授权 A）

- **动机**：1.3.0 让"采集并生成模型"一键得到可用模型，但产物只在内存；GPT 外部评审指出"一键 Analyze Project"应包含"自动保存 ↓ 打开架构图"。用户选择方案 A——授权 `fs.write`，把闭环补齐。
- **权限**：`manifest.permissions` 增加 `fs.write`，并首次声明 `manifest.fs.write = {root:"workspace", scope:["architecture/**"]}`。宿主 `scopePatternError` 拒绝覆盖整个 root 的写范围；`architecture/**` 合法。`fs.write` 属宿主 `HIGH_RISK_PERMISSIONS`，与 `net.fetch`/`agent.prompt.inject` 同级，因此本项由用户显式授权（A 组 A15）。
- **顺带修掉一个既有缺陷**：宿主 `clipboard.writeText` 会 `assertPermission(loaded,"clipboard.write")`（`app.asar` `out/main/index.js:101097-101098`），而 1.3.0 上线的"复制到剪贴板"从未声明该权限——真实宿主必然拒绝，只是当时的测试用的是 stub bridge，看不出来。1.4.0 补上 `clipboard.write`，并由 `tests/registration-contract.test.js` 的"面板宿主桥通道→权限映射"测试永久守住（新增通道不在映射表里、或映射的权限没声明，测试即红）。
- **写入前明示目标状态**：`architecture.save` 无 `decision` 时只做规划，不写任何字节。返回目标路径、`targetState`（`missing`/`present`/`unknown`）、目标字节数、`snapshotPath`、以及新旧两边的节点/关系/证据数与 `sourceRevision`。`stat` 失败一律记为 `unknown` 而不是 `missing`——把看不见的目标说成不存在，正是一次静默覆盖的开始。
- **三种决策，只有一种能替换文件**：`create`（目标不存在才写，否则 `TARGET_EXISTS`）、`snapshot`（写 `architecture/snapshots/<sha256>.json`，内容寻址；同样内容已在盘上则报告 `alreadyPresent` 且不重复写）、`overwrite`（唯一允许替换已有文件的动作；目标无法 inspect 时以 `TARGET_STATE_UNKNOWN` 拒绝）。每个决策在写入时都重新 `stat` 一次，面板展示的计划不背着"目标当时不存在"这个过期结论。
- **模型不信任来源**：主进程重新跑 `validateModel` 与 `planSnapshotSave`，结构性不合格返回 `INVALID_MODEL`，一个字节都不写；沿用文件模型的 2 Mi 字符预算。
- **闭环**：写入标准路径成功后，面板立即用同一路径重新读取，`model-source` 从"来自本次采集（未落盘）"变为"来自文件 …"，保存区块随之隐藏——GPT 说的"自动保存 ↓ 打开架构图"至此完整。
- **写入不谎报**：宿主 `pi.fs.writeText` 是 `mkdirSync` + `writeFileSync` 直接覆盖，没有原子 rename、没有 CAS。因此写完后再 `stat` 一次，字节数不符即返回 `WRITE_UNVERIFIED`，不报成已保存。
- **只有面板能写**：`pi.fs.writeText` 在 `main.js` 中只出现一次（`writeHost()`）；没有任何 Agent 工具的 schema 带得了整个模型，因此保存没有 agent 入口。
- 回归覆盖：`tests/save-model.test.js`（新增 16 条：目标状态判定、三种决策、幂等快照、规范化文本与指纹、拒绝路径、写入复核）、`tests/host-adapter.test.js`（+5）、`tests/panel-interactions.test.js`（+3）、`tests/registration-contract.test.js`（+1）、`tests/analysis-tools.test.js`（写权限 scope 守卫）。
- 版本 1.3.1 → 1.4.0；`node --test tests/*.test.js` 303/303。运行时集合 40 → 41 文件，新集合的干净镜像 `PluginCheck` 实测待重跑。
- **A15 待用户确认**：在插件页授予 `fs.write`（与 `clipboard.write`）并重载后，点一次"采集并生成模型"→"确认目标状态"→"创建"，确认工作区出现 `architecture/model.json`、面板切换到"来自文件"、并且 `plugin.log` 无 `PERMISSION_DENIED`。

## G. 仍未闭合

- A4 命令注销、A13 重复打开/关闭停靠视图的残留注册、A14 面板采集通道、**A15 面板保存通道**、1.2.0 及以后各版本 `.piplug` 安装回归。
- 采集器读取但不建模的文件类型（`.properties`/`.sh`/`.py`）静默无诊断。
- Java/Maven/Gradle 依赖采集。
- L4 Code 层。

## H. 1.4.1（2026-09-24）修复：CI 三平台全红

- **现象**：`tests/export-preview.test.js` 的"预览预算足够完整导出真实规模模型"在 macOS / Ubuntu / Windows 三个平台全部 `ENOENT: architecture/model.json`。这是唯一一条失败的测试，三个平台同一根因。
- **根因**：该测试用 `path.join(__dirname, '..', 'architecture', 'model.json')` 读本仓库自身的架构模型，而 `architecture/` 在 `.gitignore` 里（`tests/package-scope.test.js` 的"local-only 目录不被 git 跟踪"守卫一直在确认这件事）。CI 上目录不存在，作者机器上存在——于是这条守卫**从写下起就没在 CI 跑过一次**，本地全绿是巧合。`bb03244` 的三平台全绿发生在这条测试出现之前，其后没人再回看过 CI。
- **修复**：把 `architecture/model.json` 在 1.4.0 时的快照固化为 `fixtures/realistic-model.json`（20 节点 / 27 边 / 30 证据 / 8 视图），测试改读夹具并把这三个计数钉死，快照被悄悄换掉会立刻红。新增守卫"no test reads a local-only directory"：任何测试文件用 `path.join` 或 `require` 触及 `architecture`/`dist`/`Temp`/`.pi`/`node_modules`/`coverage`/`.cache` 即失败；已用带病灶的探针文件双向验证两种形状都能抓住。测试里的裸 `'architecture/model.json'` 字符串是喂给桩宿主的内存路径，不算违规。
- **验证**：本地把 `architecture/` 临时改名后跑全量，304/304 通过——即 CI 上的真实环境。运行时与打包集合无变化（仍 41 文件、同样字节）。
- **待回看**：1.4.1 的三平台 CI run 结果。回看并通过前，README 与 `host-compatibility.md` 都不得写"CI 已全绿"。
