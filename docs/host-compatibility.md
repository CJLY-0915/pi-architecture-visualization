# PI-Desktop 宿主兼容性记录

本文件记录架构可视化插件在开始核心实现前，对 PI-Desktop 插件合同的核验结果。规格文档描述的是目标能力；只有经过当前宿主或 `PluginCheck` 明确验证的项目，才能在插件中作为已实现能力使用。

## 核验基线

- 插件目录：`E:\Program\pi-desktop-plugin\architecture-visualization`
- 插件 ID：`local.architecture-visualization`
- 当前插件版本：`1.4.0`（`fs.write` 与 `clipboard.write` 为 1.4.0 新增，等用户在插件页授予后才是生效权限）
- 核验工具：PI-Desktop `PluginCheck`；宿主实现核验来源 `D:\Program Files\PI-Desktop\resources\app.asar`
- 宿主版本：PI-Desktop **0.15.4**（`D:\\Program Files\\PI-Desktop\\resources\\app.asar` 内 `package.json`，用 asar 头偏移读取）；`engines.piDesktop` 已由虚假的 `>=0.1.0` 修正为 `>=0.15.4`
- 生效形态：开发源即生效源，已通过插件页"加载本地插件"注册为 dev 插件（注册表 `source=dev`、`permissions` 含 `agent.extension`、`capabilities` 含 `agentExtension`，且只有一条条目）。原安装态副本 `C:\\Users\\DIY\\.pi-desktop\\plugins\\installed\\local.architecture-visualization` 已无注册表条目，经用户同意后删除，dev 源是唯一生效源。
- 分发镜像：**运行时集合，共 41 文件** —— `main.js`、`manifest.json`、`package.json`、`src/`、`extensions/`、`renderer/`、`skills/`。该集合由 `tests/package-scope.test.js` 断言（manifest 声明路径齐全、全部 `require()` 目标可解析、开发资产被排除）。1.4.0 新增 `src/host/save-model.js`，集合由 40 变为 41；此前干净镜像实测（只复制这 7 个根）`PluginCheck` 报告 `40 file(s) would be packaged`、无错误，新集合需重跑一次干净镜像确认。`tests/`、`fixtures/`、`docs/`、`.github/`、`README.md`、`PLAN.md` 只进仓库不进包；`architecture/`（本仓库自身的架构模型）、`Temp/`、`dist/`、`.pi/` 只留在本地。宿主打包器**不读取 `.gitignore`**，因此打包范围靠上述门禁与干净镜像保证，不靠 git 忽略规则。
- 版本控制：开发源是 Git 仓库（`main` 分支）；`architecture/`、`Temp/`、`dist/`、`.pi/`、`node_modules/`、系统与编辑器垃圾均在 `.gitignore` 中，不被跟踪。
- 版本控制 remote：**已建立**——`https://github.com/CJLY-0915/pi-architecture-visualization.git`（`origin`，`main` 分支）。`.github/workflows/ci.yml` 的三平台 `node --test tests/*.test.js` **已全绿**：commit `bb03244` 的 run 中 `node --test (macos-latest)` 9s、`(ubuntu-latest)` 5s、`(windows-latest)` 18s 全部 Success，总时长 21s。证据是用户在 GitHub Actions 页面提供的运行截图（本机读不到：GitHub API 未认证返回 403），因此这一条的证据性质是用户证言而非本地日志摘录。
- 宿主生命周期与场景技能验收状态以 [host-acceptance.md](./host-acceptance.md) 为唯一实时来源：A 组 15 项中 A1–A3 附日志证据、A4 仅单测覆盖、A7–A13 为用户确认——**A13 已由用户确认**：`ui.view` 授权已生效（注册表 `permissions` 含 `ui.view`、`capabilities` 含 `views`；`plugin.log` 中 `plugin.uninstalled` → `skills.register count=13` → `load.success` → `reload.success`，无 `PERMISSION_DENIED`），且右侧停靠视图已打开，读取模型、查询与影响分析均正常（2026-09-23，用户证言）；只剩重复打开/关闭后的残留注册与重复面板未单独检查（模型记 `unknown:docked-view-lifecycle-residue`）。宿主没有供插件自行打开视图的 API，因此打开视图这一步只能由用户在工作面板点开。B 组 13 个技能已全部实际执行一次。三平台 CI 已全绿（见上一条）。

## 已核验合同

