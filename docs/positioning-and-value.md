# 定位与价值

本文件回答三个问题：这个插件**是什么**、**怎么用**、**为谁解决什么问题**。第四部分是本轮三项缺口的改进方案与验证标准。

所有数字都是本轮实测值，不是估计。凡未经实机确认的，都写明"未确认"。

---

## 一、核心作用与定位

### 一句话

**它把"AI 说的架构"变成"能核对的架构"：每条结论都挂 `file:line` 出处和 `confirmed`/`inferred`/`assumed`/`unknown` 分级，查不到证据就明说不知道，不画成确认的框。**

这不是数据形状的描述，是三种常见工程动作的差别：问 AI"改这里会影响什么"，它给一个列表，但不告诉你哪条是猜的；问这个插件，列表里每条都带 `status`/`confidence`，你知道该重点 review 谁。接手陌生仓库时，AI 给一份"架构概述"；这个插件给一份**开篇是未知项**的清单，每条带责任角色和定案步骤。文档说支持 X、代码里三年前就消失了——以前没人能证明它不存在，现在每条边都能点到 `file:line`。

### 它解决的真实问题

架构知识的腐烂速度比代码快。口头描述、白板照片、三年前的 PPT、某人脑子里的映射——这些来源没有证据、没有修订号、没有失效信号。于是常见三类事故：

1. **重构前不知道会影响谁**：删一个"没人用"的模块，凌晨被叫起来。
2. **新人问"这个系统是什么"，得到的答案三个人三个版本**，且都无法核对。
3. **文档说支持 X，代码里那条路径三年前就静默消失了**，没人知道，因为没人能证明它不存在。

这个插件把这三件事变成可执行、可核对的：模型里的每个节点和每条边都挂 `evidenceIds`（指向 `file:line`），都带 `status`（confirmed/inferred/assumed/unknown）和 `confidence`。查不到证据的事实不会被画成确认的框。

### 它不是什么（边界比能力更重要）

| 不是 | 为什么 |
| --- | --- |
| 不是渲染器 | 宿主没有 Structurizr/Graphviz/Draw.io 渲染栈。`.dsl`/`.dot`/`.drawio` 是**文本产物**，要真图必须送外部工具。面板里的导出预览是内存只读文本，不保存、不下载 |
| 不是自动写入工具 | 不自动写任何东西。宿主 `pi.fs.writeText` 是直接覆盖，没有原子替换/CAS/排他创建，所以写入前重新确认目标状态、写入后复核字节数；`architecture_snapshot_plan` 仍然只做规划，不写文件 |
| 不是发现引擎 | `architecture_collect` 是**证据交叉核对**，不是系统枚举。动态 `import()`/`require()`、反射派发、调度表、写在外面的直接写者——它一个都找不到，并且会把找到的盲区报成 `unsupported_input` 诊断 |
| 不是 Git 工具 | 不读 Git、不推断分支、不判断新鲜度。`architecture_compare` 只比较两个模型文件，`evidenceFreshness` 恒为 `unknown` |
| 不是完整 C4 工具链 | 有层级切分，没有 C4 渲染。L4（Code）刻意不切，模块密度图归 `graphviz` |

### 什么时候不该用它

- 想知道"现在跑得怎么样"——它只读模型文件，不观测运行时。
- 想要一张能直接贴进 PPT 的图——用面板预览或送外部工具，本插件不产出位图（PNG 明确报告受限，不伪造二进制）。
- 系统几乎没有静态证据（纯配置驱动、纯脚本编排）——先用 `legacy-system-visualizer` 做未知项优先的清单，不要先建模。

---

## 二、使用方式与场景

### 三个入口

| 入口 | 怎么用 | 适合 |
| --- | --- | --- |
| **技能（对话）** | 直接描述问题，路由技能 `explore` 会选场景技能 | 绝大多数情况；不需要记住工具名 |
| **右侧工作面板 / 浮动面板** | 命令面板搜 `Architecture: Open Workbench`，或右侧工作面板点"架构可视化"标签页 | 边读边查；同一份 `renderer/index.html`，两种形态共用同一 preload。没有模型时点“采集并生成模型”即可当场得到可用模型 |
| **Agent 工具** | `architecture_validate` / `architecture_collect` / `architecture_query` / `architecture_impact` / `architecture_compare` / `architecture_snapshot_plan` / `architecture_health` | 脚本化、CI 里跑 |

