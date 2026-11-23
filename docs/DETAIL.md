# 稳定上网（dsh-net-stable）

插件向 `ctx.web` 注册抓取提供方 `resilient`，向模型提供 `net_doctor` 工具，并在内存里记录最近 60 次抓取。

## 抓取阶梯

1. 原地址，`retries + 1` 次，轮流使用宿主代理 dispatcher 与直连 agent；
2. 仍失败则按镜像回退：`raw.githubusercontent.com`、`cdn.jsdelivr.net/gh/`、`github.com/.../raw/...`
   依次尝试 `ghproxy.net`、`jsDelivr`、GitHub contents API；
3. 全部失败时抛出列出每次尝试的错误，而不是一句 `fetch failed`。

HTTP 4xx 作为结果返回，不触发换路线；5xx/429 会尝试下一条路线，全失败时返回最后一个响应。

## net_doctor

**带 URL**：依次检查 DNS、TCP、TLS、HTTP，把「代理路径」与「直连」的结果并列，最后给一句结论：

- TLS 握手被打断 → 链路层阻断/SNI 干扰，与站点风控无关；
- 只有直连可用 → 本机代理在干扰该域名；
- 站点返回 403/429 → 站点限流或机器人校验；
- 全部路径失败 → 需要用镜像或更换出口。

首行 `0. engine undici=ok|missing` 说明抓取引擎是否拿到了 Harness 自己那份 `undici`；
`missing` 时插件退化为只用 `globalThis.fetch`，重试与镜像仍然生效。

**不带 URL**：输出引擎状态、当前配置、代理变量，以及最近抓取（时间、结果、走哪条路、耗时、
尝试次数、原始 URL 与最终 URL）。用于事后复盘：某次抓取到底失败在哪一步。

## 限制

- 不加密流量、不更换出口 IP，不是反审查工具；
- 镜像只发送 URL，不发送请求体，但 URL 路径会到达第三方；
- 二进制/PDF 仍不支持；跨源重定向不自动跟随；
- 不改变模型流式连接与 `web_search`；
- 抓取日志只在内存中，进程退出即失。
