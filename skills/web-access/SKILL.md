---
name: web-access
license: MIT
github: https://github.com/eze-is/web-access
description: 联网任务优先使用现有的 web_fetch、custom_command(web_fetch) 与 bash(curl)。当任务需要登录态、真实浏览器交互或动态页面调试时，切换到本地 CDP Chrome 代理模式。
metadata:
  author: 一泽Eze, adapted for OceanKing
  version: "0.1.0"
---
# Web Access

## 适用范围

当用户要求以下任务时，优先按本 skill 处理：

- 搜索最新信息、读取网页、核实在线内容
- 访问动态渲染页面
- 处理需要登录态的网站
- 需要真实浏览器交互的任务，如点击、滚动、上传文件、截图

OceanKing 已内置 `web_fetch`、`custom_command`、`bash`、房间工具与项目上下文工具，所以这里不是照搬 Claude Code 版，而是把它的核心哲学适配到当前 Agent 架构。

## 核心原则

Skill = 浏览哲学 + 技术事实，不是固定步骤手册。

执行联网任务时，按以下逻辑决策：

1. 先定义目标与完成标准
- 用户到底要信息、证据、摘要，还是页面操作结果。
- 停止条件必须明确，避免为了“更完整”而过度操作。

2. 先走最轻路径，再按证据升级
- 已知 URL 且页面公开：优先 `web_fetch`
- 只需要快速发现来源：优先 `custom_command` 的 `web_fetch` 或外部搜索入口
- 需要原始 HTML、headers、接口探测：优先 `bash` + `curl`
- 需要登录态、动态交互、真实浏览器：再切换到 CDP 代理

3. 每一步都用结果校验方向
- 搜不到不等于不存在，也可能是入口不对
- 平台报“内容不存在”不一定是真的，可能是访问方式、参数或反爬问题
- 同一路径重复失败时，应更换获取方式，而不是机械重试

4. 优先一手来源
- 搜索和聚合只用于发现线索
- 核实时，优先官网、官方文档、源码或原始页面

## OceanKing 下的工具分层

| 场景 | 首选工具 |
|------|----------|
| 已知公开 URL，想读正文 | `web_fetch` |
| 想获取当前时间、项目概况或委托式网页抓取 | `custom_command` |
| 要看原始 HTML / 调接口 / 下载文件 / 访问本地 CDP API | `bash` |
| 需要给用户回传结果 | `send_message_to_room` |
| 需要本地项目说明 | `project_context_list` / `project_context_read` |

### 默认策略

- 不要为了“像浏览器”而默认启用浏览器。
- OceanKing 已有的 `web_fetch` 能满足大量公开网页读取任务。
- 浏览器 CDP 是高成本模式，只在必要时用。

## CDP 模式何时启用

满足任一条件时，可启用本地 CDP 模式：

- 页面依赖前端渲染，`web_fetch`/`curl` 无法拿到目标内容
- 需要登录态
- 需要点击、滚动、翻页、上传文件、截图
- 需要像用户一样在站内导航探索

## 本地环境要求

当前项目运行在 OceanKing 工作区，适配后的 CDP 方案要求：

- Node.js 22+
- 用户本机 Chrome 已开启 remote debugging
- 本地启动一个轻量 HTTP CDP 代理，供 `bash` 里的 `curl` 调用

## CDP 代理约定

推荐代理监听：`http://127.0.0.1:3456`

常用接口：

- `GET /targets` 列出 tab
- `GET /new?url=...` 新建后台 tab
- `POST /eval?target=...` 执行 JS
- `POST /click?target=...` JS 点击
- `POST /clickAt?target=...` 真实鼠标点击
- `POST /setFiles?target=...` 文件上传
- `GET /scroll?target=...&direction=bottom` 滚动
- `GET /screenshot?target=...&file=...` 截图
- `GET /close?target=...` 关闭 tab

## 浏览器操作守则

- 默认不要动用户现有 tab
- 优先新建自己的后台 tab 完成任务
- 结束后关闭自己创建的 tab
- 只有在确认登录能解决问题时，才提示用户去 Chrome 完成登录
- 用户登录后不需要重启 OceanKing，只需继续当前流程

## 站点经验

如果某站点反复出现固定模式，可把已验证经验沉淀到 `skills/web-access/references/site-patterns/<domain>.md`，内容只记录经过验证的事实：

```md
---
domain: example.com
updated: 2026-03-29
---
## 平台特征
## 有效模式
## 已知陷阱
```

不要写未经验证的猜测。

## 在 OceanKing 中的推荐执行顺序

1. 先判断公开读取是否足够：`web_fetch`
2. 不够时再用 `bash` + `curl` 看原始响应
3. 仍不够且确认需要浏览器时，检查 CDP 环境并启动代理
4. 用 `bash` 调本地代理 API 驱动 Chrome
5. 从页面 DOM 提取信息，而不只是盲目截图
6. 任务完成后关闭创建的 tab，并向房间回传结果

## 适配说明

原仓库的核心价值主要有三部分：

- 联网策略选择，而不是单一工具崇拜
- 通过 CDP 连接用户真实 Chrome，复用登录态
- 站点经验沉淀与跨任务复用

在 OceanKing 中：

- WebSearch/WebFetch/curl/CDP 的“调度哲学”被保留
- 公开网页读取优先复用现有 `web_fetch`
- 需要原始响应或本地代理调用时，使用 `bash`
- 房间答复继续走 `send_message_to_room`，不直接依赖普通 assistant 文本

## 注意事项

- `web_fetch` 只能访问公网 URL，且会阻止本地/私网地址
- 因此访问 `http://127.0.0.1:3456` 这类本地 CDP 代理时，必须使用 `bash` + `curl`
- 若 Chrome 未开启 remote debugging，应先明确告诉用户如何开启
- 若 Node 版本不足 22，可运行，但原版代理会退回依赖 `ws` 模块；当前环境已是 Node 22+
