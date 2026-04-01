# LCM 风格 Memory 迁移三阶段实施方案

## 目的

本文档用于把当前 OceanKing 项目的 memory / compaction 机制，逐步升级为接近 `win4r/lossless-claw-enhanced` 的 lossless context management 方案。

这里的目标不是直接照搬 OpenClaw 的 `ContextEngine` 插件实现，而是在保留 OceanKing 当前 `room-first` 产品结构的前提下，迁移其中最有价值的四个能力：

- lossless 持久化原始消息
- DAG 式 summary 压缩
- 按 token budget 的上下文组装
- 可检索、可展开的记忆回溯

相关背景可结合 `OceanKing-Agent-Roadmap.md` 一起阅读。

---

## 当前问题

当前实现已经具备可用的共享运行时和 memory 工具，但仍有几个结构性限制：

- `src/lib/server/agent-runtime-store.ts` 仍是 `history + compactions` 的单层运行时模型
- `src/lib/server/agent-compaction.ts` 的 compaction 本质上是“旧消息压成 1 条摘要”
- `src/lib/server/agent-memory-store.ts` 的长期 memory 仍以 markdown 文件为主存储
- `src/lib/ai/tools/memory-tools.ts` 的 `memory_search` / `memory_get` 只能做轻量检索，无法沿 summary 关系回溯到更细粒度上下文
- `src/lib/server/room-runner.ts` 当前还是把完整 `history` 直接喂给模型，而不是按预算组装上下文

如果要接近 LCM 风格能力，关键不是“把现有 summary prompt 改得更聪明”，而是把底层记忆组织方式换掉。

---

## 总体原则

- 保留 OceanKing 当前的 room-first UX，不引入 OpenClaw 的 session-first 产品模型
- 保留 `room-runner`、room tools、workspace 状态流和 visible / hidden transcript 的边界
- 不一次性替换全部存储，先双写、再切读路径、最后退旧实现
- continuation snapshot、room action、visible delivery 这些 OceanKing 特有语义必须保留，不能在迁移过程中退化掉
- 优先做“可验证的渐进迁移”，避免一次性大改导致长对话行为失稳

---

## 目标状态

迁移完成后，理想形态如下：

- 原始消息、工具结果、room action、continuation snapshot 全部进入结构化持久化存储
- active context 不再等于完整历史，而是 `summary nodes + fresh tail raw items + 高优先级特殊项`
- 压缩后的内容仍然可通过 summary lineage 回溯到源消息
- memory 工具不再依赖 markdown 行号，而是支持基于消息 / summary 节点的搜索、描述和展开
- markdown timeline 可以保留为 debug / export 产物，但不再是 canonical store

---

## PR 1：引入 Lossless 持久化底座（双写，不切换读路径）

### 目标

先把每次 turn 的原始信息完整落到新的结构化存储中，但不改变当前模型真正消费的上下文路径。

这一阶段的核心目标是：

- 建立 SQLite 或等价结构化存储作为新底座
- 保留现有 `.oceanking/agent-runtime/*.json` 与 `.oceanking/memory/*.md` 作为现网主路径
- 在不改变外部行为的情况下，开始持续积累 lossless 历史数据

### 建议新增模块

- `src/lib/server/agent-context-db.ts`
- `src/lib/server/agent-context-types.ts`
- `src/lib/server/agent-conversation-store.ts`
- `src/lib/server/agent-summary-store.ts`
- `src/lib/server/agent-context-ingest.ts`

### 建议新增数据表

- `agent_conversations`
- `agent_messages`
- `agent_message_parts`
- `agent_summaries`
- `agent_summary_messages`
- `agent_summary_parents`
- `agent_context_items`

这里的 conversation 粒度建议优先按 `agentId` 建模，而不是按单个 room 建模。原因是当前 OceanKing 明确要求 attached rooms 共享一个 memory space，这一点见 `src/lib/server/agent-room-sessions.ts`。

### 这一阶段要写入的数据

在 `src/lib/server/agent-room-sessions.ts` 中接入双写，覆盖以下几个时间点：

- `startAgentRoomRun()` 写入 incoming user message
- `recordAgentToolEvent()` 写入 tool result / room action / room delivery 相关 part
- `completeAgentRoomRun()` 写入 assistant message 和最终 turn 聚合结果
- continuation snapshot 也要作为独立的 part 写入，而不是仅保存在字符串历史里

