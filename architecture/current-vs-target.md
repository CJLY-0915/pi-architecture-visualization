# current-vs-target：把插件做到"足够完善"还差什么

- 生成时间：2026-09-23T16:04:14+08:00（与本目录 `model.json` 同一轮）
- 当前态来源：`architecture/model.json`（`state: current`，17 节点 / 19 边 / 27 证据）
- 目标态来源：**仓库自己声明的退出门**，不是本文件发明的目标。逐行引用 `PLAN.md`、`README.md`、`docs/host-compatibility.md` 与技能合同。
- 本文件只记录差距与切片，**不建立 current→target 的边**：跨状态边会被 `src/core/validation.js` 拒绝，也不该把"想做的"画成"已存在的"。

## 差距表

| # | 能力 | 当前证据 | 目标陈述 | 谁说的 | 置信 | 切片 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | 实际保存与发布 | `PLAN.md:373` 仅"无副作用安全快照规划"；`manifest.json` 无 `fs.write`；`README.md:109` 明确未实施 | "路径越界、敏感路径、软链逃逸、权限撤回、并发修改和取消都安全失败；成功保存的模型可再次读取并通过校验" | `PLAN.md:371` | high | S1 |
| G2 | 宿主生命周期闭环 | `docs/host-compatibility.md` 尚需验证 1–6、8–11；本轮新验证 dev 热重载、13 技能注册、扩展注册 | "命令、面板、技能、工具和卸载闭环通过" | `PLAN.md:249`（P1 退出门） | high | S2 |
| G3 | 场景技能实效 | `logs/app/plugin.log` `plugin.skills.register count=13`；本轮真实加载 2 个技能 | "加载一个技能并确认目录与正文按需可用；撤销 `agent.prompt.inject` 后确认技能停止到达模型" | `PLAN.md:265` | medium | S3 |
| G4 | 五类集合字段合同 | `schemas/architecture-model.schema.json:122-133` 仅 id-only；`PLAN.md:303` | 最小模型字段合同完整，`findings`/`decisions` 可被 health 与 compare 消费 | `PLAN.md:291`、`PLAN.md:424` | medium | S4 |
| G5 | decisions 伴生文档 | 模型含 `decision:no-safe-publish-primitive`，本轮之前无伴生文档（悬空 claim） | "A decision id with no companion document is a dangling claim" | `skills/evolution-planner/SKILL.md` | high | S4（本轮已补 `architecture/decisions/no-safe-publish-primitive.md`） |
| G6 | PNG 导出 | `README.md:83` 明确受限：零依赖边界内无图形渲染栈 | "导出包含模型版本、范围、来源 revision、生成时间、图例和限制"，不支持的格式明确提示 | `PLAN.md:393` | high | S5 |
| G7 | CI 与静态检查 | 无 CI、无 lint、无类型检查；git 仓库本轮才初始化（`f410fb0`） | "运行类型检查、单测、适配器测试、路径安全测试和最小宿主 E2E" | `PLAN.md:413` | high | S6 |
| G8 | 英文可用性 | `manifest.json` 有 `i18n`；README/PLAN/docs/13 个技能均为中文 | "键盘可操作，中英文和明暗主题可用" | `PLAN.md:393` | medium | S7 |
| G9 | 大仓库覆盖 | 采集上限 150 节点 / 300 边 / 240 KiB，`maxFiles` 默认 500（`README.md:75`、manifest settings） | "超大输入、语法错误、敏感文件、软链越界和超时都有受控失败" | `PLAN.md:318` | high（受控失败已实现；大仓库实测未做） | S8 |
| G10 | 运行时证据 | 无 `runtime` 类型采集器；`validateModel` 要求 confirmed 的运行观测必须引 `runtime` 证据 | "当前代码、配置、Schema、IaC、ADR 和运行证据是否与模型发生确定性差异" | `PLAN.md:401` | medium | S9 |
| G11 | 分发回归 | `dist/` 有历史 `.piplug`；无干净环境安装回归；无 CHANGELOG；`version` 仍 `0.1.0` | "在干净环境验证安装、启用、升级、禁用和卸载；确认权限扩大需要重新审核" | `PLAN.md:415` | high | S10 |