| 能力 | 当前状态 | 依据 |
| --- | --- | --- |
| `manifest.json` 基本结构 | 已通过 | `PluginCheck` |
| `main.js` 入口文件 | 已通过 | `PluginCheck` |
| `renderer/index.html` 面板入口 | 已通过目录与安装规则检查、受控 fixture bridge 全流程演练；用户已在真实面板确认核心只读操作 | `PluginCheck`；本地浏览器预览；用户面板 E2E；`tests/panel-interactions.test.js` |
| 13 个技能文件路径 | 已通过 | `PluginCheck` |
| 命令贡献声明 | 已通过 | `PluginCheck` |
| `architecture_validate` / `architecture_collect` 工具声明 | 已通过，前两者曾在真实宿主调用 | `PluginCheck`；既有宿主调用 |
| `architecture_query` / `architecture_impact` / `architecture_compare` 工具声明、注册与回滚 | 已在真实宿主调用；panel 调用仅经静态协议核验与本地模拟 | 真实既有工具调用；`tests/analysis-tools.test.js`、`tests/host-adapter.test.js`；`app.asar` `onPanelInvoke` 协议 |
| `architecture_snapshot_plan` 无副作用快照规划 | 已在真实宿主调用；该工具本身零写入 | 对 `fixtures/valid-minimal-model.json` 返回 SHA-256 内容地址路径；调用方确认无写入。1.4.0 起插件另有 `fs.write` 权限，但只服务面板 `architecture.save`，本工具不写文件 |
| `architecture_health` 模型健康工具 | 低风险声明、模拟宿主执行、可解析无效模型诊断与 panel 白名单/交互测试通过；**已在真实 Agent 调用**；浮动面板健康通道已由用户确认（A6），停靠视图内未单独跑健康检查 | 真实 `plugin_local_architecture_visualization_architecture_health` 对最小模型返回 8 条受限发现；`manifest.json`；`src/host/health-tool.js`；`tests/health.test.js`、`tests/host-adapter.test.js`、`tests/panel-interactions.test.js` |
| `pi.workspace.get()` 返回 `{path, name}` | 已在真实宿主验证 | 宿主调用；`app.asar` 中 `pluginWorkspaceInfo` |
| `pi.fs.list(pathFromRoot)`（`{name, path, isDirectory, size, mtimeMs}[]`，单目录 1000 条上限） | 已在真实宿主验证 | 宿主 `architecture_collect` 实际调用；`app.asar` broker |
| `pi.fs.readText(pathFromRoot)` | 已在真实宿主验证 | `architecture_validate` 与采集均实际调用 |
| `pi.fs.stat(pathFromRoot)` → `{size, mtimeMs}`（仅文件） | 已核验并用于模型读取前大小拒绝；真实新工具调用待验证 | `app.asar` broker；`src/host/read-model.js` |
| `pi.fs.glob(pattern)`（500 条上限，readdir 顺序） | 已核验但不采用 | `app.asar` broker（`MAX_GLOB_MATCHES`） |
| `ui.panel` 面板权限 | 已声明 | `manifest.json` |
| `ui.view` 视图权限与 `contributes.views` | 已声明、已过 `PluginCheck`（40 文件、无错误），**用户已在插件页授权并重载生效**；停靠视图标签页已由用户在真实宿主打开，读取模型、查询与影响分析均正常（2026-09-23，A13 核心路径 ✅；未单独检查：重复打开/关闭后的残留注册与重复面板） | `manifest.json`；宿主 `PLUGIN_PERMISSIONS` 含 `ui.view` 且不在高风险列表；注册表 `permissions` 含 `ui.view`、`capabilities` 含 `views`；`pluginViews` 处理器要求 `ui.view` + `pluginActiveInProject` + entry 存在于插件目录内；视图 id 必须匹配 `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`、icon 必须取自宿主 25 个图标名（`PluginCheck` 以 dotted id 实测拦截过一次） |
| 只读模型浏览、采集生成模型、查询/影响/比较、内存导出与健康展示 | 受控 fixture bridge、用户真实浮动面板与右侧停靠视图（读取/查询/影响）均已确认核心成功路径，Node 交互模拟与白名单测试通过；生命周期/拒绝/超限仍待逐项验证；`architecture.collect` 面板通道为本轮新增，待宿主确认 | `renderer/index.html`；`tests/panel-interactions.test.js`、`tests/host-adapter.test.js`；用户面板 E2E |
| `agent.prompt.inject` 技能权限 | 已声明 | `manifest.json` |
| `agent.tool.register` 工具权限 | 已声明 | `manifest.json` |
| `agent.extension` 权限与 `contributes.agentExtensions` | 已在真实宿主注册并随 dev 热重载重注册 | `manifest.json`；注册表 `permissions`/`capabilities`；`logs/app/plugin.log` 中 `plugin.reload.success`、无 `plugin.agentExtensions.skipped` |
| `before_agent_start` 常驻路由规则 | 宿主合同已核验；规则文本与幂等性由单测覆盖，尚未从日志侧直接观测提示文本 | `app.asar` `registerAgentExtensions`（无权限即审计 `PERMISSION_DENIED` 后 return；`realpathSync` 作 id）；`sidecar.js` `loadExtensionModule`（jiti 取默认导出，非函数即报 `Extension does not export a valid factory function`）、`TRUSTED_EXTENSION_EVENT_CAPABILITIES.before_agent_start = "result"`、handler 合并 `(acc,next)=>({...acc ?? {}, ...next})`；`extensions/workflow-rule.mjs`；`tests/agent-extension.test.js` |
| 技能 ID 派生规则 | 已核验并修正 | `app.asar` `skillIdFromPath` 只取文件基名；13 个 `SKILL.md` 曾得到同一 id `local.architecture-visualization/skill`，仅首个注册、其余 12 条审计 `DUPLICATE`。改为显式 `id` 后 `logs/app/plugin.log` 记录 `plugin.skills.register count=13`；回归见 `tests/manifest-contract.test.js` |
| `pi.fs.writeText(pathFromRoot, content)` | 已核验并**采用**，仅经面板 `architecture.save` 通道 | `app.asar` broker：`resolveFsRequest(..., "write", {create:true})`、递归建目录、`writeFileSync` 直接覆盖；无 exclusive-create、CAS、原子 rename 或事务 API——因此 `src/host/save-model.js` 在写入前重新确认目标状态、写入后按预期字节数复核，不把结果谎报成已保存 |
| `fs.write` 架构目录写入范围 | **已申请（1.4.0，用户授权 A）**：`manifest.fs.write = {root:"workspace", scope:["architecture/**"]}`，只服务面板 `architecture.save` 通道；宿主 `scopePatternError` 拒绝覆盖整个 root 的写范围，`architecture/**` 合法 | `manifest.json`；宿主 `PLUGIN_FS_MODES=["read","write","delete"]`、`resolveFsRequest` 中 `isFsPathInScope` 命中即直接写、未命中走 `requestFsConsent` 弹窗；`src/host/save-model.js`；`tests/save-model.test.js`、`tests/analysis-tools.test.js` |
| `clipboard.write` 剪贴板写入权限 | **已申请（1.4.0）**：宿主 `clipboard.writeText` 会 `assertPermission(loaded,"clipboard.write")`，1.3.0 的"复制到剪贴板"此前未声明该权限，在真实宿主会被拒 | `app.asar` `out/main/index.js:101097-101098`；`tests/registration-contract.test.js` 的 bridge 通道→权限映射守卫 |

