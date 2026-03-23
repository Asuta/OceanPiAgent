# OceanKing Agent 演进路线图

## 目标

在保留 OceanKing 现有 Chatroom 产品形态的前提下，逐步吸收 OpenClaw 在 pi agent 之上叠加的高价值运行时能力。

核心边界如下：

- 保留 `Chatroom` 作为用户可见的主要交互单元
- 不引入 OpenClaw 的 `session / subagent / sessions_*` 编排模型
- 继续复用 OceanKing 现有的 room-first UX 和房间工具体系
- 以渐进式方式补齐 memory、skills、compaction、MCP、heartbeat、cron 等基础设施

---

## 产品方向

OpenClaw 更适合作为“运行时能力参考”，而不是直接照搬的产品模板。

### 适合吸收的能力

- skills 系统
- MCP 工具集成
- 上下文压缩与上下文裁剪
- heartbeat
- cron / 定时任务
- hook / plugin 生命周期
- tool policy 与安全层
- memory 检索与记忆管理

### 暂不直接吸收的能力

- `sessions_list`
- `sessions_send`
- `sessions_spawn`
- `sessions_yield`
- subagent 编排
- OpenClaw 的 session-first 对话模型

### OceanKing 的替代映射方式

将 OpenClaw 的 session 概念，映射到 OceanKing 现有的 room-first 结构：

- OpenClaw `session` -> OceanKing 的隐藏 agent runtime 状态
- OpenClaw 的可见对话目标 -> OceanKing `Chatroom`
- OpenClaw 的消息投递 -> OceanKing `send_message_to_room`
- OpenClaw 的共享 agent memory -> OceanKing 的跨房间共享隐藏记忆

也就是说：

> 我们吸收的是 OpenClaw 的基础设施，不是它的顶层产品模型。

---

## OceanKing 当前基础

OceanKing 已经具备非常好的起点：

- `src/lib/ai/openai-client.ts`
  - 已经完成 pi runtime 集成
- `src/app/api/room-chat/route.ts`
  - 已经完成 room-first 的请求入口
- `src/lib/ai/tools/index.ts`
  - 已经具备 room-aware 工具执行体系
- `src/lib/server/agent-room-sessions.ts`
  - 已经存在每个 agent 的隐藏共享运行态
- `src/components/workspace-provider.tsx`
  - 已经具备前端房间状态、Agent 设置、调度入口

这意味着我们不需要重做产品外壳，重点是把底层 runtime 逐步补强。

---

## 第一版

## 目标

先做出一套“room-native 的 OpenClaw 风格 runtime 内核”，优先解决以下问题：

- 记忆连续性
- prompt 可扩展性
- 运行时可插拔性
- 长对话稳定性
- 后续能力接入的基础设施

第一版不追求完整自动化，而是先把地基打稳。

## 第一版范围

### 1. 持久化 Agent Runtime Store

把当前主要依赖内存的隐藏运行态，升级为可持久化的服务端存储。

主要目的：

- 支持服务重启后恢复状态
- 支持 memory 建索引
- 支持 compaction 元数据
- 支持后续 heartbeat / cron
- 支持 skills 快照与运行期上下文恢复

建议保存的核心内容：

- 每个 agent 的隐藏 transcript
- room 关联信息
- tool 执行摘要
- compaction 摘要
- memory 索引指针
- runtime 相关设置快照

为什么要先做：

如果没有持久化，后续的 memory、heartbeat、cron 都会很脆弱。

---

### 2. Hook / Plugin 生命周期骨架

先做一个轻量版的运行时生命周期层，参考 OpenClaw，但不必一次做到很大。

第一批推荐 hook：

- `before_model_resolve`
- `before_prompt_build`
- `before_tool_call`
- `after_tool_call`
- `before_compaction`
- `after_compaction`

主要作用：

- skills 可以干净地注入 prompt
- MCP 未来接入时不需要继续污染核心文件
- memory / compaction / heartbeat / cron 都能挂在稳定生命周期点上