面板只经 `window.pluginBridge.invoke` 访问 5 个固定通道，不碰任意 Electron IPC。

### 场景一："我们要动 `src/core`，会影响什么？"

```
工具：architecture_impact  { path, targets: ["component:core-model"], direction: "both", maxDepth: 8 }
```
**得到**：可达节点集、每条路径的关系类型、每条的 `status`/`confidence`、以及在哪一层被预算截断。
**得不到**：运行时故障预测。`architecture/views/blast-radius-module-core-model.dot` 的标题就写着"这是模型可达性，不是运行时故障预测"。
**注意**：影响分析只覆盖模型里有的边。动态依赖不在其中——这是已记录的采集器盲区，不是遗漏。

### 场景二："给新来的后端讲清楚这个插件由什么组成"

```
面板：导出预览 → 格式选 "C4 层级（Structurizr DSL）" → 层级选 L1/L2/L3
```
**得到**：按 `parentId` 链切出的三层——L1 系统上下文（焦点系统 + 使用者 + 外部依赖）、L2 容器（6 个可部署单元）、L3 组件（每个容器内的职责，本仓库共 7 个）。每个元素都带 `type/status/confidence · <模型 id>`，可逐一回溯。
**得不到**：渲染好的图。把 `.dsl` 送到外部 Structurizr 兼容工具。
**该换格式的时候**：想知道"什么 import 什么"→ `graphviz` 的模块关系图；想跟一条请求→ `flow-visualizer`。还没有模型时，面板顶部的“采集并生成模型”当场产出一份内存模型并载入阅读器，可直接查询与导出（只读、不落盘）。

### 场景三："这个模型还可信吗？"

```
工具：architecture_health  { path }
```
**得到**：模型自身的合同违规、覆盖声明、声明的 `unknowns`、无证据节点、低/未知置信度事实。本仓库模型当前 3 条发现、0 错误，全部是"仍未闭合的未知项"。
**得不到**：新鲜度。健康检查不读源文件，`sourceContentVerified` 恒为 `false`，`evidenceFreshness`/`artifactFreshness` 恒为 `unknown`——它不说模型是否过期，只说不验证。

### 场景四："接手一个没人懂的遗留系统"

```
技能：legacy-system-visualizer（证据稀疏、无文档、未知项比事实多时）
```
**得到**：`architecture/legacy-inventory.md`——**开篇就是未知项**，每条带责任角色和定案步骤；已观测事实每条带置信度和 `file:line`；然后才是风险聚类，最后才是改造切片（每条绑定能力/数据边界/风险/验证信号/回退边界五件事）。
**得不到**：改造建议先行。该技能明确禁止开篇提重写。
**本轮已在真正稀疏的 fixture 上复验**（见第四节 T3）。

### 场景五："我要一份能自己改的图"

```
技能：drawio（用户明确要 .drawio 时）
```
**得到**：`current-state.drawio`——每个节点/边一个 `mxCell`，id 保留为 `n:<nodeId>`/`e:<edgeId>`，可逐一回溯模型；**非 confirmed/high 的事实带三重标记**：标签后缀 ` [status · confidence]`、状态填充色（confirmed 蓝 / inferred 琥珀 / assumed 橙 / unknown 灰）、虚线轮廓，规则写在 XML 注释里。
**得不到**：实时编辑往返。没有"从 .drawio 读回模型"的代码路径，回写是人工的，且必须报告改了什么、模型改了什么、证据是什么。

### 场景六："这两个快照差什么？"

```
工具：architecture_compare  { beforePath, afterPath }
```
**得到**：按稳定身份比较的语义差异，以及证据新鲜度信号（哪些证据的 revision 对不上、哪些新鲜度未知）。
**得不到**：Git 推断。没有 change source 时返回 `change_source_unavailable`，不猜分支。

---
### 场景七："把这个仓库的架构固化成一份能进 Git 的模型"

