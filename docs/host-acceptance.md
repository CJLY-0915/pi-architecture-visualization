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
| A6 | 面板核心只读路径 | 打开工作台，载入模型，跑查询/影响/比较/预览/健康 | 核心路径正常，PNG 明确报受限 | 用户面板确认（`PLAN.md:391`，安装态 r6） | ✅ 历史 |
| A7 | 面板生命周期 | 重复打开/关闭面板；切项目；宿主销毁面板 | 无残留注册、无泄漏计时器、无重复面板 | 面板行为 + `plugin.log` | ✅ 用户本轮确认 |
| A8 | 权限撤销行为 | 在插件页撤销 `agent.prompt.inject` 后提问 | 技能目录不再到达模型；恢复后重新到达 | 系统提示技能目录 + `plugin.skills.skipped PERMISSION_DENIED` | ✅ 用户本轮确认 |
| A9 | 禁用/启用/卸载 | 禁用→启用→卸载插件 | 命令、工具、面板、订阅全部清理；无孤儿目录 | `plugin.log` + `plugins/installed` 目录 | ✅ 用户本轮确认 |
| A10 | `.piplug` 安装回归 | 干净环境安装→启用→升级→禁用→卸载 | 全通过；权限扩大被要求重新审核 | 安装流程截图/日志 | ✅ 用户本轮确认 |
| A11 | fs 符号链接逃逸 | 目标项目放置指向区外的符号链接 | 宿主拒绝或记录为覆盖缺口，不静默读取 | `architecture_collect` 的 `unresolved` | ✅ 用户本轮确认 |
| A12 | Plan 模式门控与工具超时 | Plan 模式下调工具；构造慢读取 | 明确拒绝/超时，不挂起 | Agent 会话 | ✅ 用户本轮确认 |

> A7–A12 由用户在本轮确认通过。本轮未保留日志或截图副本，因此证据列是用户证言而非日志摘录；如需日志级证据，复现时取 `logs/app/plugin.log` 与 `plugins/installed` 目录状态即可补行。

## B. 场景技能验收（对应 S3）

机器可校的部分已进 CI：`tests/skill-contract.test.js` 校验 13 个技能的 id 唯一、描述 ≤240（宿主截断阈值）、路由表只指向已声明技能、技能只调用已声明工具、不出现 shell/网络/写指令。下表是**人工验收**部分——每个场景至少问一次，要求同一轮产出且 `architecture_validate` 通过。

