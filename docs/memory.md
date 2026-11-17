# 项目记忆：存储、调用与维护

Pantheon 管理记忆的生效状态，agent 提交分析候选，改进闭环的状态机管理经验是否可用。无需外部记忆服务、向量数据库或新增 npm 依赖。

## 数据放在哪里

沿用 daemon 的应用数据目录，而不是在每个项目工作树里另建一套可写 memory 文件：

```text
<daemon data directory>/
  control.sqlite
    memory_records   # 每条正文版本的身份、作用域、来源与生命周期
    memory_states    # 项目的显式记忆变更 epoch
    memory_jobs      # 增量文档任务、租约、重试和发布版本
    memory_search    # SQLite FTS5 索引；不是权威来源
  artifacts/<sha256> # 不可变 UTF-8 正文和生成的进度文档
```

默认应用数据目录为 `~/Library/Application Support/Pantheon/`，测试使用隔离的数据目录。正文内容寻址，写临时文件、fsync、原子 rename，再在数据库事务里引用其 hash。事务失败留下的孤儿文件由已有恢复/回收机制处理；历史版本引用的正文保留。

项目目录中的源码、既有用户决定文档仍是原有信息的来源。Pantheon 不复制历史正文到工作树，不生成第二份可写的 AGENTS.md/MEMORY.md。普通项目 `rg` 不会碰到应用数据目录里的归档。

后台维护每分钟把以下文件同步成当前 note，标签 `imported`，作者 `pantheon:import`:

| 来源 | key | authority |
|---|---|---|
| 每个项目根目录的 `CLAUDE.md`、`AGENTS.md` | `import:root<i>/<文件名>` | user |
| `~/.claude/projects/<根目录路径，非字母数字换成 ->/memory/*.md`(不含 `MEMORY.md` 索引) | `import:root<i>/claude-memory/<文件名>` | agent_reported |
| Pantheon 自管 native 状态里 `native-sessions/<项目 ID>/claude/projects/*/memory/*.md` | `import:sessions/<目录名 hash 前 8 位>/<文件名>` | agent_reported |

文件 frontmatter 的 `name` 作标题，`description` 作摘要。文件内容变化时生成新版本替代旧版本；文件删除时归档。用户归档的导入条目在文件内容不变时不再导入。导入的是 note，不进入决定预算，也不会被提升为当前规则。

## 生命周期与权威

- 会话里的 agent 用 `memory.propose` 提交的 report、note 立即生效，authority 保持 `agent_reported`，同 key 的旧版本被替代。agent 提交的 decision 和用户在界面新建的条目创建 `draft`，默认读取永不包含草稿。
- 用户 `memory.commit` 显式审阅后生效。同一项目、同一任务 generation、同一 key 被替代的修订在同一事务内归档。每次新正文都有新的 ID；被替代修订的 ID 永远不指向新正文。
- 决定的 `authority=user` 来自真实用户提交/确认，不能由 agent 输入字段伪造。报告由 agent 提交时即使经用户确认，仍保留 `agent_reported`；“当前报告”不是“已验证事实”。
- `memory.archive` 撤回；替代、过期、任务 generation 变化、依赖失效也会归档。普通 `get/search/related/context/project.read` 不返回已失效内容；带历史筛选的 search/related 仅允许用户凭据。
- `memory.restore` 只生成新草稿，保留 `restored_from`。再次确认才可能取代现有版本，不自动恢复被撤回的规则。恢复保留原依赖；若依赖已失效，须重新评估并提交新提案，不能通过恢复绕过证据门禁。
- 用户决定不按年龄、访问量衰减。显式 `expires_at` 才按时间失效；读取当场检查，不依赖后台定时器醒来。
- 任务记忆只能在其任务 generation 内读取。任务完成、被删除或 generation 改变即失效。任务例外不会替代项目级规则；冲突需要对照作用域解释。

报告默认依赖生成时的项目来源签名；任务、brief、改进闭环或当前决定变化后保守失效。`dependencies` 指向不可变记忆版本，失效沿依赖传播。普通 note 不随无关任务进度失效，但显式依赖、任务作用域、有效期依然约束它。

来源签名包括显式 epoch、当前有效版本、任务合同/完成状态、brief 和改进闭环来源。页面发布、会话送达确认不进入来源签名，避免维护循环。当前读取是统一校验入口，FTS 命中后仍检查生效状态；中文另有字面匹配。普通读取不缓存幂等响应，重试旧请求也必须重新检查当前状态。

## Agent 怎么调用

普通 lead、worker、reviewer 和项目专用研究会话均可发现：

