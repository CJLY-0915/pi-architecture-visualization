# 架构可视化

PI-Desktop 插件，用于理解、建模、评审和演进复杂软件架构。

仓库：<https://github.com/CJLY-0915/pi-architecture-visualization>（`main` 分支；推送到 `main` 或开 PR 会触发 `.github/workflows/ci.yml`，在 ubuntu / windows / macOS 三个平台跑 `node --test tests/*.test.js`）。

当前已实现 P2 模型合同与校验器、P3 确定性只读采集、P4 查询/影响/比较、P5 无副作用快照规划、P6 只读工作台与内存导出预览，以及 P7 模型健康检查。实际安全发布仍受宿主原子发布能力缺失阻塞，详见 [PLAN.md](./PLAN.md)。

## 开发

插件必须以 PI-Desktop 支持的直接可运行 JavaScript、HTML、CSS 和资源形式加载。开发前请阅读 `docs/host-compatibility.md`，确认当前宿主版本的 SDK、面板桥、Agent 工具和打包能力。

运行 `npm test` 可执行 Node 内置测试，无需安装依赖。合法样例见 `fixtures/valid-minimal-model.json`；结构合同见 `schemas/architecture-model.schema.json`，跨字段语义规则由 `src/core/validation.js` 执行。

Agent 工具内部名为 `architecture_validate`，参数为 `{ "path": "fixtures/valid-minimal-model.json" }`。命令面板的 Validate Model 默认读取 `architecture/model.json`。校验只检查结构与引用，不读取证据源文件、不确认事实真实性、不写入项目。

模型的 `state` 区分 `current/target/runtime`，`status` 区分 `confirmed/inferred/assumed/unknown`。确认项必须引用证据，确认的运行观测还必须引用 `runtime` 类型证据。ID 在各集合内唯一，引用按集合解析；跨集合允许同名。`views/findings/decisions/migrationSlices/unknowns` 当前只冻结对象与 ID 约束，详细合同留待对应阶段。

模型读取在宿主 `fs.stat` 返回尺寸后、`fs.readText` 之前拒绝超过 2 MiB 的文件；读取后仍限制 2 Mi 字符。工作台的本地 browser preview 使用受控 bridge 模拟，不能替代真实 PI-Desktop panel E2E；已核验范围见 [宿主兼容性记录](./docs/host-compatibility.md)。

## 常驻路由规则与技能目录

插件通过 `contributes.agentExtensions` 注册 `extensions/workflow-rule.mjs`：宿主 agent 侧车用 jiti 取其默认导出并执行 `factory(api)`，模块用 `pi.on('before_agent_start', ...)` 把一段固定规则追加到每轮系统提示。规则要求架构类问题（这是什么系统 / 边界在哪 / 什么依赖什么 / 改一处影响什么 / 跑在哪里 / 该如何演进 / 是否有风险 / 文档是否过期）先加载 `Architecture Explore` 路由技能，并在同一轮给出第一个落地产物，禁止只凭目录列表或包清单作答。

- 宿主用 `(acc,next)=>({...acc ?? {}, ...next})` 合并 handler 返回值，返回的 `systemPrompt` 会**替换**整体提示，因此模块必须把 base 原样带上再拼接；追加以 `## Architecture Visualization` marker 判重，重复挂载不会叠加。
- 模块刻意零依赖（无 import / fs / 网络 / 时钟 / 随机），由 `tests/agent-extension.test.js` 静态守卫，保证同一事件必然得到同一提示，也无需 agent 进程即可单测。
- 入口必须是 `.mjs`：`package.json` 为 `"type": "commonjs"`，`export default` 不能走 `.js`。
- 路由之外有 12 个场景技能：`system-modeler`、`flow-visualizer`、`dependency-impact-analyzer`、`deployment-topology-analyzer`、`evolution-planner`、`risk-quality-reviewer`、`legacy-system-visualizer`、`architecture-communicator`、`architecture-health`，以及 `c4model`/`graphviz`/`drawio` 三个输出格式基础技能。它们都复用同一模型与证据规则。
- **manifest 必须给每条技能显式 `id`**：宿主用文件基名派生技能 id，13 个 `SKILL.md` 会撞成同一个，只注册第一个、其余静默跳过。回归测试见 `tests/manifest-contract.test.js`。
- `agent.extension` 已由用户在插件页显式授予；dev 插件的权限天花板冻结在授权时刻，之后任何加权限/加 fs scope 的改动都必须再走一次插件页审查，热重载不会自动带上。
## 只读采集

`src/collectors/` 把注入的文件源转成 v1 模型，且是纯函数：不接触真实文件系统、不联网、不读取当前时间，因此同一输入总是得到逐字节相同的输出。入口为 `collectModel({ source, options })`，`source` 提供 `listFiles()` 和 `readText(path)`。

