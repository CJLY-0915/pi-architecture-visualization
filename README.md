# 架构可视化

PI-Desktop 插件：把一个代码仓库变成一份**每个结论都带证据**的架构事实模型，并在这份模型上做只读的查询、影响分析、健康检查与导出。

仓库：<https://github.com/CJLY-0915/pi-architecture-visualization>（`main`；推送到 `main` 或开 PR 会触发三平台 CI）。版本 **1.1.0**；变更与已知限制见 [CHANGELOG.md](./CHANGELOG.md)；完整定位、场景与价值论证见 [docs/positioning-and-value.md](./docs/positioning-and-value.md)。

## 它解决什么问题

架构知识的腐烂速度比代码快。口头描述、白板照片、三年前的 PPT、某人脑子里的映射——这些来源没有证据、没有修订号、没有失效信号。于是常见三类事故：

1. **重构前不知道会影响谁**：删一个"没人用"的模块，凌晨被叫起来。
2. **新人问"这个系统是什么"，三个人三个版本**，且都无法核对。
3. **文档说支持 X，代码里那条路径三年前就静默消失了**：没人知道，因为没人能证明它不存在。

这个插件把这三件事变成可执行、可核对：模型里的每个节点和每条边都挂 `evidenceIds`（指向 `file:line`），都带 `status`（`confirmed`/`inferred`/`assumed`/`unknown`）和 `confidence`。查不到证据的事实不会被画成确认的框；采集器的盲区（动态 `import()`、字符串键派发、Java 构建文件）会以 `unsupported_input` 显式报告，而不是安静地产出一张看起来完整的空图。

## 怎么用

三个入口，按场景选：

| 入口 | 怎么做 | 适合 |
| --- | --- | --- |
| **技能（对话）** | 直接描述问题；常驻路由把架构类问题送到 `Architecture Explore`，由它选 12 个场景技能之一 | 绝大多数情况，不需要记工具名 |
| **工作面板** | 右侧工作面板的"架构可视化"标签页，或命令面板搜 `Architecture: Open Workbench` | 边读边查：采集探测、读模型、查图、跑影响、比快照、看导出预览与健康发现 |
| **Agent 工具** | `architecture_validate` / `architecture_collect` / `architecture_query` / `architecture_impact` / `architecture_compare` / `architecture_snapshot_plan` / `architecture_health` | 脚本化、CI 里跑 |

可以直接问技能的典型问题：

| 问 | 得到 |
| --- | --- |
| 这个系统现在由什么组成 | 系统上下文 / C4 L1/L2/L3 视图 |
| 改 `src/core` 会影响什么 | 影响范围图，带截断位置与每条边的置信度 |
| 一次"校验模型"请求怎么走 | 单条路径图，同步/异步与失败语义标在边上 |
| 它跑在哪里、怎么发布 | 部署清单（测试夹具明确排除在外） |
| 这个架构有什么风险 | 排序风险表，每条带验收标准 |
| 这两个快照差什么 | 按稳定身份比较的语义差异 |
| 接手一个没人懂的遗留系统 | 未知项优先的清单，开篇即未知项 |
| 给我一份能自己改的图 | `.drawio`，非确认事实带三重标记 |

面板最小三步：还没有模型时先点"运行采集探测"看采集器能看见什么（只读、不落盘）→ 有模型后路径填入模型（默认 `architecture/model.json`）点"读取模型" → 在图查询或影响分析里提交一个节点 ID。导出预览只是内存文本：不保存、不下载、不写工作区。
12 个场景技能：`system-modeler`、`flow-visualizer`、`dependency-impact-analyzer`、`deployment-topology-analyzer`、`evolution-planner`、`risk-quality-reviewer`、`legacy-system-visualizer`、`architecture-communicator`、`architecture-health`，以及 `c4model`/`graphviz`/`drawio` 三个输出格式基础技能。它们复用同一模型与证据规则，区别只在产出形状。

## 它为工程实践带来什么

每条都是"之前 → 之后"，可观察、可反驳：

1. **影响分析**：问三个人得到三个答案 → 可达集加每条边的 `status`/`confidence`，截断位置明确写出。
2. **隐性依赖**：`pom.xml`、动态 `require()` 被无声跳过 → 显式 `unsupported_input`，盲区进清单，不进空图。
3. **C4**：只有一层能看 → 按 `parentId` 链切 L1/L2/L3，每个元素带 `type/status/confidence` 与模型 id。
4. **可编辑交付物**：`inferred` 和 `confirmed` 的节点在图里长得一样 → 标签后缀、状态填充色、虚线轮廓三重标记。
5. **文档数字**：各写各的 → 用例数、打包文件数、版本号由测试锁定。
6. **安全边界**：靠猜 → 声明出来。只读、超限即报告、`coverage.complete=false` 就是 `false`、PNG 明确报告受限而不伪造二进制。

## 边界：它不是什么

