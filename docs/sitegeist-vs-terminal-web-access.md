# Sitegeist（浏览器 Agent）vs 终端 Agent：网站访问方式对比与改进建议

- 日期：2026-10-05
- 数据来源：本机 sitegeist 扩展 IndexedDB（origin `nmmodhngpcfenhbdigaiblbmlpjacani`，DB `sitegeist-storage` v3）中 **16 个真实会话**的全量消息统计（493 次 `toolCall`），辅以 `src/tools/` 源码走查
- 统计口径：`assistant` 消息中 `type=toolCall` 块计数；`toolResult` 的 `isError`/`stopReason=error`/文本 `Error` 前缀判错
- 配套图解页：`docs/show-me-sitegeist-vs-terminal-web-access.html`

## 1. 一句话结论

终端 agent 赢在**快、省、准、可批量**（一次 HTTP+Readability 拿到整页 markdown）；sitegeist 赢在**登录态、动态渲染、反爬穿透、人机兜底**（用你真实的 Chrome 和 cookie 干活）。二者不是替代关系：静态/搜索/批量走终端，登录态/动态/可视化走 sitegeist——而最优组合是终端 agent 直接通过 sitegeist MCP 调度浏览器（本报告的数据就是这么读出来的）。

## 2. 两种访问方式的调用链

### 终端 agent（pi / CLI）

```text
LLM
├─ search_web(query)        → 排名结果 + 摘要，1 次调用
├─ fetch_web(url)           → HTTP GET + Readability → markdown，1 次调用
├─ curl / 脚本              → 批量抓取、并行、精确解析（API/正则）
└─ （需要时）sitegeist MCP  → 把需要登录态/渲染的活在扩展里执行
```

### sitegeist（浏览器侧 agent）

```text
LLM
├─ navigate(url)            → 只返回 finalUrl + skills 列表（navigate.ts:254-263）
├─ repl(browserjs(fn))      → 往当前页注入 JS，自写 DOM 解析（主力，占 69%）
├─ extract_image            → captureVisibleTab 截图回传给模型看
└─ browser_workspace / skill / artifacts …
```

## 3. 实测行为指纹（16 会话 / 493 次工具调用）

### 3.1 工具分布

| 工具 | 调用 | 错误 | 备注 |
|---|---|---|---|
| repl | 338 | 21 | 绝对主力（69%），全部是手写 DOM JS |
| navigate | 58 | 2 | 几乎每次后面都要补一发 repl 才能看到内容 |
| extract_image | 26 | 5 | 截图看页面 |
| skill | 18 | 6 | 错误集中在自编辑（old_string not found ×5、缺 name ×1） |
| artifacts | 12 | 0 | 产出 md/HTML 报告 |
| browser_workspace | 1 | 0 | 严重低用（见 5.4） |

### 3.2 navigate 的 hostname 分布（top）

`www.bing.com` ×19、`www.goofish.com`（闲鱼）×9、`www.baidu.com` ×4、`fund.eastmoney.com`、`kyfw.12306.cn`、`kdb.corp.kuaishou.com`、`grafana.corp.kuaishou.com`、`xueqiu.com`、`cn.investing.com`、`m.163.com`、`www.36kr.com` 等。搜索引擎被当入口用了 23 次——每次都是 navigate + 一发解析 SERP 的 repl。

### 3.3 会话成本（top，全部实测）

| 会话 | 消息数 | tokens | 工具构成 |
|---|---|---|---|
| 关闭查询 TAB 页 | 526 | 29.7M | repl×191 + 截图×19 + skill×16，连续重复调用 max=11 |
| 闲鱼购物测试 | 167 | 3.3M | repl×41 + navigate×29，尾部 3 组「sleep(4000)+重新解析」 |
| 网站上书的内容 | 88 | 1.2M | 连续重复调用 max=6 |
| 12306 买票 | 73 | 654K | repl×28：从 onclick 抠 secretStr、勾选乘车人「陈京」 |
| 美债/基金调研 | 63 | 801K | navigate×11 + repl×15 |
| 抖音游戏 | 22 | 158K | 卡 iframe，绕道源站 URL + 轮询 |

## 4. sitegeist 的优势（均有会话证据）

| 优势 | 证据 |
|---|---|
| 真实登录态 | 闲鱼 9 次导航畅通；12306 能在乘车人列表里找到并勾选「陈京」 |
| 内网直达 | `kdb.corp` / `grafana.corp` 带着公司 SSO cookie 直接可操作，终端侧还得走 ks-cookie 鉴权 |
| 过反爬 | 百度/必应 SERP 直接可读可解析（fetch_web 抓搜索引擎常被 403/滑块拦） |
| JS 渲染 + 视觉 | SPA 内容、iframe 页面、图片/封面都能拿到（extract_image ×26） |
| 人在旁边 | 验证码/扫码/付款类动作可以交接给用户 |