### Message Parts 建议最小集合

- `incoming_room_message`
- `assistant_text`
- `tool_result`
- `room_delivery`
- `room_action`
- `continuation_snapshot`
- `attachment_summary`

### 现有实现保留方式

- `src/lib/server/agent-runtime-store.ts` 保持现状，继续承担主路径
- `src/lib/server/agent-memory-store.ts` 保持现状，继续写 markdown timeline 和 compactions
- `src/lib/server/room-runner.ts` 不切换上下文来源

### 测试

建议新增：

- `tests/agent-context-store.test.ts`
- `tests/agent-context-ingest.test.ts`

重点验证：

- 多个 room 共享同一 agent 时能落到同一 conversation
- tool events / room actions / visible deliveries 都被正确结构化入库
- continuation snapshot 在有 superseded run 时会被写入
- 新增持久化失败不会破坏现有主流程

### 验收标准

- 用户可见行为无变化
- 新 DB 中能看到完整、可追踪的原始 turn 记录
- 旧 JSON / markdown 路径继续工作
- 出现问题时可以通过关闭新读路径完全回退

---

## PR 2：切换到 Context Items + DAG Compaction + Budget Assembly

### 目标

这一阶段开始让模型真正使用新上下文系统，而不是继续使用旧的 `history` 数组。

核心目标：

- 把当前 active context 从 `history` 切换到 `context_items`
- 用 DAG 式压缩替代当前“单条摘要替换”机制
- 在真正喂给模型前，按 token budget 组装 summary + fresh tail + 特殊上下文

### 建议新增模块

- `src/lib/server/agent-context-assembler.ts`
- `src/lib/server/agent-context-compaction.ts`
- `src/lib/server/agent-context-budget.ts`

### 需要修改的关键文件

- `src/lib/server/agent-room-sessions.ts`
- `src/lib/server/room-runner.ts`
- `src/lib/server/agent-runtime-store.ts`
- `src/lib/server/agent-compaction.ts`

### 主要改造点

#### 1. DAG compaction 替代单层 compaction

把当前 `compactPersistedAgentRuntime()` 入口保留下来，但内部逻辑切换为：

- 旧 raw messages chunk -> `leaf summary`
- 多个 leaf summaries -> `condensed summary`
- 用新的 summary node 替换 `context_items` 中的一段范围
- 原始消息保留在存储里，不从 canonical data 中删除

#### 2. 上下文组装改为 budget-aware assembly

在 `src/lib/server/room-runner.ts` 中，不再直接把完整 `runContext.history` 传给 `conversationRunner`，而是先执行 assemble：

- 选取最近的 raw tail
- 选取必要的 summary nodes
- 保留最近 continuation snapshot
- 保留必要的 room obligations / unresolved actions
- 控制在 token budget 内

#### 3. continuation snapshot 设为高优先级项

OceanKing 的 continuation snapshot 不是普通历史文本，而是未完成房间义务的提醒。因此建议：

- 不要把它和普通 assistant text 一视同仁地压缩
- 将其作为高优先级特殊 context item
- 组装时优先保留最近有效 snapshot

#### 4. 现有 runtime store 退化为兼容层

`src/lib/server/agent-runtime-store.ts` 可以短期继续保留接口，但不再作为主存储。可选做法：

- 内部改为从 DB 同步导出兼容结果
- 或仅保留为回退层，逐步减少依赖

### 测试

建议新增：

- `tests/agent-context-compaction.test.ts`
- `tests/agent-context-assembler.test.ts`

重点验证：

- 压缩后总 token 明显下降
- 最近 raw tail 仍能保留
- continuation snapshot 不会被错误丢弃
- 多 room 共享上下文下，旧房间义务不会因压缩丢失
- room-runner 切换后可见行为与当前系统一致

### 验收标准

- 模型实际使用的新上下文组装结果
- 长对话不再依赖整段 `history` 原样传入
- 旧历史被压缩后仍可回溯到 source messages
- 自动与手动 compaction 都可正常工作

---

## PR 3：切换 Memory Tools 到 Search / Describe / Expand 路径

### 目标

这一阶段把 memory 从“markdown 检索”升级为“可搜索、可描述、可展开的 DAG memory”。

核心目标：