| 不是 | 为什么 |
| --- | --- |
| 不是渲染器 | 宿主没有 Structurizr/Graphviz/Draw.io 渲染栈；`.dsl`/`.dot`/`.drawio` 是文本产物，要真图送外部工具 |
| 不是写入工具 | 不申请 `fs.write`；宿主缺原子发布原语，保存只做规划不写真文件 |
| 不是发现引擎 | `architecture_collect` 是证据交叉核对，不是系统枚举；找不到的会报告，不猜 |
| 不是 Git 工具 | 不读 Git、不推断分支；`architecture_compare` 只比较两个模型文件 |
| 不是完整 C4 工具链 | 有层级切分，没有 C4 渲染；L4（Code）刻意不切，模块密度归 `graphviz` |

什么时候不该用：想知道"现在跑得怎么样"（它只读模型，不观测运行时）；要一张能贴进 PPT 的位图（送外部工具）；系统几乎没有静态证据（先用 `legacy-system-visualizer` 做未知项清单，不要先建模）。

## 快速开始

1. **加载**：作为 dev 插件从本目录加载，或安装 `.piplug`。开发前读 [docs/host-compatibility.md](./docs/host-compatibility.md)，确认当前宿主版本的 SDK、面板桥、Agent 工具和打包能力。
2. **命令**：`Architecture: Open Workbench`（浮动面板）、`Architecture: Validate Model`（默认读 `architecture/model.json`）、`Architecture: Collect Current State`（扫描工作区）。
3. **权限**：只申请 `fs.read`（工作区读）、`ui.panel`/`ui.view`（浮动面板与右侧停靠视图）、`agent.prompt.inject`/`agent.tool.register`/`agent.extension`（技能与工具注册）。不申请 `fs.write`、网络、删除、命令执行、剪贴板。新增权限必须回插件页审查，热重载不会自动带上。
4. **测试**：`npm test`（固定为 `node --test tests/*.test.js`；不要写成 `node --test tests`，本机 Node 会把目录当模块加载）。

## 工程参考（维护者向）

### 模型契约

- `state` 区分 `current`/`target`/`runtime`；`status` 区分 `confirmed`/`inferred`/`assumed`/`unknown`。确认项必须引用证据，确认的运行观测还必须引用 `runtime` 类型证据。
- ID 在各集合内唯一，引用按集合解析，跨集合允许同名。`views`/`findings`/`decisions`/`migrationSlices`/`unknowns` 当前只冻结对象与 ID 约束，详细合同尚未冻结。
- `unknowns` 承载待回答的架构问题而非扫描缺口；采集阶段保持空数组，扫描缺口由 `coverage` 与 `unresolved` 表达。
- 结构合同见 `schemas/architecture-model.schema.json`，跨字段语义规则由 `src/core/validation.js` 执行。
- 读取前 2 MiB 限制、解码后 2 Mi 字符、结果 240 KiB（低于宿主 256 KiB）；宿主入口另有深度 32、节点 2000、环 100、候选边步骤 100000 的上限。超限**报告**，不静默成功。
- `coverage` 落三个计数：`filesListed = filesScanned + filesSkipped + 被策略忽略数`。`complete` 只在遍历跑完且未触发任何上限时为 `true`；单文件读失败或超 `maxFileChars` 只记诊断并计入 `filesSkipped`，不把整次扫描判为不完整——扣留规模看 `filesSkipped`，不要只读 `complete`。

### 采集器能力

`collectModel({ source, options })` 是纯函数：不接触真实文件系统、不联网、不读取当前时间，因此同一输入总是得到逐字节相同的输出。

| 适配器 | 支持范围 | 明确不建模（产出 `unsupported_input`，只索引） |
| --- | --- | --- |
| `js-ts` | 静态 `import`/`export ... from`、字符串字面量 `require()`/`import()`、相对与根相对说明符、`package.json` 中的裸包声明 | 非字面量 `import()`/`require()`、tsconfig 路径映射、`exports`/`main` 解析、re-export 桶文件 |
| `manifests` | `package.json`、`requirements.txt`、`pyproject.toml`（仅 `[project]`/`[tool.poetry]` 的单行 `dependencies`）、`go.mod` 的 `group:artifact:version` 字符串 | 多行或表形式的 TOML 依赖、`project(':core')` 等 Gradle 记法、其它包管理器 |
| `infra` | Compose 顶层服务与 `depends_on`、Kubernetes 清单的 `kind` + `metadata.name` | OpenAPI/Swagger、CI 工作流、Terraform、其它 YAML，以及 `pom.xml` 与 `build.gradle`/`build.gradle.kts`/`settings.gradle`/`settings.gradle.kts`——这些 Java 构建文件被匹配只为显式报告，不产出节点或边 |

敏感路径（`.env*`、`.ssh/`、`.aws/`、`.git/`、`*.pem`、`*.key`、`id_rsa*`、`credentials*`、`secrets*`、`.npmrc`）和不安全路径（绝对路径、盘符、反斜杠、`.`/`..` 段）从不调用 `readText`。三个适配器都是面向行的启发式解析，不是完整解析器；各自已知限制写在文件头注释中。

