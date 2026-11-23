# dsh-net-stable

给 DeepSeek Harness 的 `web_fetch` 加一层韧性：**失败重试、代理坏了自动直连、GitHub 文件地址走镜像**，外加一个能把"到底卡在哪一段"说清楚的 `net_doctor`。

零依赖、无构建步骤、不改内核，纯 Host 插件。MIT。

| 贡献 | 作用 |
|---|---|
| Fetch provider `resilient` | 替代内置 `http` 抓取器：重试 + 直连回退 + 镜像回退 + 逐次尝试留痕 |
| Tool `net_doctor` | 带 URL：DNS → TCP → TLS → HTTP 分段体检；不带 URL：查看最近的抓取日志与引擎状态 |
| 抓取日志 | 内存里保留最近 60 次抓取（不落盘、不上传），失败时可以直接看"哪条路、几次、多久、什么错" |

## 它解决什么

| 现象 | 内置抓取器 | 本插件 |
|---|---|---|
| `raw.githubusercontent.com` 的 TLS 被重置（`fetch failed`，无状态码） | 直接失败 | 原地址重试 → `ghproxy.net` → `jsDelivr` → `api.github.com/contents` |
| 系统代理时好时坏 | 直接失败 | 交替走代理 dispatcher 与自建直连 agent |
| 不知道是谁挡的 | 只有一句 `fetch failed` | `net_doctor` 指出是 DNS / TCP / TLS / 站点限流 |
| 事后想复盘 | 没有记录 | `net_doctor` 不带参数即可看最近抓取 |

## 安装

三种方式，任选其一。装完重启一次。

**1. 插件管理器（桌面端推荐）**

设置 → 插件 → Add plugin → 选择本目录。

**2. 命令行（纯 `dsh web` profile）**

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-net-stable
```

**3. 直接从 GitHub 安装**

```bash
dsh plugin --profile <profile> add github:<owner>/dsh-net-stable
```

> 安装后本插件的 patch 会把内置 `web` 条目的 `fetchProvider` 指向 `resilient`。
> 想换回内置抓取器：**设置 → 插件 → Web search and fetch → Fetch provider → Direct fetch (http)**，
> 或删掉 `cordis.patch.yml` 的第二个 patch 条目。
>
> 为什么必须 pin：`ctx.web` 在"存在两个可用 provider 且未指定"时会抛
> `WEB_PROVIDER_AMBIGUOUS`，多注册一个 provider 而不 pin 会让所有 `web_fetch` 失败。

## 快速验证

```bash
node test/run.mjs        # 15 个离线用例：重试、镜像、截断、诊断、日志（不出网）
node scripts/smoke.mjs   # 真实网络：origin 失败 → 镜像成功
node scripts/bench.mjs   # 10 站 × 2 轮真实抓取，输出 scripts/bench-results.json
```

## 诊断

**带 URL** —— 逐段体检，代理路径与直连并排对比：

```
net_doctor https://raw.githubusercontent.com/<owner>/<repo>/main/README.md
0. engine   undici=ok (proxy-aware dispatcher available)
1. DNS      ok 1 ms → 185.199.110.133 (v4), ...
2. TCP      ok 185.199.110.133:443 60 ms
3. TLS      FAILED 91 ms → ECONNRESET
4. HTTP(proxy path) FAILED 93 ms → fetch failed (ECONNRESET)
5. HTTP(direct)     FAILED 91 ms → fetch failed (ECONNRESET)
6. proxy    no HTTP(S)_PROXY / ALL_PROXY in this process environment
7. verdict  TLS 握手被打断（ECONNRESET）：链路层阻断/SNI 干扰，不是站点风控
8. mirrors  fallback routes this plugin will try when the origin fails:
   - ghproxy: https://ghproxy.net/https://raw.githubusercontent.com/...
```

**不带 URL** —— 引擎状态 + 最近抓取日志：

```
net_doctor
3. totals   12 recorded, 8 ok, 2 http-error (4xx/5xx), 2 transport-failure, 2 via mirror
4. recent   newest first
   - 19:41:02 HTTP 200 origin 112 ms (1 attempts) https://www.qq.com
   - 19:40:55 HTTP 200 ghproxy 6135 ms (3 attempts) https://raw.githubusercontent.com/...
     ↳ answered by https://ghproxy.net/https://raw.githubusercontent.com/...
   - 19:40:41 FAIL WEB_PROVIDER_ERROR origin 16012 ms (2 attempts) https://example.invalid/
```

## 配置

插件行 `config` 全部可选：

```yaml
- id: net-stable
  name: dsh-net-stable
  config:
    retries: 2                     # 原地址额外重试次数
    retryDelayMs: 450              # 指数退避基数
    perAttemptTimeoutMs: 20000     # 单次尝试上限
    totalBudgetMs: 45000           # 整条阶梯总预算
    maxResponseBytes: 5000000
    maxBodyChars: 100000
    useDirectFallback: true        # 代理失败时改用直连 agent
    useMirrors: true
    mirrors: { ghproxy: true, jsdelivr: true, contentsApi: true }
    extraMirrors:                  # 自定义镜像规则（正则替换）
      - match: '^https://example\.com/(.*)$'
        to: 'https://mirror.example.net/$1'
    userAgent: 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'