## 切片（按依赖 → 风险 → 可回滚性排序）

| 切片 | 范围 | 进入条件 | 验证信号 | 回滚边界 |
| --- | --- | --- | --- | --- |
| S1 安全发布 | `datastore:target-model`、`module:host-adapters`、`module:contract`；新增 `fs.write` 权限 | 宿主写入语义已实测（create / 覆盖 / 已存在时行为 / 是否原子） | 并发保存两份不同模型均成功且无半成品；保存后回读通过 `architecture_validate`；越权与敏感路径安全失败 | 第一次真正写入用户项目 `architecture/` 之后——此前纯代码回滚，此后需数据迁移说明 |
| S2 宿主生命周期 | `container:panel`、`container:plugin-entry`、`external:pi-desktop-host` 之间的边 | dev 插件已加载（已满足） | `docs/host-compatibility.md` 尚需验证清单逐项翻成"已验证"并附日志行；撤销权限后技能/工具确实消失 | 无可回滚数据风险，纯验证成本 |
| S3 场景技能验收 | `module:skills`、`actor:agent` | 13 技能已注册（已满足） | 12 个场景各问一次，每次同一轮产出且 `architecture_validate` 通过；撤销 `agent.prompt.inject` 后目录不再到达模型 | 无 |
| S4 集合合同与伴生文档 | `module:contract`、`findings`/`decisions`/`migrationSlices`/`unknowns` | `decision:no-safe-publish-primitive` 已有伴生文档（本轮已完成） | schema 扩展后旧模型仍可校验；每个 decision id 都有伴生文件（可机器检查） | schema 变更前先冻结 v1 读者 |
| S5 PNG 面板侧渲染 | `container:panel` | S4 不必先做；面板已是浏览器上下文 | 面板内 canvas 导出 PNG，且明确标注非位图级保真；零依赖守卫测试仍通过 | 无（纯前端增量） |
| S6 CI | `module:tests`、`module:docs` | git 仓库存在（已满足） | push 触发 `node --test tests/*.test.js` + manifest 合同门禁；三平台通过 | 无 |
| S7 英文可用性 | `module:skills`、`module:docs`、`renderer/index.html` | 无 | 英文提问路由到同一场景技能并产出合法产物；README 有英文节 | 无 |
| S8 大仓库实测 | `module:collectors`、`datastore:target-model` | 需要一个真实大仓库作为目标 | 在 >500 文件仓库上采集，`coverage.complete=false` 且原因明确，无静默截断 | 无 |
| S9 运行时证据边界 | `datastore:target-model`、`module:core-model` | 无 | 要么提供手动 runtime 证据导入并校验，要么在模型与文档中把"无 runtime 证据"固化为 unknown | 无 |
| S10 分发回归 | `module:contract`、`dist/` | S6 完成 | 干净环境安装/启用/升级/禁用/卸载全通过；权限扩大被要求重新审核；CHANGELOG 与 version 同步 | 已发布版本的卸载回归失败会影响用户，故放在最后 |

## 假设（未被用户确认）

1. "足够完善"= 兑现 `PLAN.md` 自己写下的完成定义与各阶段退出门。若你要的是别的靶子（例如"只求可分发的最小可用版本"或"生产级、可被他人依赖"），排序会变：前者应把 S10 提前、S1/S8/S9 降级；后者应把 S1、S6、S8 提前。
2. S1 的前提是宿主最终会提供原子发布原语；若宿主明确不提供，则退化为"内容寻址快照 + 指针文件只追加不覆盖"的自建方案，需要在伴生决策文档里记录取舍。
3. G6 的 canvas 方案只是提案，未经实现验证。