为什么第一版就做：

这是防止 `src/lib/ai/openai-client.ts` 再次膨胀成巨石文件的关键措施。

---

### 3. Skills 系统

增加 workspace-local 的 skills 能力。

建议形态：

- `skills/<skill>/SKILL.md`
- 支持 workspace 范围内技能发现
- 支持将技能 prompt 注入系统提示
- 后续再考虑更细粒度的 per-agent skill 配置

第一版建议只做：

- workspace skill 加载
- prompt 注入
- 基础 skill catalog 展示（可选）

第一版暂不做：

- 在线技能市场
- 自动下载 / 安装
- 复杂的 per-skill env overrides

为什么第一版就值得做：

它实现成本相对低，但对产品表达力提升非常直接。

---

### 4. Memory 检索

增加房间兼容的 agent memory 工具。

第一版建议新增：

- `memory_search`
- `memory_get`

第一版的 memory 来源可以包括：

- 过往隐藏 agent transcript
- 结构化摘要
- 重要的房间可见输出
- 关键 tool 结果

实现建议：

- 第一版优先用本地文件或 SQLite 这类轻量存储
- 不要一开始就要求向量数据库
- 先把“可用”和“可维护”做出来，再考虑更重的 embedding 检索

为什么第一版就该做：

这是 OceanKing 从“短上下文对话”走向“长期连续助理”的第一步。

---

### 5. Compaction Safeguard Lite

做一版简化版的 compaction，借鉴 OpenClaw，但不要一开始做得过重。

第一版 compaction 至少需要：

- 保留最近几轮原文
- 保留未完成事项
- 保留决策与约束
- 保留关键标识符
- 保留工具结论
- 支持手动 compact
- 支持达到阈值后自动 compact

第一版不建议做：

- 多轮 staged summarization
- compaction 质量失败重试
- 太复杂的结构化规则矩阵
- 多个 context engine 切换

为什么第一版要做：

如果没有 compaction，长房间对话的稳定性会很快下降，memory 检索也会受影响。

---

## 第一版预期结果

第一版完成后，OceanKing 应该具备：

- 可恢复的隐藏 agent runtime 状态
- room-native 的长期记忆基础
- skill 驱动的 prompt 叠加能力
- 更稳定的扩展入口
- 对长房间对话更可靠的 compaction 支撑

对用户的直接感知会是：

- 更不容易失忆
- 跨房间共享上下文更稳定
- 同一个 agent 的连续性更强
- 后续上新能力时风险更低

---

## 第二版

## 目标

在第一版 runtime 基础设施稳定后，再补“外部能力接入 + 自动化”。

第二版的目标是让 OceanKing 从“能连续对话的房间 Agent”，进一步进化为“可以长期维护房间状态的持续性助手平台”。

## 第二版范围

### 1. MCP Bundle 集成

接入 stdio 方式的 MCP server，并把 MCP tools 注册进当前 pi runtime。

主要价值：

- 外部工具能力可以按配置扩展
- 不需要把所有能力都硬编码到 OceanKing 里
- 是最值得从 OpenClaw 吸收的一层外部能力机制

设计原则：

- MCP 只是工具提供方
- 最终执行仍然跑在 OceanKing 的 room-aware runtime 里
- 对用户可见的输出仍然走现有 room 工具体系

---

### 2. Tool Policy / Safety Layer

一旦 MCP 和自动化进入系统，安全性会立刻变得重要。

第二版建议补齐：

- tool allowlist / denylist
- owner-only 或高权限 room action
- room 级权限限制
- provider / model compatibility 规则
- 为未来 sandbox 留出边界

为什么放在第二版：

因为第一版还主要是内部能力建设，而从第二版开始系统会接触更强的外部能力和自动行为。

---

### 3. Room-native Heartbeat