## 规模与响应预算实测

用 679 个文件、3.1 MB 的合成仓库（`.cache/bigrepo`，仅本地、不入库）对 `architecture_collect` 的同一条路径做三次运行。`generatedAt` 固定为常量，`summarize` 与预算常量直接从 `main.js` 切片取出后调用，因此被测代码就是发布代码本身。

- **确定性**：默认 `maxFiles`（500）连跑两次，整个模型 JSON 的 SHA-256 逐字节相同（`d14806c4…`）。候选文件按路径升序处理，宿主 `fs.list` 的 readdir 顺序到不了模型里。
- **默认 `maxFiles=500`**：679 个列出文件读出 499 个，1 条 `file_limit_reached`，`js-ts` 适配器 `limited:true`，`coverage.complete=false`；模型 505 节点 / 1342 边 / 1846 条证据。
- **`maxFiles=5000`**：读出 677 个，`coverage.complete=true`；模型 683 节点 / 1806 边 / 2486 条证据。说明 `complete` 由实际触发的上限决定，不是写死的值。
- **受控失败可见**：3 MB 的 `big.dat` 在读取前被 2 MiB 预读限制拒绝，记为 `file_too_large` 并计入 `filesSkipped`；两次运行的 `filesSkipped` 分别为 180 与 2。
- **响应预算**：三次运行摘要为 101958–102468 字节，低于 240 KiB 上限，所以字节裁剪循环并未被触发——真正兜底的是 150 节点 / 300 边 / 100 条证据的逐列表上限，省略量由 `truncated` 与 `truncatedNote` 报告。该循环本身改由 `tests/response-budget.test.js` 直接覆盖，包括"单条目比整个预算还大时必须终止且不丢 `coverage`/`ok`"。
- **实测中发现的缺陷（已修）**：模型原先只落 `filesScanned` 与 `complete`，`filesListed`/`filesSkipped` 只存在于返回值。于是"列出 679 个、只读出 677 个"在落盘后彻底消失，只读模型文件的消费者无法区分完整扫描与部分扫描。现在 `emptyModel` 写入完整账本，`schemas/architecture-model.schema.json` 把三个计数都列为可选属性（`required` 保持 `['filesScanned','complete']` 不变，旧模型仍然有效）。
- **仍存在的语义边界（记录在案，非缺陷）**：单个文件读失败或超 `maxFileChars` 不把整次扫描判为不完整，只记诊断并计入 `filesSkipped`；`complete` 表达的是"遍历跑到了头"，扣留规模必须看 `filesSkipped`。README 与 schema 的 `complete` 描述都已写明这一点。

