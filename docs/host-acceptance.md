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
| A13 | 右侧停靠视图 | 在插件页授予 `ui.view` 后重载插件；在右侧工作面板点开 Architecture 标签 | 视图出现并与浮动面板同样可读模型、可跑查询；无残留注册、无重复面板 | 注册表 `permissions`/`capabilities` + `plugin.log`（授权与重载）；工作面板（视图本身） | ◐ 前半段已确认：`ui.view` 授权生效、插件无错误重载（注册表 `permissions` 含 `ui.view`、`capabilities` 含 `views`；`plugin.log` 中 `plugin.uninstalled` → `skills.register count=13` → `load.success` → `reload.success`）。后半段已推进：用户已在真实宿主打开该标签页并看到界面（2026-09-23，用户证言）；视图内的读取与查询路径尚未逐项确认 |
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
| drawio | 给我可编辑的 .drawio | `.drawio` XML | ✅ `views/current-state.drawio`（14195 字节，由插件自己的 `export-preview` drawio 渲染器生成，非手写；20 节点 + 27 边，id 集合与模型完全一致，边端点全部可解析）+ `drawio-export-notes.md`。**2026-09-23 冲突已闭合**：导出器现在对非 `confirmed`/`high` 的事实带标签后缀、状态填充色与虚线轮廓，规则写在 XML 注释里；技能规则改为"验证标记存活"。同轮修掉预览预算截断 drawio 导出的缺陷 |

> 13 项全部问过。回答均来自模型/工具而非目录列表；产物落盘在 `architecture/`（本地、不入库）。两条当时的保留意见**均已在 2026-09-23 闭合**：
> 1. ~~**legacy-system-visualizer 是场景错配下的验收**~~ → 已在 `fixtures/legacy-sparse-project/`（真正稀疏：无文档、无测试、无 owner）上补验，产出 `architecture/legacy-inventory-sparse.md`，行为由 `tests/legacy-sparse-evidence.test.js` 固定。
> 2. ~~**drawio 暴露了实现与技能规则的冲突**~~ → 导出器改为表达 `status`/`confidence`，技能规则同步改写。两边不再矛盾。

## C. 本轮（2026-09-23）已沉淀的工程基线

- `tests/registration-contract.test.js`：从 manifest 派生命令/工具/激活事件/面板白名单的期望集合，双向比对注册与注销。
- `tests/skill-contract.test.js`：技能描述长度、路由表、工具引用、常驻规则指向的技能名、禁 shell/写指令。
- `tests/manifest-contract.test.js`：技能显式 id 与唯一性（修复"13 个 SKILL.md 撞同一 id"的回归）。
- `.github/workflows/ci.yml`：三平台 `node --test tests/*.test.js`。
- `main.js`：validate/collect 的声明改为从 manifest 派生，消除第二份 schema 字面量。
- 全套 268 个用例通过；`PluginCheck` 通过（1 条高风险权限 warning）。
- `.github/workflows/ci.yml` 的三平台 `node --test tests/*.test.js` **已全绿**：commit `bb03244` 的 run 中 macos-latest 9s、ubuntu-latest 5s、windows-latest 18s 全部 Success（总 21s）。证据是用户在 GitHub Actions 页面提供的运行截图，本机读不到（GitHub API 未认证返回 403）。

## D. 本轮（2026-09-23）闭合的三项记录在案缺口

- **C4 层级不可切**：新增导出格式 `c4`（`{focus, level}` 按 `parentId` 深度切 L1/L2/L3，元素类型按节点类型映射，`status`/`confidence` 与模型 id 保留在描述里，`parentId` 已表达的包含关系不再画 `contains` 边，模型没有该深度节点时以 `no_nodes_at_c4_level` 拒绝）；本仓库模型重塑为 6 container + 7 component，`actor:agent` 改为 `external:agent`（LLM 不是人，C4 `person` 会误导）；新增 `views/c4-l3-component.structurizr.dsl`，`c4-l1`/`c4-l2` 与 `current-state.drawio` 重新生成。
- **Draw.io 丢弃 status/confidence**：非 `confirmed`/`high` 的事实带标签后缀、状态填充色（confirmed 蓝/inferred 琥珀/assumed 橙/unknown 灰）与虚线轮廓，规则写在 XML 注释里；`skills/drawio/SKILL.md` 规则改为"验证标记存活，不要手工加第二套"。顺带修掉预览预算 12000 字符会截断 20 节点/27 边模型的 drawio 导出——截断后的 XML 是被切断的文件，预算提高到 24000 且截断时明确"不可作交付物"。
- **legacy 场景错配**：`fixtures/legacy-sparse-project/`（11 文件，无 README/docs/tests/CI/LICENSE/CODEOWNERS）+ `fixtures/legacy-sparse-model.json`（8 节点 / 4 边 / 5 unknowns）+ `tests/legacy-sparse-evidence.test.js`（5 条）+ `architecture/legacy-inventory-sparse.md`。
- 新增 `docs/positioning-and-value.md`：定位与边界、六个使用场景（各写清"得到/得不到"）、六条可观察的工程提升、以及上述三项的改进方案与验证标准。
- 版本 1.0.0 → 1.1.0；`node --test tests/*.test.js` 268/268。
- **仍未闭合**：A13 后半段（视图已打开并渲染，视图内读取/查询路径待逐项确认）、1.1.0 `.piplug` 安装回归、A4 命令注销、采集器读取但不建模的文件类型（`.properties`/`.sh`/`.py`）静默无诊断、Java/Maven/Gradle 依赖采集、实际保存/发布、L4 Code 层。逐条性质与状态见 `docs/positioning-and-value.md` 第五节。