实现 heartbeat，但不要按 OpenClaw 的 session 语义来做，而是改造成“面向房间”的 heartbeat。

heartbeat 建议承担的任务：

- 检查未完成事项或待回复状态
- 检查最近 room context 与 memory 状态
- 不需要回复时保持静默
- 需要时向正确 room 发出进展或提醒
- 支持类似 `HEARTBEAT_OK` 的无输出路径

关键原则：

- heartbeat 的目标是 room，而不是抽象 session
- 输出必须通过 `send_message_to_room`

---

### 4. Room-native Cron / 定时任务

实现面向房间的定时任务。

建议 job 结构直接绑定：

- `agentId`
- `targetRoomId`
- `schedule`
- `prompt`
- `deliveryPolicy`
- `enabled`

示例用途：

- 每日项目房间总结
- 固定时间提醒
- 定期研究刷新
- 定时检查某房间是否存在待处理事项

关键点：

- job 的可见目标是 room
- 不要引入 OpenClaw 风格的 session target 概念

---

### 5. Advanced Context Engine 抽象

等 memory 与 compaction 稳定后，再把它们抽象成 context engine。

未来可以支持的模式：

- transcript-only
- transcript + memory
- cache-aware pruning
- room-priority pruning
- 不同 compaction 策略切换

为什么不放在第一版：

抽象只有在底层机制已经验证过以后才真正有价值，否则容易过度设计。

---

### 6. 可选的 LSP Bundle

只有当 OceanKing 明显往 coding / project assistant 方向走时，再考虑加入。

如果产品仍然偏通用房间协作，这项可以继续后置。

---

## 第二版预期结果

第二版完成后，OceanKing 应该具备：

- 可插拔的外部工具能力（MCP）
- 更完整的运行时安全层
- room-native 的 heartbeat 能力
- room-native 的 cron / 定时任务能力
- 为未来 context engine 做好的结构准备

对用户的直接感知会是：

- Agent 不只是“等你说话”
- 它能持续维护房间状态
- 它能接入更多外部工具
- 它更像一个长期存在的操作型助手

---

## 为什么这样拆版本

### 如果一开始做太多

如果一上来就做 MCP + cron + heartbeat，而没有先补 persistence、memory、compaction，就很容易出现：

- 重启后状态丢失
- 自动化行为脆弱
- 很难 debug
- 长期上下文质量差
- 核心文件迅速膨胀

### 为什么先做第一版

第一版解决的是：

- runtime 持久性
- context 质量
- 扩展结构

### 为什么第二版再做自动化

第二版解决的是：

- 外部能力接入
- 自动化
- 安全策略
- 平台级行为

这是最符合依赖顺序的做法。

---

## 推荐实施顺序

### 第一版建议顺序

1. 持久化 runtime store
2. hook 骨架
3. skills
4. memory 检索
5. compaction safeguard lite

### 第二版建议顺序

1. MCP bundle
2. tool policy / safety
3. room-native heartbeat
4. room-native cron
5. context engine 抽象
6. 可选 LSP bundle

---

## 目前明确不做的内容

暂时不建议投入的方向：

- subagent 编排
- `sessions_*` 系列工具
- session-first 的消息投递模型
- ClawHub 风格在线技能市场
- 多 channel gateway 平台
- 过早对外开放完整 plugin SDK

这些都不是 OceanKing 当前 room-first 产品方向里的高优先级事项。

---

## 最终策略总结

OceanKing 的演进方向应该是：

- 保持 `room-first` 产品模型
- 保持 `pi-native` 的 agent runtime 内核
- 吸收 OpenClaw 的高价值 runtime 基础设施
- 但不引入 OpenClaw 的 session / subagent 架构

一句话总结：

> 吸收基础设施，不替换产品模型。

OceanKing 已经有自己很鲜明的 Chatroom 顶层交互方式。
正确的路线不是把它改成 OpenClaw，而是在它下面逐步补上 OpenClaw 那套成熟的运行时能力。