1. `memory_context {}`：任务开始、压缩之后、接受/合并工作之前读取。项目由 MCP 凭据绑定，返回 signature、作用域、来源、正文和省略数量。
2. `memory_search {"q":"数据库","kind":"decision","tag":"storage"}`：定向检索当前内容，可按 kind/tag/task_id/lead_session_id 精确筛选。tag 接受一个字符串或字符串数组，数组要求每个标签都匹配（沿用大小写折叠）；GET 查询可重复传 `tag=storage&tag=local`。`project_only: true` 只选无 task 的项目级记录；同时传 task_id 或 lead_session_id 时没有结果（目录和图谱查询直接拒绝这种组合）。返回标题、摘要、版本 ID、状态、作用域和命中理由，不打开正文。旧记录从索引取最多 600 UTF-8 bytes 摘要；显式摘要上限 400 字符；结果条目合计最多 16,000 bytes，`omitted` 显示未返回数量。依赖前必须用 get 读原文。FTS5 处理词语匹配，中文短词另用字面子串匹配，元数据支持精确匹配。
3. `memory_get {"memory_id":"当前版本 ID"}`：读取当前版本。ID 不可读时重新获取 context，不能改用会话里早先读到的副本。
4. `memory_related {"memory_id":"当前版本 ID","relation":"dependent","depth":2,"limit":10}`：查依赖、反向依赖、版本关系或同标签内容。最多两跳、30 条、16,000 bytes，同样只返回当前作用域的摘要；shared_tag 只表示同主题。
5. `memory_propose`：写入笔记、报告，或提交决定候选。启动指令要求 agent 不等用户要求、在同一回合内写入：用户纠正做法或说明偏好与规则、用户确认了一个不显然的做法、发现代码、git 历史和文档里看不到的项目事实、用户说要记住。写入前先 `memory_search`，用旧条目的 key 替代过时内容。例如：

```json
{
  "key": "storage-analysis",
  "kind": "report",
  "text": "观察、结论、尚未验证部分和建议分别写清楚。不要把完成报告当作测试结果。",
  "based_on": "memory_context 返回的 64 字符 signature",
  "dependencies": ["分析所依据的当前决定版本 ID"]
}
```

Agent 必须传 `based_on`；任务会话自动绑定自身任务 generation，不能改成另一个任务。后台期间来源发生变化，提案或确认会拒绝过期的签名，要求重读并重新评估。报告正文建议保留可复查的文件、提交或测试证据引用；本版本只校验 `dependencies` 的记忆版本身份，不替报告自动验证任意文字引用的科学真实性或测试执行情况。

Agent 没有 commit、archive、restore、history 权限。可复用的流程教训走已有 `propose_improvement`，不另建一套经验审批状态。只从 `improvements` 动态读取 trial/active 且领域、tier、runtime 匹配的经验，reverted/rejected/candidate 不进入正常上下文。trial 明确是试用状态。试用比较后保留的经验带 `status_reason: "trial_passed"`，记忆屏“学到的经验”页据此写明它依据 n 个任务的前后对比，和用户固定的规则区分开。

## 会话集成与预算

启动指令解释上述工具和信任边界。每次 send/steer 之前重新生成当前作用域的 packet，不只启动时读取；`project.read` 也提供同一记忆视图。空项目不反复注入空 packet。packet 签名与该会话上次送达的签名相同、且之后没有 `agent.context.compacted` 时不再注入，原生会话的上下文里已有它；签名变化或压缩之后的下一轮重新注入。

正文与逐条元数据默认最多 12,000 UTF-8 bytes，手动 context 可设 1,000–24,000 bytes。这是字节预算，**不是精确 token 数**；固定说明和包壳另计。决定优先、报告按需；任何当前决定放不下时返回 `memory_budget_exceeded`，不悄悄删掉重要规则。用户管理界面仍可打开并缩短决定。`memory.read` 返回 `budget: { used_bytes, limit_bytes }`，默认限额 12,000 bytes；used_bytes 是当前全部可用记录与适用的改进闭环经验在截断前的序列化字节总量，不随目录筛选或分页改变。每条 `MemorySummary.bytes` 是该完整记录（含元数据与 JSON 转义正文）的序列化 UTF-8 大小。`memory.context` 的 `memory_budget_exceeded.details` 返回同样的 used_bytes 与本次请求的 limit_bytes。

`memory.commit` 在事务内检查提交后的当前决定，默认限额也是 12,000 bytes。大小沿用完整记录（包括元数据与 JSON 转义正文）的序列化 UTF-8 字节数；被替代的修订、草稿、归档、过期或其他已失效版本不计入，报告、笔记与改进闭环经验不占必须全部容纳的决定预算。管理目录和无会话的 context 一样涵盖所有任务作用域。超过限额返回 `memory_budget_exceeded`，details 为 `{ used_bytes, limit_bytes, largest_records: [{ id, title, bytes }] }`：used_bytes 仅为提交后当前决定的总大小，largest_records 最多五条，按 bytes 降序；没有 title 时使用 key。失败回滚提交、替代归档和相关事件。限额以内沿用原有提交行为。

