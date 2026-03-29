# Web Access for OceanKing

这是基于 `eze-is/web-access` 思路做的 OceanKing 适配版，而不是原版 Claude Code 的直接移植。

## 已适配的核心思路

- 公开网页优先走 OceanKing 自带的 `web_fetch`
- 需要原始响应、下载、接口探测时走 `bash + curl`
- 只有遇到动态渲染、登录态、交互操作时，才升级到本地 Chrome CDP 代理
- 房间内回复仍通过 `send_message_to_room` 输出

## 文件位置

- `skills/web-access/SKILL.md`
- `skills/web-access/scripts/check-deps.sh`
- `skills/web-access/scripts/cdp-proxy.mjs`

## 启用方式

1. 打开 OceanKing 设置页
2. 进入对应 Agent 的 `Workspace Skills`
3. 启用 `Web Access`

启用后，运行时会先注入技能目录；模型命中该任务时，再按需读取 `SKILL.md`。

## 本机前置条件

- Node.js 22+
- Chrome 已打开 `chrome://inspect/#remote-debugging`
- 勾选 `Allow remote debugging for this browser instance`

## 环境检查

在项目根目录执行：

```bash
bash skills/web-access/scripts/check-deps.sh
```

成功时应看到类似输出：

```text
node: ok (v22.x)
chrome: ok (port <实际端口>)
proxy: ready
```

说明：
- 该脚本会优先识别当前 Chrome 实例真实调试端口
- 不再只依赖 9222 这类固定端口
- 也会避免把普通开放端口误判成可用的 Chrome CDP 入口

## 手动验证代理

如果你想单独验证代理：

```bash
node skills/web-access/scripts/cdp-proxy.mjs
```

新开一个终端，再执行：

```bash
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/targets
curl "http://127.0.0.1:3456/new?url=https://example.com"
```

若 `health` 中 `connected` 为 `true`，并且 `targets` 能列出当前 Chrome 页面，就说明已接入成功。

## 在 OceanKing 里的推荐用法

用户可以直接提这类请求：

- 帮我搜索某个主题的最新进展
- 读一下这个页面
- 去某个站点里搜索某个账号
- 打开某个后台页面并截图
- 帮我在登录态下检查某个网页元素

对应执行策略：

1. 先用 `web_fetch` 处理公开网页
2. 再用 `bash + curl` 看原始响应
3. 只有静态层不够时，才走 CDP
4. 浏览器任务结束后关闭自己新开的 tab

## 当前适配状态

已完成：

- skill 文件接入 `skills/web-access/`
- OceanKing 版 `SKILL.md` 重写
- `check-deps.sh` 调整为优先识别当前主 Chrome 实例
- `cdp-proxy.mjs` 验证可连接当前主 Chrome，并可新建 tab

未做的扩展项：

- 站点经验文件的自动读写流程
- 把 CDP 代理进一步封装成 OceanKing 一等工具
- 更细的多站点并行调研模板

这些后续都可以继续补。