| 适配器 | 支持范围 | 明确不建模（产出 `unsupported_input`，只索引） |
| --- | --- | --- |
| `js-ts` | 静态 `import`/`export ... from`、字符串字面量 `require()`/`import()`、相对与根相对说明符、`package.json` 中的裸包声明 | 非字面量 `import()`/`require()`、tsconfig 路径映射、`exports`/`main` 解析、re-export 桶文件 |
| `manifests` | `package.json`、`requirements.txt`、`pyproject.toml`（仅 `[project]`/`[tool.poetry]` 的单行 `dependencies`）、`go.mod`、`pom.xml`、`build.gradle` 的 `group:artifact:version` 字符串 | 多行或表形式的 TOML 依赖、`project(':core')` 等 Gradle 记法、其它包管理器 |
| `infra` | Compose 顶层服务与 `depends_on`、Kubernetes 清单的 `kind` + `metadata.name` | OpenAPI/Swagger、CI 工作流、Terraform 及其它 YAML |

所有适配器都是面向行的启发式解析，不是完整解析器；每个文件头部注释声明了各自的已知限制。采集边界：

- 未解析项（`unsupported_input`、`unresolved_reference`）与跳过项（`unsafe_path_skipped`、`sensitive_path_skipped`）都在返回值的 `unresolved` 中并带文件路径，不会被提升为 `confirmed`。
- 敏感路径（`.env*`、`.ssh/`、`.aws/`、`.git/`、`*.pem`、`*.key`、`id_rsa*`、`credentials*`、`secrets*`、`.npmrc`）和不安全路径（绝对路径、盘符、反斜杠、`.`/`..` 段）从不调用 `readText`。
- `coverage.complete` 只有在扫描跑完且未触发 `maxFiles`、`totalCharBudget` 或 `timeoutMs` 时才为 `true`。达到任一上限时 `complete` 为 `false` 而 `ok` 仍为 `true`：截断既不算失败，也不会被当成完整结果。选项非法、无法列出文件、整个范围都被忽略（`no_files_in_scope`）或来源自带任何诊断时 `complete` 同样为 `false`，因为此时没有任何扫描结果可以声称完整。单个文件读失败或超 `maxFileChars` 只记 `file_too_large`/`source_read_failed` 诊断并计入 `filesSkipped`，不因此把整次扫描判为不完整——扣留规模看 `filesSkipped`，不要只读 `complete`。
- `filesListed` 计入源返回的每一条路径（含按策略忽略的构建产物与二进制）；`filesScanned` 是实际读过的；`filesSkipped` 是列出之后被扣留的（敏感、不安全、读失败、超限）。因此 `filesListed = filesScanned + filesSkipped + 被策略忽略数`，只有什么都没被忽略时前三者才相等。这三个计数与 `complete` 一起写入 `model.json`，因为只读文件本身的消费者也要能看出有文件被扣留。`ok` 为 `false` 仅表示模型不可用（选项非法、无法列出文件、模型未通过校验）。
- `unknowns` 在采集阶段保持空数组：它承载待回答的架构问题而非扫描缺口，扫描缺口由 `coverage` 与 `unresolved` 表达，持久化到 `model.json` 留待 P5。

### 宿主接线

`src/host/fs-source.js` 把已核验的宿主文件接口接到采集器上：`pi.fs.list(dir)` 逐个目录枚举，`pi.fs.readText(path)` 读取内容。命令面板的 **Architecture: Collect Current State** 与 Agent 工具 `architecture_collect`（参数 `scopeRoots`、`maxFiles`）都走这条路径，默认扫描整个工作区。

- 不使用 `pi.fs.glob`：它在 500 条处静默截断且按 readdir 顺序返回，会同时破坏覆盖报告和确定性。改用 `fs.list` 自主遍历，目录与文件都按路径排序。
- 宿主 `fs.list` 单目录 1000 条静默截断、目录无法列出、超出深度/目录数上限，都会记为诊断并令 `coverage.complete` 为 `false`——受限的遍历始终显示为不完整，而不是显示成一个小项目。
- `fs.list` 返回的 `size` 用于在读取前拒绝超大文件（默认 2 MiB），避免 `fs.readText` 把大文件整个读入内存；被拒文件记为 `file_too_large`。
- 宿主错误文本不向上传递（可能含绝对路径），只返回固定的 `source_list_failed` 说明。
- 多根项目（`workspace.get().roots`）只有主根可达，其余根会记为覆盖缺口，不会静默缺失。
- `pi.workspace.get()` 描述窗口当前显示的文件夹，而 `pi.fs` 按调用会话所属项目解析（宿主 ADR 0016），两者可能不一致；因此工作区元数据只用于命名和缺口判断，是否真的有项目由遍历结果决定。

