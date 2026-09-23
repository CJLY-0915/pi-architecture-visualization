# decision:no-safe-publish-primitive

- 状态：已接受（阻塞 P5 实际保存）
- 记录时间：2026-09-23T16:04:14+08:00
- 关联模型：`architecture/model.json` 的 `decisions[0]`

命名约定：模型里的 decision id 形如 `decision:<slug>`；伴生文档为 `architecture/decisions/<slug>.md`，即去掉 `decision:` 前缀——冒号不是可移植文件名字符。该约定应作为 S4 集合字段合同的一部分冻结并机器校验。

## 上下文

P5 要求把派生交付物写入目标项目的 `architecture/`，并在并发修改、取消、权限撤回下不产生半成品（`PLAN.md:352-371`）。插件当前只实现"无副作用安全快照规划"（`PLAN.md:373`），不申请 `fs.write`。

## 已核实的宿主事实

`pi.fs.writeText(pathFromRoot, content)` 的实现是"递归建目录后 `writeFileSync` 直接覆盖"（宿主 `app.asar` broker，`resolveFsRequest(..., "write", {create:true})`）。没有 exclusive create、内容条件写入（CAS）、原子 rename、事务发布，也没有可传递的取消令牌。

## 选项

| 选项 | 后果 |
| --- | --- |
| A. 等宿主提供原子发布原语 | 保存功能继续缺失；插件价值停留在"只读分析" |
| B. 先读旧指纹再覆盖 | 读与写之间存在竞态；并发保存可丢失一份模型；失败时留下可被误认有效的半成品。等于用"先检查后覆盖"伪装并发安全 |
| C. 自建内容寻址发布：快照写 `architecture/snapshots/<sha256>.json`（永不覆盖已存在内容，天然幂等），指针/索引只追加不覆盖 | 快照部分无需 CAS 即安全；指针更新仍是唯一竞态点，需要额外约定（例如指针文件也内容寻址 + 读取方选最新，或接受"最后一次追加获胜"并在文档中声明） |

## 选择

**A + C 的组合，B 明确拒绝。** 快照的写入走内容寻址（C 的安全子集），立即可获得"可保存、可回读、可比较"的能力；指针级发布在宿主提供原语前不实现，也不以 B 冒充。

## 被拒绝的备选

B：在任何竞态窗口下都会静默丢数据或留半成品，与插件"不伪装完整/安全"的核心原则冲突。

## 后果

- `architecture_snapshot_plan` 继续只规划不写入；由调用方（agent 或人）执行写入。
- 模型 `decisions` 中保留本 id，`PLAN.md:425` 的跨阶段不变量继续成立。
- 若采用 C 的快照写入，需要新增 `fs.write` 权限并限制 scope 到 `architecture/snapshots/**`，这属于权限扩大，必须回插件页重新审查，热重载不会自动带上。

## 可逆性

高。未写入任何用户数据；若宿主后续提供原语，可在不改模型 id 的前提下替换发布实现。