## 5. sitegeist 的短板（症状 → 根因 → 建议）

这就是「还能怎么完善」的核心清单，按 ROI 排序：

| # | 症状（实测） | 根因（代码定位） | 建议 |
|---|---|---|---|
| 5.1 | 每次看页面都要 navigate 后补一发 repl；338 次 repl 尾部全是 `setTimeout(4000)` 手写轮询；`Runtime message timeout` ×5 | navigate 返回太薄：只有 finalUrl + skills，没有 title/正文预览/可交互元素概览（`src/tools/navigate.ts:254-263`） | **P0** navigate 增强返回：页面 title + 网络空闲等待 + 可交互元素概览（带 ref） |
| 5.2 | 等待全靠手写 sleep 轮询；超时错误 5 处 | repl 没有注入 `waitFor(fn, timeout)` / 网络空闲原语（`src/tools/repl/runtime-providers.ts` 只给了 browserjs/http） | **P0** repl 助手库加 `waitFor`、`waitGone`、自动滚动加载；userscripts-helpers 是现成扩展点 |
| 5.3 | 抖音 iframe 内容取不到，绕道源站 URL；上下文大（3.3M/29.7M tokens 的会话都在 repl 里整页 dump JSON） | iframe/Shadow DOM 无穿透 helper；没有「元素 ref 引用」交互模式 | **P1** helper 自动拍平同源 iframe + shadow root；a11y 概览 + ref 引用，click/type 按 ref 走 |
| 5.4 | 关标签页任务：526 msgs / 29.7M tokens，用了 191 次 repl；而 `browser_workspace.close_tabs` 本来 1-2 次调用能干完（该工具全程只被调用 1 次） | 工具选择漂移：模型不知道/不信任现成工具 | **P1** 系统 prompt / 默认 skill 写明「标签页批量操作优先 browser_workspace：list_tabs → close_tabs」 |
| 5.5 | extract_image 报 `image readback failed` ×2、`activeTab` 权限 ×1 | `captureVisibleTab` 时序竞态（页面未光栅化完成）+ activeTab 边界 | **P2** 失败自动重试（等一帧/降级 jpeg）；权限核查 |
| 5.6 | skill 自编辑 `old_string not found in library field` ×5 | 字符串精确替换太脆 | **P2** 结构化字段编辑，或模糊匹配 + 回显 diff 确认 |
| 5.7 | 遇登录墙/生成中页面只能 sleep 硬等（抖音轮询「AI 回答生成」） | 无 human-in-the-loop 信号 | **P2** 检测到墙时用 `notifications`（权限已具备）提示用户接管，而不是空转 |

## 6. 终端 agent 的优劣

### 优势
- **省**：一次 `fetch_web` ≈ 整页 markdown；对比闲鱼会话 3.3M tokens/70 次调用，同主题调研终端路径估算 5-15 万 tokens（估算值，非实测），约一个数量级差
- **快、可并行**：fetch/search 并发跑；sitegeist 每步都要过 LLM round-trip + 等页面
- **准、可复现**：API/curl/正则，脚本落盘可重跑；浏览器 GUI 操作天然脆弱（选择器漂移）
- **搜索一步到位**：`search_web` 返回结构化结果，不用 navigate 进 bing 再解析 DOM

### 劣势
- **无登录态**：闲鱼/12306/内网 SSO 全拿不下来（内网还要 ks-cookie 蹚一遍）
- **无 JS 渲染**：抖音/闲鱼/12306 查询页这类 SPA，fetch_web 拿到的是空壳
- **过不了反爬**：403、滑块、5 秒盾
- **看不到**：canvas、视频内容、截图级别的视觉判断
- **无状态交互**：不能点按钮、填表单、走多步流程

## 7. 结论：分层组合，不是二选一

决策顺序：

```text
要登录态 / JS 渲染 / 看图 / 需要人兜底？
├─ 是 → sitegeist（真实 Chrome + cookie + 截图）
└─ 否 → 终端（search_web / fetch_web / curl）
        └─ fetch_web 拿到空壳？→ 升级走 sitegeist MCP（navigate/repl/extract_document）
```

sitegeist 当前最大的提升空间不在「能不能做到」（浏览器什么都能干），而在**每次做到的成本**：把 338 次手写 JS 压成少量高阶原语（waitFor、元素概览+ref、iframe 拍平），把 29.7M token 的会话压回 30 万以内，是明确可落地的方向。