采集结果是只读的，不写入任何文件。由于 Agent 工具结果有宿主上限，返回值是带 `counts` 与 `truncated` 的有界摘要（含 `evidenceIds` 和 `evidence` 列表用于追溯），完整模型仅存在于内存中；持久化属于尚未实现的保存阶段。

## 只读模型查询、影响与比较

三个新工具读取工作区内已有模型文件，先执行 `validateModel`，再运行纯函数核心。采集器返回的有界摘要不是完整模型，不能冒充模型快照。合法演示文件为 `fixtures/valid-minimal-model.json`。

```json
{"path":"fixtures/valid-minimal-model.json","mode":"neighbours","targets":["container.api"],"direction":"both"}
```

以上用于 `architecture_query`。`mode` 支持 `filter`（默认）、`neighbours`、`paths`、`cycles`；路径查询用 `from` 和 `to`。过滤字段包括节点 `ids/types`、`statuses/confidences/minConfidence`、`evidenceTypes/evidencePath`，关系类型单独用 `relationTypes`。风险字段合同尚未冻结，`risk` 过滤明确拒绝，而不是静默忽略。

```json
{"path":"fixtures/valid-minimal-model.json","targets":["module.invoice"],"direction":"upstream","maxDepth":5,"maxNodes":500}
```

以上用于 `architecture_impact`。`targets` 接受稳定节点 ID 或模型证据文件路径；方向指模型中边的方向，`upstream` 是反向依赖。影响只表示模型关系可达性，不是运行时故障预测。

```json
{"beforePath":"architecture/snapshots/before.json","afterPath":"architecture/model.json"}
```

以上用于 `architecture_compare`。工具只读两份快照，不创建它们；同一稳定 ID 的名称变化可报告重命名，只有路径相似时至多给待确认候选。证据新鲜度只依据快照显式记录的指纹、revision 或 stale 信息，不读取源文件推断。`sourceContentVerified:false` 始终提醒这一边界。

- 不支持自动读取当前分支、工作树或 Git 变更集；公共 schema 不接受 `branch/changeSource`，缺少影响目标或比较快照则返回 `change_source_unavailable`。
- 宿主入口最大深度 32、最大节点预算 2000、最多 100 环、最多 100000 个候选边步骤（`maxSteps`）；路径搜索的节点预算也约束候选状态，可能在完成所有路径前停止。被截断的查询显式返回停止原因，不能解释为“没有更多关系”。
- 默认时钟固定为零以保证可重复；显式传 `maxTimeMs`（1–1000）时，宿主边界才注入真实时钟，时间截断结果不保证逐字节一致。
- 单模型在读取前限制 2 MiB；解码后仍限制 2 Mi 字符。结果上限为 240 KiB（低于宿主 256 KiB）。超大结果返回 `RESULT_TOO_LARGE`，不丢弃数据后伪称完整。应缩小查询或快照范围。
- P4 的查询、影响和比较工具已在真实宿主调用；注册、回滚和卸载也有本地模拟测试。新快照规划工具仍需完整插件重载后做真实调用验证，完整状态见 [宿主兼容性记录](./docs/host-compatibility.md)。

## P6 工作台、受限分析与内存导出

命令 **Architecture: Open Workbench** 打开 `renderer/index.html`。面板只经 `window.pluginBridge.invoke` 调用宿主 `workspace.get`、`fs.stat`、`fs.readText`，以及插件显式实现的固定 panel 通道：`architecture.query`、`architecture.impact`、`architecture.compare`、`architecture.exportPreview`、`architecture.health`。它不能访问任意 Electron IPC，也不会调用 Agent 工具注册表。

- 查询、影响和比较复用相同的读取前 2 MiB 限额、Manifest 参数校验和 240 KiB 响应预算。面板保留 `truncated`、停止原因、未解析目标、悬空引用、覆盖不完整、`sourceContentVerified:false`、证据 stale 与 freshness-unknown；它们永远不显示为完整、已验证或新鲜结论。
- 内存预览支持 Structurizr DSL、DOT、Mermaid、Draw.io XML、Markdown、JSON、SVG 和离线 HTML。每个预览带 schemaVersion、范围、revision、生成时间、覆盖状态、图例和限制；不下载、不保存、不写工作区。PNG 明确报告为受限：当前零依赖安全边界没有图形渲染栈，因此不生成或伪造 PNG 二进制。
- 比较要求用户输入两个明确的工作区相对路径；影响要求明确稳定节点 ID 或已声明证据路径。面板不会猜测 Git、分支、变更集或目标。