## 尚需在实际宿主验证

逐条操作、预期结果与证据行见 [host-acceptance.md](./host-acceptance.md)：A 组宿主生命周期现为 14 项，其中 A1–A3 附日志证据、A4 仅单测覆盖、A7–A13 为用户确认、**A13（右侧停靠视图）已由用户确认——`ui.view` 授权、插件重载、标签页打开与读取/查询/影响均正常**；B 组 13 个场景技能已全部问过一次并落盘首产物。以下项目是**仍然不能仅凭目录检查视为已实现**的残余面（编号与 `host-acceptance.md` 的 A 组对应）：

1. ~~插件能在当前 PI-Desktop 版本中加载、启用、禁用和卸载。~~ → **已确认**（A9，用户本轮确认；证据性质见 `host-acceptance.md` 表下注）。
2. `onLoad` / `onUnload` 的命令注册和注销行为，以及异常时的清理行为。→ **仍开放**，仅有 `tests/registration-contract.test.js` 单测覆盖（A4 🧪）；卸载后命令是否真的从面板消失未实机确认。
3. `pi.fs.list` / `readText` 已在真实宿主调用通过；**仍开放**的是权限拒绝、会话切换与越界读写的逐项验证。
4. ~~`pi.ui.openPanel` 的重复打开、关闭和宿主销毁~~ → **已确认**（A7）。**仍开放**：面板 `window.pluginBridge.invoke(...)` 的权限拒绝与超限状态（用户已确认五个固定 `architecture.*` 分析通道的核心成功路径；`architecture.collect` 与 `architecture.save` 面板通道待宿主确认，后者还依赖用户对 `fs.write` 的授权生效）。
5. `window.pluginBridge.invoke('ui.showToast', ...)` 的实际桥接行为。→ **仍开放**。
6. ~~Agent 工具在 Agent 模式中的超时与 Plan 模式拒绝行为~~ → **已确认**（A12）。**仍开放**：工具被禁用时的行为；既有 query/impact/compare 的最终 Manifest schema 在完整插件重载后复核。
7. ~~技能目录与正文按需加载~~ → **已确认**：13 个技能注册（`count=13`），且本轮 13 个场景技能逐一实际执行并落盘首产物（见 `host-acceptance.md` B 组）。
8. ~~`pi.fs` 的符号链接 containment~~ → **已确认**（A11，用户本轮确认）。宿主 broker 的 `.git`/`node_modules`/`.venv`/`__pycache__` 跳过与凭据路径屏蔽为代码核验结论，本插件未独立复测重解析点逃逸。
9. `manifest.i18n`、设置页、明暗主题和面板拖拽带在当前宿主中的呈现。→ **仍开放**。
10. 开发目录热重载已验证（改 `manifest.json` 后宿主自动 `plugin.unload` → `plugin.load.success` → `plugin.reload.success`）。权限扩大时的重新审核**已实机触发并确认**：新增 `ui.view` 后 `reloadDevPlugin` 连续抛 `PERMISSION_DENIED: manifest now requests ui.view; reload it from the Plugins page to review`（`plugin.log`，`app.asar` `out/main/index.js:96142-96146`），用户从插件页重载后注册表 `permissions` 纳入 `ui.view`、`capabilities` 纳入 `views`，`plugin.log` 出现 `plugin.uninstalled` → `skills.register count=13` → `load.success` → `reload.success`。
11. ~~`PluginPack` 生成的 `.piplug` 安装、禁用、升级和卸载回归~~ → **已确认**（A10，用户本轮确认）。
12. 宿主停靠视图机制（`contributes.views`）→ **代码已核验，实机核心路径已确认**：`pluginViews` 处理器要求 `ui.view` + `pluginActiveInProject` + entry 存在于插件目录内；宿主用 `WebContentsView` 挂到主窗口 contentView（不是独立 BrowserWindow），视图与面板共用同一 preload；`MAX_LIVE_VIEWS = 4` 且 LRU 淘汰。`ui.view` 授权已由注册表与 `plugin.log` 确认生效。**已由用户确认**（2026-09-23）：右侧工作面板里的"架构可视化"标签页已在真实宿主打开，读取模型、查询与影响分析均正常。**仍开放**：重复打开/关闭后的残留注册与重复面板未单独检查。
13. 插件**无法自行打开**停靠视图：`pi.ui` 只有 `openPanel`/`closePanel`/`showToast`（`app.asar` `out/main/index.js:95010-95012`），panel bridge 的 channel switch 没有 `view/open` 分支，未识别通道只会落到插件自己的 `onPanelInvoke`（`out/main/index.js:96328-96337`）。因此"用命令在右侧面板显示架构"这个语义宿主做不到，命令保留为浮动面板入口。