- 不再把 markdown 文件当 canonical memory store
- 让 agent 能在压缩后仍然把细节找回来
- 平滑升级当前 `memory_search` / `memory_get` 能力

### 建议新增模块

- `src/lib/server/agent-memory-retrieval.ts`
- `src/lib/server/agent-memory-expand.ts`

### 需要修改的关键文件

- `src/lib/ai/tools/memory-tools.ts`
- `src/lib/server/agent-memory-store.ts`
- `src/app/api/agent-memory/compact/route.ts`

### 工具迁移建议

有两种可选路径。

#### 路径 A：保留旧工具名，升级内部语义

- `memory_search`
  - 同时搜索 messages 和 summaries
  - 返回 `messageId` / `summaryId` / `roomId` / snippet / score
- `memory_get`
  - 支持通过 `summaryId`、`messageId` 或内部 handle 获取内容
  - 不再依赖 markdown 路径和行号

#### 路径 B：新增更明确的三段式工具

- `memory_search`
- `memory_describe`
- `memory_expand`

如果更重视与当前 prompt 的兼容性，建议先走路径 A，再逐步增加 `memory_describe` / `memory_expand`。

### retrieval 功能建议

- Search
  - 可搜 raw messages
  - 可搜 summaries
  - 可按 roomId / 时间范围过滤
- Describe
  - 查看 summary 节点的 depth、父子关系、覆盖范围、涉及 rooms
- Expand
  - 从 summary 追到父 summary 或 source messages
  - 允许 token-capped 展开，避免一次性回灌过多原文

### markdown memory 的最终定位

建议将 `src/lib/server/agent-memory-store.ts` 调整为：

- debug / export / audit 层
- 继续可选写出 `timeline/*.md` 和 `compactions.md`
- 但不再作为 memory_search 的主数据源

### 测试

建议新增：

- `tests/agent-memory-retrieval.test.ts`
- `tests/agent-memory-expand.test.ts`

重点验证：

- 能搜到 raw messages 与 summaries
- 能通过 summary 节点展开回 source messages
- 跨 room 查询仍然遵循 agent 共享 memory 语义
- 被 compaction 压掉的细节能被可靠取回

### 验收标准

- agent 不再依赖 markdown 行号检索历史
- 记忆工具能对压缩后的历史进行真正的 lossless recall
- markdown timeline 即使保留，也只作为调试产物

---

## 推荐实施顺序

建议严格按以下顺序推进：

1. 先做 PR 1，建立双写底座
2. 再做 PR 2，切换 active context 的读取与 compaction
3. 最后做 PR 3，切换 memory 检索与展开能力

原因很简单：

- 没有 lossless 持久化底座，就没有可靠的 DAG compaction
- 没有 DAG compaction 和 context items，就没有真正可展开的 memory
- 如果先动 tools 而底层存储没准备好，最终只会变成更复杂的兼容层

---

## 各阶段最大风险

### PR 1 风险

- 新旧数据格式语义不一致
- tool / room action 没有被完整结构化
- 双写失败影响主流程

### PR 2 风险

- continuation snapshot 被错误压缩或遗漏
- 多 room 共享语义在 assemble 时被错误剪裁
- token budget 估算不稳导致过度压缩或上下文超限

### PR 3 风险

- 旧工具调用习惯与新返回格式不兼容
- retrieval 只搜到 summary，拿不回足够的 source detail
- 过早移除 markdown store 影响人工排障

---

## 非目标

以下内容不建议在这三阶段里一起做：

- 一开始就引入向量数据库 / embedding pipeline
- 一开始就复制 lossless-claw 的大文件外置化能力
- 引入 OpenClaw session / subagent 模型
- 对前端 room / workspace 产品层做大规模结构改造

这些事情都可能有价值，但不属于这轮 memory 机制迁移的必要范围。

---

## 完成标准

当以下条件都满足时，可以认为这轮迁移达到目标：

- OceanKing 仍保持 room-first 交互模型
- agent 的 canonical memory 已从 `json + markdown` 转为结构化存储
- active context 已由 budget-aware assembly 组装
- compaction 已具备 leaf / condensed 的 DAG 能力
- memory 工具已支持对压缩历史做 search / describe / expand
- 旧 markdown timeline 不再承担主检索职责

这时，OceanKing 的 memory 机制就已经“本质上变成了 LCM 风格实现”，同时仍保留了 OceanKing 自己的产品边界。