受控浏览器预览已在真实 `fixtures/valid-minimal-model.json` 上跑通模型读取、节点详情、待厘清项、邻居查询、上游影响、同文件比较、Mermaid 内存预览与健康检查，并实际展示覆盖不完整、证据缺失、新鲜度未知和传播停止原因。随后用户已在已安装 r6 的真实 PI-Desktop 面板中确认上述核心只读路径与 PNG 受限提示均正常。重复打开/关闭/宿主销毁、权限拒绝和超限返回形状未单独演练，仍保留为宿主兼容性验证范围。

## P7 架构健康检查

低风险 Agent 工具 `architecture_health` 接受 `{ "path": "architecture/model.json" }`，在安全读取并解析 JSON 后运行 v1 校验与确定性健康检查。对可解析但不合规的模型，它仍返回稳定的合同/冲突诊断（`ok:false`）；无效路径、读取失败、超限或损坏 JSON 则明确拒绝，且不会写入文件。

- 合同违规与模型内显式结构冲突直接复用 `validateModel` 的稳定诊断；不会再发明第二套结构规则。
- 对模型自身事实报告 `coverage.complete:false`、已声明 `unknowns`、节点/边没有任何 `evidenceIds`、以及 `low`/`unknown` 置信度。
- 输出总会同时声明 `sourceContentVerified:false`、`evidenceFreshness:"unknown"` 和 `artifactFreshness:"unknown"`。即使模型带 revision、fingerprint 或 stale 字段，健康检查也不会据此推断源码、证据或产物新鲜度。
- P7 的健康核心、低风险工具和面板通道均有 Node 内置回归；本地模拟与受控浏览器预览不等同真实 PI-Desktop panel 或 Agent E2E，状态见宿主兼容性记录。

真实宿主 Agent E2E 已调用公开工具 `plugin_local_architecture_visualization_architecture_health` 读取 `fixtures/valid-minimal-model.json`：返回 `ok:true`、5 个节点/3 条边/3 条证据的已校验摘要，以及 8 条明确范围内的健康发现；仍明确 `sourceContentVerified:false`、证据和产物新鲜度为 `unknown`。这验证了 P7 Agent 入口，不替代真实 panel E2E。

## P5 安全快照规划（不写入）

`architecture_snapshot_plan` 读取并校验已有模型后，返回规范化 JSON、SHA-256 指纹以及唯一可选路径：

```json
{"path":"fixtures/valid-minimal-model.json"}
```

成功计划的目标总是 `architecture/snapshots/<sha256>.json`；它**从不**选择 `architecture/model.json`、临时路径、可变索引或任意用户提供的输出路径。规划器不请求 `fs.write`，不创建目录、不写文件，也不读取当前时间或随机源；同一语义模型（包括无序集合）得到同一字节文本和指纹。

已核验的宿主 `pi.fs.writeText` 只是“建目录后直接覆盖”，没有 compare-and-swap、exclusive create、原子 rename 或事务发布。因此即使扩大写权限，先读后覆盖也无法安全解决并发修改、取消和半成品问题。当前插件明确不执行该不安全操作；待宿主提供安全发布原语后，才实现计划中的实际快照发布与 `architecture/model.json` 指针更新。

## 本轮验证

- `npm test`：223 通过，0 失败；脚本固定为 `node --test tests/*.test.js`（不要写成 `node --test tests`，本机 Node 会把目录当模块加载），也不把 `Temp/` 打包镜像误执行为测试。覆盖受控 `pluginBridge` 面板交互、固定通道白名单、内存导出边界、P7 无效模型诊断回归，以及 manifest 贡献合同（13 条技能显式 id 与唯一性、agent 扩展声明）和零依赖常驻规则的幂等性。
- `PluginCheck`：当前工作区无错误通过；不含 `.pi` 与 `Temp/` 的清洁镜像经同一官方校验为 70 个文件。两次检查均仅提示 `agent.prompt.inject`、`agent.tool.register` 需用户显式授予的高风险权限；注册表中这两项与 `agent.extension` 均已显式授予。
- `PluginPack`：已生成并审计 `dist/` 中的最终清洁交付包。因当前宿主打包器不排除 `.pi/` 或 `Temp/`，该包由不含会话目标文件与临时镜像的干净镜像经官方打包器生成；包内无 `.pi`、缓存、临时目录、凭据形文件、`node_modules`、网络权限或远程 CDN。分发版走“已安装插件”路径，没有 dev 插件的权限审查 UI，装机时权限清单需在安装流程中呈现。

## 设计原则
- 架构事实以 `architecture/model.json` 为准，图和报告是派生物。
- 每个重要节点、关系、风险和决策都要能追溯到代码、配置、文档、测试或运行证据。
- 当前状态、目标状态、运行观测、假设和未知项必须分开。
- 当前版本完全只读：不申请或调用 `fs.write`、`fs.delete`、网络、剪贴板或命令执行。
- 不把 Draw.io、SVG、PNG 或手工导出图作为事实来源。