## 当前检查警告

`PluginCheck` 当前报告两类提醒，都不是错误：

- `agent.prompt.inject` 和 `agent.tool.register` 属于高风险权限，安装启用时需显式授予。注册表已记录用户对这两项以及 `agent.extension` 的显式授予；`PluginCheck` 的提醒针对的是打包分发路径（已安装插件没有 dev 插件的权限审查 UI），装机时必须在安装流程中呈现权限清单。`fs.write` 同属宿主高风险权限（`HIGH_RISK_PERMISSIONS`），1.4.0 新增后同样需要用户在插件页重新授予，热重载不会自动带上。
- 打包器会剔除凭据形文件并给出 `package.secret-skipped` 提醒：`.env*` 与私钥类文件不会进入 `.piplug`。因此仓库内不提交凭据形 fixture，敏感路径跳过改由内存测试覆盖。

**已修正的宿主陷阱**：`contributes.skills` 只写路径时，宿主用 `skillIdFromPath` 取文件基名派生 id。本插件 13 个技能都叫 `SKILL.md`，于是共享同一个 id，只有首个注册成功，其余被审计为 `DUPLICATE` 静默跳过——即技能目录看似声明完整，实际只有 1/13 到达模型。现在每条声明都带显式 `id`（取所在目录名），并有 `tests/manifest-contract.test.js` 守护：显式 id 必须存在、唯一、等于目录名，并复现宿主派生规则会撞号这一事实。宿主自身的“导入扩展”脚手架也用哈希 id 规避同一问题（`app.asar` `out/main/index.js` 56613–56617）。

入口通过共享的只读 `readModel` 适配器使用 `pi.fs.stat`（读取前 2 MiB 限制）和 `pi.fs.readText`；唯一的写入走独立的 `writeHost()` 适配器（`pi.fs.stat`/`readText`/`writeText`），只被面板 `architecture.save` 通道调用。健康入口对已解析但无效的 JSON（包括 `null`）保留验证诊断，其他分析仍严格拒绝无效模型。Node 内置测试覆盖模型校验、模拟宿主入口、只读采集器、查询/环路/影响预算、比较合同、分析工具、面板白名单/交互与内存导出、健康检查、快照规划的路径、参数、读取前大小、响应上限与生命周期回滚，保存模块的目标状态判定、三种决策、幂等内容寻址快照、拒绝路径与写入后大小复核，manifest 贡献合同（技能显式 id、agent 扩展声明）、注册面与 manifest 的双向一致（命令/工具/激活事件/面板白名单）、面板宿主桥通道到权限的映射、技能描述长度与路由表完整性、零依赖常驻规则的幂等性、采集响应预算（逐列表上限、240 KiB 字节上限、单条目超预算时终止）与 coverage 账本落盘；`npm test` 显式运行 `tests/*.test.js`（不能用 `node --test tests`，本机 Node 会把目录当模块加载），本轮为 303/303。`.github/workflows/ci.yml` 在三平台跑同一命令，commit `bb03244` 的 run 已三平台全绿。它们不替代上文已记录的真实宿主工具调用，也不能覆盖其余宿主生命周期场景。

## 下一步核验顺序

1. 在实际 PI-Desktop 中加载开发插件，记录宿主版本和加载结果。
2. 验证命令、面板、技能和工具的最小闭环。
3. 根据实际桥接结果冻结 `docs/host-compatibility.md` 的已支持 API 清单。
4. 模型 schema 和内部工具 `architecture_validate` 已实现；在实际宿主核验读取、权限和工具调用，确认公开工具名的 `plugin_` 前缀不被插件代码重复添加。
5. 已生成 1.1.0 的 `.piplug`；A10 的安装回归是针对 0.1.0 做的，1.0.0/1.1.0/1.2.0/1.3.x 新包需在干净环境重做安装→启用→升级→禁用→卸载，之后才可将分发包视为宿主 E2E 通过。