### 工具速查

| 工具 | 最小调用 | 要知道的事 |
| --- | --- | --- |
| `architecture_validate` | `{"path":"architecture/model.json"}` | 只检查结构与引用，不读取证据源文件、不确认事实真实性、不写入 |
| `architecture_collect` | `{"scopeRoots":["."],"maxFiles":500}` | 只读扫描；返回有界摘要（含 `coverage` 与 `unresolved`），完整模型只在内存 |
| `architecture_query` | `{"path":"...","mode":"neighbours","targets":["container.api"],"direction":"both"}` | `mode` 支持 `filter`/`neighbours`/`paths`/`cycles`，路径查询用 `from`/`to`；过滤字段含节点 `ids/types`、`statuses/confidences/minConfidence`、`evidenceTypes/evidencePath`，关系类型用 `relationTypes`；风险字段合同尚未冻结，`risk` 过滤明确拒绝而非静默忽略 |
| `architecture_impact` | `{"path":"...","targets":["module.invoice"],"direction":"upstream","maxDepth":5}` | 目标接受稳定节点 ID 或证据路径；结果是模型可达性，不是运行时故障预测 |
| `architecture_compare` | `{"beforePath":"a.json","afterPath":"b.json"}` | 不推断 Git、分支或变更集；缺变更源返回 `change_source_unavailable` |
| `architecture_snapshot_plan` | `{"path":"..."}` | 返回规范化 JSON、SHA-256 与唯一目标路径；从不选 `architecture/model.json`，不写文件 |
| `architecture_health` | `{"path":"..."}` | 报告合同违规、覆盖声明、未知项、无证据事实；始终 `sourceContentVerified:false` |

示例路径用 `fixtures/valid-minimal-model.json` 即可跑通（5 节点 / 3 边 / 3 证据）。
查询与影响的时间行为：默认时钟固定为零以保证可重复；显式传 `maxTimeMs`（1–1000）时宿主边界才注入真实时钟，时间截断结果不保证逐字节一致。

### 工作台与常驻规则

- 面板只经 `window.pluginBridge.invoke` 访问 6 个固定通道（`architecture.query`/`architecture.impact`/`architecture.compare`/`architecture.exportPreview`/`architecture.health`/`architecture.collect`）以及宿主 `workspace.get`、`fs.stat`、`fs.readText`，不碰任意 Electron IPC，也不调用 Agent 工具注册表。`architecture.collect` 是引导探测：不依赖已载入的模型，只接受 `scopeRoots` 与 `maxFiles`，返回与命令/工具同一份有界摘要。宿主**没有**打开停靠视图的 API，命令因此保留为浮动面板入口。
- 内存预览 10 种格式：Structurizr DSL、C4 层级 DSL、DOT、Mermaid、Draw.io XML、Markdown、JSON、SVG、PNG（明确报告受限）、离线 HTML。`c4` 按 `parentId` 链切层；Draw.io 对非 `confirmed`/`high` 的事实带标记；每个预览都带模型版本、范围、revision、生成时间、覆盖状态、图例和限制。
- `extensions/workflow-rule.mjs` 刻意零依赖（无 import / fs / 网络 / 时钟 / 随机），由 `tests/agent-extension.test.js` 静态守卫。宿主用 `(acc,next)=>({...acc ?? {}, ...next})` 合并 handler 返回值，且返回的 `systemPrompt` 会**替换**整体提示，因此模块必须把 base 原样带上再拼接，追加以 `## Architecture Visualization` marker 判重。入口必须是 `.mjs`（`package.json` 为 `"type": "commonjs"`）。
- manifest 必须给每条技能显式 `id`：宿主用文件基名派生技能 id，13 个 `SKILL.md` 会撞成同一个，只注册第一个。`agent.extension` 已由用户在插件页显式授予；dev 插件的权限天花板冻结在授权时刻。

### 质量门禁

`node --test tests/*.test.js` 当前 270/270；三平台 CI 全绿；干净镜像 `PluginCheck` 无错误通过（运行时集合 40 文件，由 `tests/package-scope.test.js` 断言）；`.piplug` 只由不含会话目标文件与临时镜像的干净镜像经官方 `PluginPack` 生成并审计。逐项宿主验收（A 组生命周期 14 项、B 组场景技能）见 [docs/host-acceptance.md](./docs/host-acceptance.md)。

## 设计原则

- 架构事实以 `architecture/model.json` 为准，图和报告是派生物。
- 每个重要节点、关系、风险和决策都要能追溯到代码、配置、文档、测试或运行证据。
- 当前状态、目标状态、运行观测、假设和未知项必须分开。
- 当前版本完全只读：不申请或调用 `fs.write`、`fs.delete`、网络、剪贴板或命令执行。
- 不把 Draw.io、SVG、PNG 或手工导出图作为事实来源。