```
面板：采集并生成模型 → 保存这份模型 → 确认目标状态 → 创建
```
**得到**：一次点击完成"扫描 → 生成 → 落盘 → 重新载入"。保存前面板先说明目标路径、该路径当前是否存在、以及新旧两边的节点/关系/证据数；目标已存在时只给"另存为快照"（`architecture/snapshots/<sha256>.json`，内容寻址、永不覆盖）和显式的"覆盖写入"，不会静默替换。写入标准路径后面板立即从磁盘重新载入，来源标记从"来自本次采集（未落盘）"变成"来自文件 …"——这份模型从此可以被 `architecture_query`/`architecture_impact`/`architecture_health` 按路径读取，也可以进 Git 让下次比较有基线。
**得不到**：自动写入。插件不监听文件变化、不定时重建、不覆盖你没让它覆盖的文件；宿主 `pi.fs.writeText` 没有原子 rename 和 CAS，所以写入范围被压在 `architecture/**`，并且写入后按预期字节数复核，不符就报 `WRITE_UNVERIFIED` 而不是宣称已保存。


## 三、为工程实践带来的实际提升

每条都写成"之前 → 之后"，可观察、可反驳。

### 1. 影响分析从"靠记忆"变成"靠可达性 + 置信度"

- **之前**：改公共模块前问三个人，得到三个答案，都无法核对；或者干脆不问。
- **之后**：`architecture_impact` 给出可达集与每条边的 `status`/`confidence`。inferred 的边标注为 inferred——你知道哪条结论是推出来的，哪条有证据。
- **可验证**：`architecture/views/blast-radius-module-core-model.dot` 记录了 `component:core-model` 的双向可达集与截断位置。

### 2. 隐性依赖从"静默丢失"变成"显式报告"

- **之前**：`pom.xml`/`build.gradle` 被采集器无声跳过，Maven 项目看起来像"没有基础设施"，没有任何提示。
- **之后**：infra 适配器匹配这两类文件并明确报 `unsupported_input`。同类地，`fixtures/legacy-sparse-project/` 上的实测显示：`require(routeVar)`、`require(expr)`、`config/jobs.yml` 各产生一条 `unsupported_input`；`config/app.properties` 与三个 ops 脚本被读取但既不建模也不报警——这最后一条是**仍未闭合的盲区**，已写进 `legacy-inventory-sparse.md`，没有伪装成覆盖。
- **可验证**：`tests/legacy-sparse-evidence.test.js` 第 4 条固定"采集器必须报出盲区而不是安静地产出空图"。

### 3. C4 从"只有一层能看"变成"三层可切"

- **之前**：导出器把所有节点拍平成 `softwareSystem`，`parentId` 链完全不表达；本仓库模型自己还把 7 个 `module` 直接挂 `system`，跳过 container/component 两层，于是 L2 只剩 3 个容器、L3/L4 根本切不出来。
- **之后**：新增 `c4` 格式按 `parentId` 深度切层，元素类型按节点类型映射，`status`/`confidence` 与模型 id 保留在每个元素上；模型重塑为 6 container + 7 component，L1/L2/L3 全部可切。
- **可验证**：`tests/export-preview.test.js` 固定三层切分、嵌套、类型映射、以及"模型没有该深度时拒绝而不是画空图"。

### 4. 可编辑交付物不再暗示超出模型的确定性

- **之前**：`.drawio` 只写 `name`，一个 `inferred/low` 的存储和一个 `confirmed/high` 的模块在图里长得一模一样。技能自己要求"visibly 标记低置信度"，实现做不到——两边都留着就是错的。
- **之后**：导出器带标记，技能规则改为"验证标记存活，不要手工加第二套"。
- **可验证**：回归测试断言 `unknown/unknown` 节点同时带后缀、灰填充、虚线；`confirmed/high` 节点三者皆无。

### 5. 文档数字不再各说各话

- **之前**：README 写 254、PLAN 写 251、host 记录写 223；模型 `sourceRevision` 落后 HEAD；"首个三平台 CI 结果未取得"在 CI 已全绿后还挂着。
- **之后**：用例数、文件数、版本号、CI 状态在各处一致，且由测试锁定（manifest 与 package 版本一致、打包范围恰好 40 文件）。
- **可验证**：`node --test tests/*.test.js` 303/303；`git grep` 搜不到过期数字。

### 6. 安全边界是声明出来的，不是猜的

- 只在面板显式点击时写入，且仅限 `manifest.fs.write.scope` 声明的 `architecture/**`；`fs.delete`、网络、命令执行一概不申请。
- 读取前 2 MiB 限制、响应 240 KiB 预算、逐列表上限——超限**报告**，不静默成功。
- `coverage.complete=false` 就是 `false`；`filesSkipped` 落进模型，只读模型的消费者能看出有文件被扣留。
- PNG 明确报告"需要渲染栈，不伪造二进制"。