会话记录 prepared signature/epoch、context hash、turn ID 和 delivered signature/epoch。仅在提供记忆工具的会话中注入；专用 trace 诊断会话保持其只读双工具边界。只有 runtime 返回 `delivered` 才记作送达，queued/unsupported 不算。发送途中发生的新变更不会被旧回执消除；界面仍显示等待下一轮。目录会话的 `memory_tool` 表示会话是否获准使用记忆工具，专用 trace 诊断会话为 false；`stale` 仅在已有送达且其签名与当前包不同时为 true。`memory.delivered` 事件保存实际包内的 `memory_ids`；`memory.turn {"session_id":"会话 ID","turn_id":"轮次 ID"}` 返回 `items: [{ id, key, title, kind, state, version? }]`，状态取记录当前生命周期状态，不含正文。旧事件没有 memory_ids 时返回空列表。`memory.session_turns {"session_id":"会话 ID"}` 一次返回该会话的 `turns: [{ turn_id, count }]`，只列出获得至少一条记忆的轮次，按首次送达的轮次顺序排列；count 与该轮 `memory.turn` 的 items 数量相同，同一轮有多次送达时使用最后一次。对话线程每个会话读一次 `memory.session_turns`(有回合结束时重读)，只给收到记忆的轮次显示条数，展开某一轮时才读该轮的 `memory.turn`。对 agent 的 task.accept、milestone.accept、session.merge，在有历史生效记忆的项目上检查当前签名，过期时要求重新读取 context。

“送达”只证明运行时接受了输入，不证明模型理解或遵循。Pantheon 不清空原生会话历史，不更改原生记忆插件设置，也不会中断已经执行中的外部 shell 操作。要求不带此前上下文的任务，应新开会话，从当前任务合同、代码和记忆续接；不能声称一次提示注入能从模型上下文中删除已有内容。

## 后台维护

scheduler 比较来源签名，持久化去重的 memory job；每 tick 最多执行一个文档任务。任务有 30 秒租约、最多三次尝试、退避；重启后可回收过期租约。发布前比较来源签名和任务 revision，迟到结果标为 obsolete，不发布到当前文档。

当前进度文档由确定性程序生成：当前决定/已审阅报告、任务合同和完成状态、当前项目级改进闭环经验。接受报告和真实测试验证在语义上分开。文档包含来源签名和省略数量。源变化后已生成的文档立即退出当前读取，等待重新生成；不需要先删除磁盘上的文件。

维护不会自行调用模型，新增后台模型 token 成本为零。研究 agent 在其已有任务里调用 `memory_propose` 产出有解释性的报告。此版本没有另外启动“自动阅读所有聊天、抽取隐含决定”的 LLM，不把用户讨论猜成授权。以后若加模型型提炼器，也必须走相同候选和签名门禁。

维护失败可由用户 `memory.maintain` 重试。记忆屏(概览、条目、关系图、学到的经验四页)的条目页默认只列当前版本，可筛选草稿、归档或全部版本。目录 `memory.read` 每页默认 20、最多 50 条，只返回精简元数据；cursor 绑定筛选和结果版本，期间内容变化会拒绝旧 cursor，用户可刷新回首页。点选才调用 `memory.item` 读取该历史或当前版本的正文；展开进度文档才调用 `memory.document`。读失败或刷新期间不把旧缓存显示成最新状态。

目录与关系图共享筛选。`memory.graph {"project_id":"项目 ID"}` 返回全部符合共享筛选条件的记录图，默认 80 节点；`memory.graph {"project_id":"项目 ID","memory_id":"版本 ID","depth":2}` 保持以所选记忆为中心的邻域，默认 40 节点、最多两跳。两种模式均可传 `max_nodes`（1–200）和 `include_tags`，仍最多 160 边、48,000 bytes；`total` 是筛选后、截断前的节点数（包括来源和启用的标签节点），`truncated` 标记节点、边或字节截断。记忆节点增加最多 120 字符的首行 `summary`；任务记忆增加 `task: { id, title }`，任务已不在计划时 title 回退到任务 ID。来源节点的 `uri` 保留完整引用 URI，会话来源使用 `session:<id>`。箭头分别表示依赖、替代、恢复和原始来源。同标签仅用于筛选或可选标签节点，不制造依赖边。查看跨状态的历史版本关系时选择“所有版本”。已有运行分析来源通过 `session.runtime_review.memory_id` 建立来源节点，不扩展专用诊断会话权限。

