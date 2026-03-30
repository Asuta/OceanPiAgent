import type { RoomAgentDefinition } from "@/lib/chat/types";

export const TOOL_CATALOG = [
  {
    name: "web_fetch",
    title: "Web Fetch",
    description: "抓取公开网页，清洗 HTML，再把正文文本交回给模型。",
  },
  {
    name: "custom_command",
    title: "Custom Command",
    description: "调度一组注册过的命令；现在内置 list_commands、project_profile、current_time，也能转调 web_fetch。",
  },
  {
    name: "memory_search",
    title: "Memory Search",
    description: "检索持久化 agent memory，用来回忆跨房间的旧结论、工具结果和压缩摘要。",
  },
  {
    name: "list_cron_jobs",
    title: "List Cron Jobs",
    description: "列出当前 Agent 在已连接房间里的定时任务，可按房间、状态、启停状态过滤。",
  },
  {
    name: "get_cron_job",
    title: "Get Cron Job",
    description: "查看单个定时任务的完整配置，并可顺带读取最近执行记录。",
  },
  {
    name: "create_cron_job",
    title: "Create Cron Job",
    description: "为当前 Agent 创建定时任务，目标房间必须是它当前已连接的 room。",
  },
  {
    name: "update_cron_job",
    title: "Update Cron Job",
    description: "修改当前 Agent 已有的定时任务，可更新标题、Prompt、调度方式、投递策略与启停状态。",
  },
  {
    name: "pause_cron_job",
    title: "Pause Cron Job",
    description: "暂停一个定时任务但保留配置，适合临时停用。",
  },
  {
    name: "resume_cron_job",
    title: "Resume Cron Job",
    description: "恢复一个已暂停的定时任务，并重新计算下一次触发时间。",
  },
  {
    name: "delete_cron_job",
    title: "Delete Cron Job",
    description: "删除一个属于当前 Agent 的定时任务。",
  },
  {
    name: "run_cron_job_now",
    title: "Run Cron Job Now",
    description: "立即把一个定时任务排队执行一次，不改变它未来的调度计划。",
  },
  {
    name: "list_cron_runs",
    title: "List Cron Runs",
    description: "查看最近的定时任务执行记录，可按任务、房间和执行状态过滤。",
  },
  {
    name: "preview_cron_schedule",
    title: "Preview Cron Schedule",
    description: "预演某个调度配置将被怎样解释，返回下一次和下下次触发时间。",
  },
  {
    name: "memory_get",
    title: "Memory Get",
    description: "按文件和行号读取 memory_search 命中的上下文片段，避免把整份记忆全部塞回 prompt。",
  },
  {
    name: "memory_status",
    title: "Memory Status",
    description: "查看当前 agent memory 的后端类型、索引状态，以及记忆文件是否需要重建索引。",
  },
  {
    name: "memory_index",
    title: "Memory Index",
    description: "增量刷新或强制重建当前 agent 的 memory 索引，用来修复检索结果陈旧或缺失。",
  },
  {
    name: "workspace_list",
    title: "Workspace List",
    description: "列出当前 Agent 独立 workspace 里的文件和目录，默认只允许访问自己的目录。",
  },
  {
    name: "workspace_read",
    title: "Workspace Read",
    description: "读取当前 Agent 独立 workspace 里的文本文件，可按行切片查看。",
  },
  {
    name: "workspace_write",
    title: "Workspace Write",
    description: "在当前 Agent 独立 workspace 中创建或覆盖文本文件，自动补齐父目录。",
  },
  {
    name: "workspace_delete",
    title: "Workspace Delete",
    description: "删除当前 Agent 独立 workspace 中的文件或目录，目录删除可递归执行。",
  },
  {
    name: "workspace_append",
    title: "Workspace Append",
    description: "向当前 Agent 独立 workspace 中的文本文件追加内容，不存在时自动创建。",
  },
  {
    name: "workspace_move",
    title: "Workspace Move",
    description: "在当前 Agent 独立 workspace 内重命名或移动文件、目录。",
  },
  {
    name: "workspace_mkdir",
    title: "Workspace Mkdir",
    description: "在当前 Agent 独立 workspace 中创建目录，用于显式整理工作结构。",
  },
  {
    name: "shared_workspace_list",
    title: "Shared Workspace List",
    description: "列出所有 Agent 共享 workspace 里的文件和目录，适合查看跨 Agent 协作产物。",
  },
  {
    name: "shared_workspace_read",
    title: "Shared Workspace Read",
    description: "读取共享 workspace 里的文本文件，可按行切片查看。",
  },
  {
    name: "shared_workspace_write",
    title: "Shared Workspace Write",
    description: "在共享 workspace 中创建或覆盖文本文件，适合写交接说明、共享计划和共同产出。",
  },
  {
    name: "shared_workspace_delete",
    title: "Shared Workspace Delete",
    description: "删除共享 workspace 中的文件或目录，目录删除可递归执行。",
  },
  {
    name: "shared_workspace_append",
    title: "Shared Workspace Append",
    description: "向共享 workspace 中的文本文件追加内容，不存在时自动创建。",
  },
  {
    name: "shared_workspace_move",
    title: "Shared Workspace Move",
    description: "在共享 workspace 内重命名或移动文件、目录。",
  },
  {
    name: "shared_workspace_mkdir",
    title: "Shared Workspace Mkdir",
    description: "在共享 workspace 中创建目录，用于组织跨 Agent 协作资料。",
  },
] as const;