---

## 四、可落地的改进方案与验证标准

三项缺口，每项给出：缺口陈述 → 方案 → 验证标准 → 本轮验证结果。

### T1 · C4 层级不可切

**缺口**：`src/core/export-preview.js` 的 `structurizr` 渲染器把所有节点拍平成 `softwareSystem`，`parentId` 链与 C4 层级完全不表达；同时本仓库模型把 7 个 `module` 直接挂 `system`，跳过 container/component，L2 只剩 3 个容器，L3/L4 切不出来。

**方案**
1. 新增导出格式 `c4`，接收 `{focus, level}`：按 `parentId` 深度过滤焦点子树，祖先作为边界框一起画出，焦点系统无直接边时 L1 只剩焦点框（这是模型欠建模的信号，不是渲染缺陷），模型没有该深度节点时以 `no_nodes_at_c4_level` 拒绝而不是输出空图。
2. 元素类型按节点类型映射（`system`→`softwareSystem`、`actor`→`person`、`container`→`container`、`component`/`module`→`component`、`datastore`→`container`、`external`→`externalSystem`），`status`/`confidence` 与模型 id 写进每个元素的描述。
3. `parentId` 已表达的包含关系不再画 `contains` 边——一个事实一个来源。
4. 重塑本仓库模型：7 个 `module`（实为源码目录，C4 语义上就是组件）改为 `component` 并挂到正确容器；新增 `container:skills-catalog`/`container:verification`/`container:documentation`；补 8 条容器级聚合边，让 L1/L2 有东西可画；`actor:agent` 是 LLM 不是人，改为 `external:agent`，否则 C4 `person` 会误导。
5. 重新生成 `c4-l1`/`c4-l2`，新增 `c4-l3-component`；`.dsl` 改为插件产出，人工判断移入 `c4-fit-notes.md`。

**验证标准**
- 三层都能切，且嵌套正确：L1 不含 container/component；L2 的 container 嵌在 system 内；L3 的 component 嵌在 container 内再嵌在 system 内。
- 每个元素都带 `type/status/confidence` 与模型 id，可逐一回溯。
- 模型该深度无节点时返回 `no_nodes_at_c4_level`，不返回空图。
- 坏 `level`/`focus` 返回 `invalid_option`。
- `architecture_validate` 通过、`architecture_health` 无新增错误。
- 所有 `.dot`/`.dsl` 只引用模型已声明的节点 id。

**本轮验证结果**：全部满足。`tests/export-preview.test.js` 用 4 个 test 固定上述行为；模型 validate 无诊断、health 3 findings / 0 errors；8 个视图文件的花括号与 id 引用全部一致。

### T2 · Draw.io 丢弃 status/confidence

**缺口**：`drawio(model)` 只写 `name`，`status`/`confidence` 没有任何出口，而 `skills/drawio/SKILL.md` 的质量规则要求"visibly 标记低置信度、假设与未知事实"。实现与规则冲突，两边都留着就是错的。

**方案**
1. 非 `confirmed`/`high` 的事实带三重标记：标签后缀 ` [status · confidence]`、状态填充色（confirmed 蓝 / inferred 琥珀 / assumed 橙 / unknown 灰）、虚线轮廓；`confirmed`/`high` 保持无标记，这样标记才有意义。
2. XML 注释里重述标记规则，读者不必猜颜色含义。
3. `limitations` 里如实说明：证据正文与 id-only 集合仍不在文件里。
4. **顺带修掉一个真缺陷**：预览预算 12000 字符对 20 节点/27 边的模型会截断 drawio 导出。截断后的 XML 是**被切断的文件**，不是"小一点的文件"。预算提高到 24000，并且截断时对 drawio 追加一条"不要把它当作交付物"的限制。
5. 技能规则从"你要标记"改为"导出器已标记，你的工作是验证标记存活，不要手工加第二套"。
6. 重新生成 `current-state.drawio`（20 节点 + 27 边单元，id 集合与模型完全一致）。