```

## 实测（2026-11-23，本机直连出口）

10 个站点 × 2 轮 = 20 次 `web_fetch`，走的就是本插件的引擎：

| 站点 | 第 1 轮 | 第 2 轮 | 路由 / 说明 |
|---|---|---|---|
| bilibili.com | 200 · 166 ms | 200 · 190 ms | origin；返回的是 JS 外壳（1.4 KB） |
| zhihu.com | 403 · 274 ms | 403 · 138 ms | **站点侧反爬**，非链路问题 |
| tieba.baidu.com | 403 · 129 ms | 403 · 146 ms | **站点侧反爬**，非链路问题 |
| baidu.com | 200 · 118 ms | 200 · 281 ms | origin；302/JS 跳转页 |
| github.com 仓库页 | 200 · 3.8 s | 200 · 4.8 s | origin（581 KB 页面） |
| raw.githubusercontent.com | 200 · **12.7 s** | 200 · **6.1 s** | 第 1 轮 5 次尝试后走 `contents-api`；第 2 轮 3 次尝试后走 `ghproxy` |
| 163.com | 200 · 56 ms | 200 · 48 ms | origin |
| douban.com | 200 · 201 ms | 200 · 107 ms | origin |
| taobao.com | 200 · 74 ms | 200 · 77 ms | origin |
| qq.com | 200 · 211 ms | 200 · 203 ms | origin |

汇总：**16/20 成功（80%）**，2 次走镜像；正常站点 p50 延迟 **190 ms**、平均 1 次尝试即成功；
唯一的高延迟出现在被阻断的 GitHub 裸文件域名上（镜像救回，但要多花 6–13 秒）。

**怎么读这组数**：

- 插件对**正常站点几乎没有开销**——命中就是一次请求，毫秒级。
- 镜像不是加速器，是**兜底**：只在原路走不通时启用，代价是 6–13 秒。
- 知乎/贴吧的 403 是站点对非浏览器客户端的拦截，插件如实返回 HTTP 结果（不伪装成错误、
  也不假装成功）。这类页面需要真浏览器；本插件不解决，也不该由它解决。
- bilibili/baidu 的 200 但响应体很小，是 SPA 外壳或跳转页；`web_fetch` 本来就只取 HTML，
  不执行 JS。

## 行为边界

- 只在**传输层失败**（连接重置/超时/DNS）时换路线；HTTP 4xx 是结果不是错误；5xx/429 会先记下
  再试下一条路线，全失败时返回最后一个 HTTP 响应。
- 内容类型白名单与内置一致（`text/*`、HTML、JSON、XML）；二进制、PDF 不支持。
- 跨源重定向不自动跟随；只有文件下载形态（`/raw/`、raw 主机、jsDelivr `/gh/`）才走镜像。
- 镜像意味着 **URL 路径会发给第三方**（`ghproxy.net`、`cdn.jsdelivr.net`、GitHub API），不发请求体；
  敏感路径请关掉 `useMirrors`。
- **不是反审查工具**：不加密流量、不换出口 IP；整体不通的域名救不了。
- 不改变 `web_search`，也不改变模型流式连接。
- 抓取日志只在内存里，进程退出即失，不落盘、不上传。

## 维护注意

`cordis.patch.yml` 里有一条 `id: web` 的覆盖，把内置 `web` 条目的配置整体替换为
`fetchProvider: resilient`。这是 DSH loader 的语义：**同名覆盖是整段替换，不是合并**。

- 如果将来的 DSH 版本给 `web` 增加了别的配置项，这条覆盖会把它们一起清掉；
  届时需要把新字段原样抄进来（或以设置页里的 provider 选择代替这条覆盖）。
- 上游若修改 `WEB_PROVIDER_AMBIGUOUS` 规则，这条 pin 的原因也随之失效，可以删掉它。

## 兼容性

- DSH `0.2.x`（在 `0.2.2-rc.5` 桌面版实测），Node `^22.19 || >=24`。
- 依赖 Harness 自己那份 `undici` 来获得"代理感知"和"直连 agent"；解析不到时自动退化为只用
  `globalThis.fetch`，重试与镜像仍然工作，`net_doctor` 首行会显示 `undici=missing`。

## 结构

```
index.js              注册 provider 与 net_doctor，维护抓取日志
cordis.patch.yml      挂载插件并 pin fetchProvider
src/core.js           重试 / 直连 / 镜像阶梯，内容解码，错误分类（无 DSH 依赖）
src/doctor.js         DNS/TCP/TLS/HTTP 分段诊断与结论
src/journal.js        最近抓取记录与状态报告
src/errors.js         Harness 形状的 WebError（profile 插件解析不到内置包）
src/undici.js         从 DSH 安装目录解析 undici（asar 内）
test/run.mjs          15 个离线用例
scripts/smoke.mjs     真实网络冒烟
scripts/bench.mjs     10 站 × 2 轮基准
```

## License

MIT，见 [LICENSE](LICENSE)。