export const CUSTOM_COMMANDS = [
  {
    name: "list_commands",
    summary: "列出当前可用的命令和参数提示。",
  },
  {
    name: "project_profile",
    summary: "返回这个 Starter 的技术栈和架构说明。",
  },
  {
    name: "current_time",
    summary: "返回服务端当前时间，可选 timezone。",
  },
  {
    name: "web_fetch",
    summary: "通过 custom_command 入口调用网页抓取。",
  },
] as const;

export const BUILTIN_ROOM_AGENTS: RoomAgentDefinition[] = [
  {
    id: "concierge",
    label: "Harbor Concierge",
    summary: "默认通用 Agent，适合日常问答、总结和把结果整理成清晰房间回复。",
    skills: ["General Q&A", "Summarization", "Room Reply Polish", "Handoff Coordination"],
    workingStyle: "Calm, concise, and good at keeping the room orderly.",
    instruction:
      "You are Harbor Concierge, a calm general-purpose room agent. Favor concise, polished replies and make the Chat Room feel orderly and helpful.",
  },
  {
    id: "researcher",
    label: "Signal Researcher",
    summary: "更偏调研和检索，适合多用 web_fetch、同步进展，再输出结论。",
    skills: ["Investigation", "Web Research", "Verification", "Progress Updates"],
    workingStyle: "Investigative, evidence-seeking, and comfortable with iterative progress reporting.",
    instruction:
      "You are Signal Researcher, a room agent optimized for investigation. Use tools proactively for verification, send progress updates when useful, and close with a grounded conclusion.",
  },
  {
    id: "operator",
    label: "Bridge Operator",
    summary: "更偏执行和流程拆解，适合解释步骤、风险和下一步动作。",
    skills: ["Execution Planning", "Risk Review", "Step Breakdown", "Operational Updates"],
    workingStyle: "Operational, action-oriented, and quick to surface risks and next steps.",
    instruction:
      "You are Bridge Operator, a room agent focused on execution. Break work into clear actions, surface warnings early, and keep the room updated with practical status messages.",
  },
];

export const ROOM_AGENTS = BUILTIN_ROOM_AGENTS;

export const ROOM_BRIDGE_RULES = [
  "用户发言先进入底层 Agent 会话，而不是直接贴给可见房间。",
  "同一个 Agent 现在跨多个房间共用唯一的后端会话，所有房间消息都会汇入这条共享流。",
  "底层 Agent 的原始文本默认只留在内部控制台，不直接透传给人类。",
  "只有显式调用 send_message_to_room，内容才会被过滤后投递回 Chat Room，而且必须明确指定 roomId。",
  "send_message_to_room 同时承担当前 room 回复，以及给其他已连接 room 主动传话或同步。",
  "这个可见投递工具支持 kind / status / final，让房间层能表达进展、告警、失败和最终答复。",
  "如果 Agent 觉得消息没必要发送可见房间消息，可以调用 read_no_reply，并明确指定 roomId + messageId，让对应参与者消息旁出现带 Agent 名字的已读标记。",
  "read_no_reply 和当前 room 的可见房间消息在同一轮里应该互斥，不要同时作为同一条消息的最终房间结果出现。",
  "群组管理工具可以列出当前已加入 rooms、查看 agent 电话本、创建新群、拉 agent 进群、退群、踢人，以及回看已加入群的可见历史。",
  "现在 room 模式还提供 cron 工具：可查看、创建、修改、暂停、恢复、删除、立即执行定时任务，并查看最近执行记录。",
  "cron 工具只允许管理当前 Agent 自己的任务，而且目标 room 必须仍然是这个 Agent 当前已连接的房间。",
  "human 始终保留任意 room 的可见权和插话权；成员列表只决定哪些参与者被视为当前群成员与自动轮询对象。",
  "每个 Agent 种类都有一份独立但跨房间共享的 workspace，可通过 workspace_* 工具读写自己的目录。",
  "所有 Agent 还共享一份公共 workspace，可通过 shared_workspace_* 工具协作编辑交接文档、共享计划和共用产物。",
] as const;