**验证标准**
- `unknown`/`inferred` 节点同时带后缀、对应填充色、虚线；`confirmed`/`high` 节点三者皆无。
- `n:`/`e:` 单元 id 集合与模型完全一致，边的 `source`/`target` 都能解析到已绘制节点。
- 文件里有标记规则注释。
- 截断时 `contentTruncated:true` 且 drawio 多一条"不可作交付物"的限制。
- 本仓库模型（20 节点/27 边）在**每种**格式下都完整导出，不截断。
- 重新生成的文件是 UTF-8 无 BOM、XML 标签闭合。

**本轮验证结果**：全部满足。回归测试覆盖标记、id 集合、截断行为、以及"真实模型下每种格式都必须完整导出"。

### T3 · legacy 场景是错配下验收的

**缺口**：`legacy-system-visualizer` 此前只在本插件仓库上跑过，而本仓库有 4 份文档 + 13 个技能，文档密度远高于典型遗留系统。那次验收没有检验该技能的核心行为（未知项优先、稀疏证据、采集器盲区）。

**方案**
1. 建一个**真正稀疏**的夹具 `fixtures/legacy-sparse-project/`（11 个文件）：无 README/docs/tests/CI/LICENSE/CODEOWNERS，`package.json` 无 `scripts`，字符串键 handlers 表做运行时派发，`require(routeVar)`/`require(expr)` 动态依赖，硬编码上游主机，`process.env` 选路由，`config/jobs.yml` 有任务无 owner，三个 ops 脚本。
2. 手工建 `fixtures/legacy-sparse-model.json`：8 节点里 5 个 `unknown`/`assumed` 且无证据，已确认只有 3 个——**未知多于事实**，这是遗留场景的定义性属性。
3. 按技能流程实际产出 `architecture/legacy-inventory-sparse.md`：开篇即未知项（每条带责任角色与定案步骤），然后才是已观测事实（每条带置信度与 `file:line`）、采集器在该夹具上的具体盲区、风险聚类、最后的改造切片。
4. 用 `tests/legacy-sparse-evidence.test.js` 固定行为：模型合法且 ≥4 条 unknown；unknown+assumed 节点数 > confirmed 节点数；`healthCheck` 报出每条 unknown 且 `sourceContentVerified:false`；`collectModel` 必须报出盲区而非安静地产出空图；稀疏不等于无证据（每个 confirmed 节点仍有 evidence）。
5. 更新 `legacy-inventory.md`：记录错配已由这次稀疏复验闭合，而不是删掉原结论。

**验证标准**
- 夹具确实无文档、无测试、无 owner 记录（可列举验证）。
- 未知+假设节点数严格大于已确认节点数。
- 清单开篇是未知项，不含开篇改造提案。
- 采集器在该夹具上返回的 diagnostic code 集合被实际记录（不是猜的）。
- 5 条回归测试全绿。

**本轮验证结果**：全部满足。实测 `collectModel` 在该夹具上返回 3 条 `unsupported_input`（`config/jobs.yml`、`src/index.js:17`、`src/legacy/orders.cjs:4`），`diagnostics` 为空，8 节点/3 边；`orders→store` 这条关键隐藏依赖确实抓不到，已写进清单。

---

## 五、仍未闭合（记录在案，未伪装）

| 缺口 | 性质 | 状态 |
| --- | --- | --- |
| 停靠视图生命周期细节（重复打开/关闭后的残留注册与重复面板） | 宿主无 `openView` API，只能由用户点开 | 授权、重载、打开、读取/查询/影响均已由用户确认（2026-09-23） |
| 1.2.0 `.piplug` 安装回归 | A10 是针对 0.1.0 做的；1.0.0/1.1.0 的包也未重做 | 新包需重做安装→启用→升级→禁用→卸载 |
| A4 命令注销 | 只有单测覆盖 | 未在真实宿主确认卸载后命令消失 |
| 采集器读取但不建模的文件类型（`.properties`/`.sh`/`.py`）静默无诊断 | 已记录，未扩适配器 | 写进 `legacy-inventory-sparse.md`；不凭空实现解析器 |
| Java/Maven/Gradle 依赖采集 | 只保证不静默忽略 | 明确报 `unsupported_input`，不产出节点或边 |
| 实际保存/发布 | 宿主缺原子发布原语 | **1.4.0 已按用户授权 A 落地**：`architecture.save` 面板通道在 `architecture/**` 内写入，写入前展示目标状态、写入后复核字节数；仍不覆盖已有文件，除非用户显式点"覆盖写入" |
| L4 Code 层 | 刻意不切 | 模块密度归 `graphviz` |