目录、search 和 related 的 `MemorySummary` 增加可选的 `author_session_id: string`、`version: number`、`superseded_by: string`、`expires_at: number`、`archived_at: number`、`basis_id: string`。时间字段沿用记录的毫秒时间戳；不存在时省略。version 对同一 key、同一 task（id、lead_session_id、generation 均相同）的已提交版本，按 committed_at 从 1 编号；相同提交时间沿用存储顺序，草稿不编号，历史归档版本仍计数。`memory.turn`、`memory.item` 和 `memory.graph` 的记忆记录节点使用相同编号；草稿的 item 和图节点不带 version。basis_id 是 stale 记录的第一个已失效 dependencies 版本 ID；仅由任务或来源签名变化失效、没有失效依赖时省略。带 superseded_by 的摘要附带 `superseded_by_version: number`，表示替代记录的版本号；带 basis_id 的摘要附带 `basis_title: string`，表示依据记录的标题，没有标题时使用 key。对应记录已不存在时，省略新增字段，保留原有 ID。

目录 `facets.tags` 为 `[{ tag: string, count: number }]`，计数使用除 tag 外的其余筛选（包括状态、kind、task 与 q），在分页前统计每个标签所含的记录数。大小写折叠后的同一标签每条记录只计一次，标签拼写取首条记录；保留最多 100 个按名称排序的标签。

目录 `facets.tasks` 从 lead 的当前计划读取可选 title；计划已无该任务时省略 title。`memory.recent {"project_id":"项目 ID","limit":10}` 返回 `items: [{ at, kind, memory_id, memory_kind, key, title, actor, reason? }]`，kind 为 proposed、committed、archived、restored 或 retraction_undone，memory_kind 沿用记录的 decision/report/note。记录当前已归档时附带 reason（superseded、retracted、expired、stale），沿用现有归档原因；这些字段描述记录当前状态，不是事件发生时的快照。最新事件在前；同一时间按事件序号倒序。limit 默认 10，范围 1–50。只返回生命周期事件元数据，不含正文。旧事件缺少操作人时使用记录作者。`memory.turn`、`memory.session_turns` 与 `memory.recent` 都是仅用户可用的 GET 查询，不增加 agent 工具。

title/summary/tags/references 是可选字段。文件 references 使用项目相对路径和 root 编号，检查真实路径不越出根目录；小于等于 2 MB 的文件保存内容 hash，正文详情返回 unchanged/changed/unversioned/unavailable。HTTP(S) 引用不自动联网，状态是 unverified。引用是来源身份与变化提示，不代表已经验证结论，也不自动把原文件全文复制成记忆。文件变化尚不触发后台自动归档，agent 必须检查 reference_status 并重读来源；已确认规则的撤回仍由明确生命周期操作决定。

FTS5 保留全部状态的本地索引，搜索结果经过统一有效性与权限门禁。缺索引的条目每 tick 最多补建 16 条；坏正文跳过并显示 index_pending，不会饿死后续条目。索引事件刷新目录，不改变记忆来源签名。索引不完整时仅能按已有元数据命中，不把无结果解释为不存在。

## 验证范围

- `tests/control/project-memory.test.ts`：替代和依赖失效、已替代 ID、过期关键词、请求重放、签名冲突、时间过期、角色与作用域、迟到任务、迟到送达回执、任务 generation、改进闭环撤回、事务回滚、租约恢复、预算门禁、有界重试、agent 报告即时生效、文件同步与未变 packet 不重复注入。
- `tests/daemon/project-memory.test.ts`：隔离 daemon、真实 HTTP、真实独立 CLI MCP 子进程、两个 fixture 会话的 adapter 输入、后台文档与重启恢复。
- `tests/control/memory-catalog.test.ts`：无全文读取分页、中文/元数据检索、过期与历史门禁、版本/依赖/标签关系边界、损坏索引补建、来源文件变化与路径范围。
- `tests/web/memory-read.test.ts`：按需读取、切换选中项与刷新期间隐藏上一条的正文。
- `node tests/acceptance/memory-catalog-smoke.mjs`：先构建 desktop，在隔离数据库和 Electron 实例中验证分页、中文搜索、关系图与归档/恢复/确认，不启动模型。
- 原有会话、压缩、MCP 权限、迁移与界面守卫一起回归。

这些测试验证存储和调用链合同；fixture 不是 Claude/Codex 的真实推理评测。没有据此声称长程任务成功率提升或模型必然理解记忆。大项目索引性能、真实模型冲突处理与 token 对照实验需要单独测量。