| 技能 | 提问示例 | 预期首产物 | 状态 |
| --- | --- | --- | --- |
| explore（路由） | 这个仓库是什么系统 | 任一场景技能的首产物 | ✅ 本轮路由 4 次 |
| system-modeler | 这个插件工作区的系统结构是什么 | `architecture/model.json` + 一个视图 | ✅ `model.json`(17 节点) + `views/current-state.dot`，validate ok |
| evolution-planner | 要做得更完善还差什么 | `architecture/current-vs-target.md` | ✅ 含 11 差距 + 10 切片 + decision 伴生文档 |
| dependency-impact-analyzer | 改 `src/core` 会影响什么 | `architecture/views/blast-radius-<change>.dot` | ✅ `blast-radius-module-core-model.dot`，impact ok:true，截断原因入图 |
| architecture-health | 这个模型健康吗 | health 发现清单 | ✅ ok:true、0 errors、7 findings（5 unknown + 2 low confidence） |
| flow-visualizer | 一次"校验模型"请求经过哪些节点 | 单条路径的 `.dot`/`.mmd` | ✅ `views/flow-validate-request.dot`。`architecture_query mode=paths` 得 `actor:agent →calls→ module:host-adapters →reads→ datastore:target-model`，**两条边均 inferred/medium**，无 confirmed 运行时证据；3 个缺口画成 unknown 并附定案检查 |
| deployment-topology-analyzer | 它跑在哪里、如何发布 | 容器/服务清单 | ✅ `deployment-inventory.md`。可部署单元按声明确认 4 行；**本仓库无 compose/K8s/Terraform/Dockerfile**，唯一 `docker-compose.yml` 是 `fixtures/` 测试夹具，按技能规则明确排除；runtime 一节 5 项全 unknown 各附定案检查 |
| risk-quality-reviewer | 这个架构有什么风险 | 排序风险表，每条带文件路径 | ✅ `risk-register.md`。6 条风险各带 8 字段（含 acceptance）；排序用 `architecture_impact`：`module:core-model` 13 节点 depth 5 **截断**、`module:contract` 14 节点 depth 4 未截断；另附 3 条技术债与 3 项覆盖缺口 |
| legacy-system-visualizer | （换到无文档仓库）这系统是什么 | unknowns-first 清单 | ✅ **场景错配已如实记录**：`legacy-inventory.md`。本仓库文档密度高于典型遗留系统，故 unknown 分"未经运行时证实"与"无主"两类；10 条 unknown 各带责任角色与定案步骤；聚类 5 组 + 4 个绑定五字段的切片 |
| architecture-communicator | 给管理层讲清楚这个插件 | 单一受众视图 | ✅ `views/executive.dot` + `communication-notes.md`。受众=决定是否继续投入者，决策写成一句；保留稳定 id 与出处簇；5 条"翻译时没有洗掉的约束"显式列出（含 A7–A12 的证据性质是用户证言） |
| c4model | 出一张 C4 图 | L1/L2 C4 视图 | ✅ `views/c4-l1-system-context.structurizr.dsl` + `views/c4-l2-container.structurizr.dsl` + `c4-fit-notes.md`。**发现模型不是 C4 形状**：7 个 `module` 节点直接挂 `system`，跳过了 container/component，故 L3/L4 不可切、L2 只剩 3 个 container（12 条内部边里 9 条在 module 之间，L2 一条画不出） |
| graphviz | 出一张关系密度高的 DOT | `.dot` 源 | ✅ `views/module-relations.dot`。19 条边**全部带关系类型标签**，DOT id 即模型 id；`rankdir=TB`、形状按图例统一；3 个孤点（`module:docs`、`module:contract`、`external:node-builtins`）按模型原样保留，不为构图补边 |
| drawio | 给我可编辑的 .drawio | `.drawio` XML | ✅ `views/current-state.drawio`（7796 字节，由插件自己的 `export-preview` drawio 渲染器生成，非手写；17 节点 + 19 边，id 集合与模型完全一致，边端点全部可解析）+ `drawio-export-notes.md`。**记录一处技能与实现的冲突**：导出器不表达 `status`/`confidence`，不满足技能" visibly 标记低置信度"的规则，本轮不手改 XML 而给人工标记指南 |

> 13 项全部问过。回答均来自模型/工具而非目录列表；产物落盘在 `architecture/`（本地、不入库）。两条需要记录的保留意见：
> 1. **legacy-system-visualizer 是场景错配下的验收**——本仓库不是无文档遗留系统，该项的完整验收需要一个真正的稀疏证据目标。
> 2. **drawio 暴露了实现与技能规则的冲突**——`src/core/export-preview.js` 的 drawio 渲染器丢弃 `status`/`confidence`，技能却要求 visibly 标记。要么改导出器，要么改技能措辞，不能两边都留着。

## C. 本轮（2026-09-23）已沉淀的工程基线

- `tests/registration-contract.test.js`：从 manifest 派生命令/工具/激活事件/面板白名单的期望集合，双向比对注册与注销。
- `tests/skill-contract.test.js`：技能描述长度、路由表、工具引用、常驻规则指向的技能名、禁 shell/写指令。
- `tests/manifest-contract.test.js`：技能显式 id 与唯一性（修复"13 个 SKILL.md 撞同一 id"的回归）。
- `.github/workflows/ci.yml`：三平台 `node --test tests/*.test.js`。
- `main.js`：validate/collect 的声明改为从 manifest 派生，消除第二份 schema 字面量。
- 全套 235 个用例通过；`PluginCheck` 通过（1 条高风险权限 warning）。
