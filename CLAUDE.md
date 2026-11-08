# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

五块看板合并成的一个单页应用：纳指QDII（页底带美股指数+七巨头行情表）、A股（最上面是宽基指数今年以来排名）、国债活跃券、70城房价、定投记录。
由 `stock-analysis` 和 `housing-price-trends` 两个仓库整合而来。

数据管道形状统一：**Python 抓取脚本 → `app/src/data/*.js`（ES module）→ React 页面**。

```
pipeline/                 抓取管道（Python 包，一律 python -m 调用，仓库根要在 sys.path 上）
  paths.py                ROOT / CACHE / DATA / WEB_DATA，全是绝对路径，不看 CWD
  stock/                  A股成交额两融 / 指数 / 国债 / 纳指期货 / 美股
  housing/                统计局 70 城房价
tests/                    离线自检（assert 脚本，无测试框架）
app/                      Vite + React 前端
data/  cache/             房价原始数据 / parquet 缓存
```

```
stock.turnover_margin 同花顺指数成交额 → turnover_data.js、东财两融 → margin_data.js → AStockPage
                      （turnover_data.js 的日期兼任 A 股交易日历，nq_overnight 读它）
stock.index_perf      腾讯/新浪/中证/同花顺 ──────────────────────→ idx_data.js    → AStockPage(最上面)
stock.bond_rate       中国货币网 ────────────────────────────────→ bond_data.js   → BondPage
stock.nq_overnight    新浪外盘 NQ  → cache/nq_min.parquet ───────→ nq_data.js     → QdiiPage
stock.us_perf         腾讯美股日线 ──────────────────────────────→ us_data.js     → QdiiPage(页底行情表)
stock.ndx_pe          worldperatio 纳指100 市盈率 ───────────────→ pe_data.js     → DcaPage(估值档位)
stock.qdii_premium    东财净值 + 腾讯日线(增量, 历史存在输出里) ──→ qdii_premium_data.js → QdiiPage(溢价走势)
housing.scrape_housing_data 统计局 → data/70城房价.json + data/raw/ ┐
housing.generate_js_data ────────────────────────────────────────┴→ housingData.generated.js → HousingPage
```

## 常用命令

```bash
source .venv/bin/activate          # Python 3.12+，依赖见 requirements.txt
export HITHINK_FINANCE_API_KEY=... # 同花顺金融数据服务(成交额 + 微盘股/可转债指数), https://fuyao.aicubes.cn/admin 自助创建
./update.sh                        # 本地跑全部抓取(all / stock / housing 三档)

# A股 / 指数 / 债 / NQ / 美股
python -m pipeline.stock.turnover_margin          # 沪深成交额(近 5 年) + 两融余额(2010 起); 全量重拉, ~2s
python -m pipeline.stock.index_perf               # 15 个宽基/特色/港股指数今年以来涨跌幅
python -m pipeline.stock.bond_rate                # 10Y/30Y 国债活跃券收益率
python -m pipeline.stock.nq_overnight             # 纳指期货隔夜涨跌 + 分时
python -m pipeline.stock.us_perf                  # 纳指100+标普500+七巨头 日/周/月/年涨跌幅
python -m pipeline.stock.ndx_pe                   # 纳指100 市盈率近 20 年百分位(定投页估值档位)
python -m pipeline.stock.qdii_premium             # 易方达纳指 159696 每日溢价率(增量; 删输出文件即全量)

# 房价
python -m pipeline.housing.scrape_housing_data --year 2026   # 抓某年（默认 2026）
python -m pipeline.housing.scrape_housing_data --all         # 抓全部年份
python -m pipeline.housing.scrape_housing_data --reparse     # 离线重解析 data/raw/，零网络请求
python -m pipeline.housing.scrape_history                    # 批量补 2021-2024 历史数据
python -m pipeline.housing.generate_js_data                  # JSON → 前端 JS 数据

# 离线自检(全部不联网)
python -m tests.test_turnover_margin     # 成交额两市相加 / 两融翻页 / 空返回抛错
python -m tests.test_nq_overnight        # NQ 隔夜窗口逻辑(合成 bar)
python -m tests.test_bond_rate           # 活跃券选取(合成成交行)
python -m tests.test_us_perf             # 日/周/月/年基准选取(合成日线)
python -m tests.test_ndx_pe              # 纳指PE 页面解析 + 20 年窗口百分位(合成 HTML)
python -m tests.test_qdii_premium        # 溢价率增量翻页 / 断档补齐 / 合并覆盖(合成净值页)
python -m tests.test_parse               # 房价 parser 回归

# 前端
cd app && pnpm dev      # 开发服务器
cd app && pnpm build    # 构建
cd app && pnpm lint     # eslint(当前零 error，别放宽)
```

改完房价 parser 的标准闭环：`--reparse` → `tests/test_parse.py` → `housing/generate_js_data.py`。不用重新联网抓。

## 整合带来的约束（改这几处前先读）

**`*_data.js` 是 Vite 源文件，不是页面直接引的 `<script>`。** 格式是 `export const X = {...};`，
写在 `app/src/data/` 下（路径统一走 `pipeline/paths.py` 的 `WEB_DATA`）。两条连带影响：
1. **数据变了必须重新构建才上线** —— 所以四条抓取 workflow 提交完都显式 `gh workflow run deploy.yml`，
   GITHUB_TOKEN 推的 commit 不会自动触发别的 workflow，少这一步页面永远是旧的。
   **`deploy.yml` 的 checkout 必须带 `ref: main`，别删。** workflow_dispatch 下 checkout 默认取
   `github.sha` —— 那是 dispatch 时刻 GitHub 解析出的 SHA，而抓取 workflow 是「push 完隔 2~3 秒
   立刻 `gh workflow run`」，赶上复制延迟就解析成 push 前那个 commit，**deploy 绿着却构建了上一版
   数据**。2026-08-04 实际发生：nq night 的 commit 没上线，页面吃的还是 6 小时前那份 `nq_data.js`，
   NQ 分时 00:43~06:00 断档（06:00 之后是前端实时 minLine 补的，所以只断中间那截，很像数据源问题）。
   同期另外 4 次同样 2~3 秒间隔都侥幸赢了，是竞态不是必现。给了 `ref` 就是 job 起来时再解析 tip。
   排查入口：`gh run list --workflow=deploy.yml --json headSha` 对一眼那次 deploy 构建的是哪个 commit。
2. `stock/index_perf.py` / `stock/qdii_premium.py` 读回自己上次的输出、`stock/nq_overnight.py` 的 `trading_days()`
   读 `turnover_data.js`，都按 `t.index("=")`…`t.rindex(";")` 切，`export const X = ` 照样命中第一个 `=`。**别在文件开头加带 `=` 或 `;` 的注释。**

**深浅两套皮是全站的，图表配色必须在 effect 里现读。** ECharts 的颜色在 `setOption` 时就烤进去了，
换肤只能 dispose 重建 —— 所以每个建图的 `useEffect` 都把 `theme` 放进依赖数组，用 `theme.jsx` 的
`vars()` / `chartTheme.js` 的 `chartColors()` 现读 CSS 变量。写死色值的图表换肤后不会变。

**`theme.css` 里同一个色值挂了两套变量名**（`--ink2` 和 `--ink-2`、`--grid` 和 `--rule`）：
股票三页和房价页各自的 CSS 里有几十处引用，给别名比改两百处引用便宜。新代码统一用无连字符那套。

**`housing.css` 的重置只能落在 `.page` 里。** 它原来是 `* { margin:0; padding:0 }` + `body{...}`，
合并成单页应用后这份 CSS 全局加载，落到 `*` 上会把股票三页的间距一起清掉。

**echarts 按需引入**：从 `app/src/echarts.js` 导入，不要 `import * as echarts from "echarts"`（全量约 1MB）。
用到新的图表类型或组件时，必须先在 `echarts.use([...])` 里注册 —— 漏注册时 echarts **不报错**，
而是静默不渲染那部分。「option 写了但没效果」先查这里。

**路由是 hash**（`#/qdii` `#/astock` `#/bond` `#/housing` `#/dca`，导航里 `dca` 排第二，
落地页是第一个）：GitHub Pages 纯静态托管，history 路由刷新会 404。
`app/vite.config.js` 的 `base` 是 `/aggregated-market-data/`，换托管方式要一起改。

**页面按 `lazy()` 切包**：每页各自 import 自己那份数据（房价 70KB…），静态引入会全挤进首屏 chunk。

**导航的窄屏断点是 860px，不是别处那个 680px。** 这个数是 7 个标签时定的：横排要 ~780px，加上深浅色开关和
左右内边距，815 以下横条就把页面顶出横向滚动条了。2026-11 先后删掉「美股纳指100」「宽基指数」后剩 5 项（6 项时这组数是 780/735），
断点没跟着收，留着余量——所以 860 以下换成汉堡 + 左侧抽屉
（`App.jsx` 里两处渲染的是同一份 `<a>` 列表）。加/改导航项要重测这个宽度。
抽屉的收起挂在链接的 `onClick` 上而不是跟着路由变：点已经选中的那一项不触发 `hashchange`。

**定投记录页（`DcaPage`）是唯一没有抓取脚本的页**：`app/src/data/dca_data.js` 是手工从券商 App
截图录入的成交流水（`[时间, 数量(负=卖出), 价格, 费用]`，金额一律现算，不存冗余列），新交易往
`trades` 末尾追一行即可，`update.sh` / CI 都不碰它。「周定投」= 每个自然周的第一笔买入（恒定）
+ 用户特别指定也算定投的买入（一周可多笔），其余买入算加仓、卖出一律算减仓（`swing()`，这几块瓦片都从 `SINCE` = 2026-06-29 起算，减仓瓦片附「加减仓差值」= 加仓 − 减仓股数）。2026-06-29 起这两类都在行尾标
`"定投"`；别凭时间金额自己猜着标额外那几笔。规则是每周至少一笔定投：整周没买入记一次缺失（本周没过完不算），之后某周定投多于一笔，
多出来的补掉一次缺失；只往回补不预存。「定投缺失」瓦片显示还欠几笔，交易明细不体现。没接交易日历，
整周休市（春节）会被误记成缺口——到时在 `DcaPage` 的 `CLOSED` 里加那周的周一。口径必须跟券商 App 一致：
**摊薄成本 = 净投入 ÷ 持仓、总盈亏 = 市值 − 净投入、净投入 = 累计买入 − 累计卖出（都含费用）**，
**不要改回移动加权平均 + 已实现盈亏那套** —— 算出来的均价（1.9539 vs App 的 1.805）和拆出来的
「已实现」都跟 App 对不上，而这页存在的意义就是对着 App 看。2026-08-25 逐位核对过：成本 1.805、
市值 97,768.00、总盈亏 +10,429.16、+11.941%、当日 +1,064.80。现价走腾讯快照（`[3]`现价 `[4]`昨收
`[30]`时间戳 `[32]`涨跌幅%，`jsonp` 注入绕 CORS），A 股开市时段 3s 轮询，拉不到退回最后一笔成交价、当日盈亏留空。
**当日盈亏按笔算（`dayPnl()`），别改回「全部持仓 × (现价 − 昨收)」**：昨日持仓按 (现价 − 昨收)、当日买入按
(现价 − 成交价)、当日卖出按 (成交价 − 昨收)，不扣费用；百分比分母 = 昨日市值 + 当日买入金额。旧算法把当天
新买的也当成昨收买的，2026-10-15 两笔买入差出 132 元（−1,827.80 vs App −1,695.80 / −3.130%，新口径逐位一致）。
「当日」取快照 `[30]` 的日期而非本机日期，周末看的是上个交易日。卖出分支 2026-10-16 对过账（卖 10700 股，+1,028.10 / +1.96% 逐位一致）：昨日持仓是倒推出来的、已含当天卖掉的股数，卖出那笔记 (成交价 − 现价) 抵掉重复部分，别改回 (成交价 − 昨收)，那样会算重（当天算出 +1,488.20）。
对账要看 App 持仓股那一行，不是账户页头——页头混着国债逆回购收益。
标的认定靠「现价 + 涨跌幅」对快照，不靠简称——同花顺的「纳100ETF」= 易方达 `sz159696`。
页底的「定投+」策略卡是手抄的用户笔记，只做展示；估值定额那排 10 档按 `pe_data.js` 高亮当前档：
`stock/ndx_pe.py` 从 worldperatio 网页里抠当前市盈率（正文那句 `calculated on`）和月度历史
（Highcharts 的 `detailPE_data`，1990 起，`Date.UTC` 月份从 0 起），百分位 = 近 20 年月度点里低于当前值的
占比（不含当月点）。**免费源只有它够 20 年**：蛋卷 `index_eva/pe_history/NDX` 每周一点但 2016 年才起，
akshare 的韭圈儿接口已删，理杏仁开放平台有 `us/index/fundamental`（实测 401 而非 404）但要付费 token。
历史是月度不是日度，对周定投换档无碍。挂在 `us.yml`（美股收盘后）`continue-on-error`，页面改版即抛错不写。

**图表零件在 `app/src/chartBase.js`，表格零件在 `app/src/table.jsx`**（`useSort` / `Pct`）。
`chartBase.js` 被 QDII / A股 / 定投三页共用，`table.jsx` 目前只有 QDII 页在用；新页面要用直接 import，别再各页复制一份。

## A股 / 美股侧的坑

- **CI 时区是 UTC**：`update.yml` 每个工作日跑两次并提交数据——UTC 08:30（北京 16:30，A 股已收盘，且港股 16:00 已收盘，`index_perf` 的恒指两条才是收盘价）为主，UTC 10:00（北京 18:00）兜底重试（国债活跃券以这趟为准，见下）。任何面向展示的时间必须用 `pd.Timestamp.now(tz="Asia/Shanghai")`，裸 `now()` 在 CI 里是零时区。
- **A 股中位数那套已撤（2026-11）**：原先 `stock/median_trend.py` 每天拉全市场 ~5540 只的涨跌幅（腾讯批量快照 / 同花顺全市场 dump / baostock 回退 / ST 名单 / `cache/daily_pctchg.parquet`）给 A股页画日中位数、累计中位数和涨跌分布/涨跌停瓦片，连同 `median_data.js`、`tests/test_tencent_parse.py`、`cache/st_codes.json` 和 baostock 依赖一起删了，页面只剩成交额和两融两张图。要找回去翻 git 历史（那份 CLAUDE.md 里有 dump 断点续传、除权还原、北交所口径这些坑）。
- **CI push 竞态**：workflow 里 push 前 `git pull --rebase`，改 workflow 时保留。
- **`cache/nq_min.parquet` 不进 git，走 `actions/cache`**（key `stock-cache-v2-<run_id>` + `restore-keys: stock-cache-v2-`，`update.yml` 与 `nq_night.yml` 共用一个 prefix）。原因：它每个工作日被全量重写提交 2~3 次，parquet 已压缩、git 不 delta 压缩，进 git 会一年年把 `.git` 撑大。可再生：未命中只断一两天分时曲线，次日 5:00 那趟补回。actions/cache 的「版本」按 `path` 列表算，**改 `path` 会让下一趟匹配不到旧缓存**（2026-11 去掉 `daily_pctchg.parquet` 那次就是），属一次性的。
- **指数 YTD 卡片**：`stock/index_perf.py` 拉 15 个宽基/特色/港股指数今年以来涨跌幅 → 导出 `idx_data.js`，`AStockPage` 最上面的 `IdxCard` 排名条形图渲染（原是独立的「宽基指数」页 `#/index`，2026-11 并进来）。源按序回退：腾讯 `fqkline`（10 个沪深指数 + 恒生指数 `hkHSI`/恒生科技 `hkHSTECH`，一次请求 400 根日线，与新浪逐日实测完全一致）→ 新浪 `stock_zh_index_daily`（akshare 封装随网站变，故降为备源；北证50 `bj899050` 腾讯只给 1 根，实际就靠它）；中证2000 `932000` 腾讯/新浪都没有，只能走中证官网 `stock_zh_index_hist_csindex`；微盘股 `883418.TI` / 可转债 `883981.TI` 是同花顺自编指数，走**同花顺官方 API**（`/a-share-index/prices/historical`，与成交额共用 `HITHINK_FINANCE_API_KEY`，客户端 `ths_get()` 在 `stock/ths.py` 里，别重写一份）。原先是直连 `d.10jqka.com.cn/v4/line/bk_*`、拿 `py_mini_racer` 跑 akshare 打包的 ths.js 算反爬 cookie `v`——全项目最脆的一处，2026-08 换掉了，两个源实测逐位一致（2026-08-20 微盘股 2082.254 / 可转债 2033.24，YTD 也都对到小数点后两位）。**这两条没有备源**（只有同花顺自己编这两个指数），拉不到就走 stale 降级。官方 API 实测**不认**中证A500 `000510.SH`、中证2000 `932000`、北证50 `899050`、恒生 `HSI`，别把它们也挪过去。「拉到了但历史不覆盖上年末基准」也算失败并换源。全源失败则复用上次 `idx_data.js` 里那条并标 `stale:true`，前端半透明 + tooltip 注明——比静默少一根条可见。CI `continue-on-error` 单独跑。**两条恒指只挂 `tx` 不挂 `sina`**：akshare 的 `stock_zh_index_daily` 是 A 股口径不认 `hk*` 代码，挂上去也只是白失败一次。**恒指是港币计价的价格指数**，与 CNY 计价的 A 股指数同图看趋势可以，严格说隔着汇率不同币种。港股 16:00 收盘（A 股 15:00），`update.yml` 的 cron 从 15:10 挪到 16:30 就是为了这两条不落到盘中价（18:00 那条本来也会覆盖）。
- **国债活跃券卡片（`BondPage`）**：`stock/bond_rate.py` 拉中国货币网现券成交（`chinamoney.com.cn/ags/ms/cm-u-md-bond/CbtPri`，akshare 的 `bond_spot_deal` 同源）→ 挑 1Y/2Y/3Y/5Y/7Y/10Y/30Y 各期限活跃券 → `bond_data.js` → 两块：10Y/30Y 大数字卡 + 各期限明细表（`.dt`），纯 HTML 无 ECharts。约束：
  - **`pageSize` 是摆设但不能填大**：填 15 照样回全市场 2998 行（~1.8MB，一次请求拿全）；填 100 直接 WAF `403`。要 UA，Referer 可有可无。
  - **活跃券按「剩余期限桶 + 当日成交量最大」挑，绝不硬编码券代码**——每季换券。桶取 `termToMaturity`（`'9.79Y'`/`'172D'` 两种后缀）：7 个桶按「新券剩余 ≈ 期限、到下次续发前一路衰减」定且互不重叠（`test_buckets_dont_overlap` 守着——重叠会让同一只券占两个期限行，表里冒出两个一样的值）。实测 2026-07-31：10Y = `260010 26附息国债10` 1.7045%（612 亿），30Y = `2600004 26超长特别国债04` 2.1870%（1143 亿）。
  - **只有 `CORE`（10Y/30Y）两个桶空了才算失败**，其余桶空了跳过、表里少一行。短端尤其 1Y 常年只有贴现国债成交（被 `is_treasury` 排除），为它整份文件不写不值。七个期限是同一份请求里挑出来的，**不额外发请求**。
  - **`dmiTtlTradedAmnt` 早盘是 `'---'`**（累计成交量还没统计），`float()` 会炸——统一走 `amount()` 按 0 算，导出时 `or None` 让前端显「—」。此时全桶并列 0，挑出来的是列表里第一只而非活跃券，所以早盘手动跑的产物别当准（CI 两条 cron 都在收盘后）。
  - **筛国债靠券名不靠代码**：名字里有「国债」且不含「贴现」（贴现国债是零息短债，报价口径不同）。别只认「附息国债」——30Y 活跃券常年是「超长特别国债」，另有「注资/续作特别国债」。量最大那只是 `26国开05`（政金债），名字里没「国债」故天然排除。
  - 收益率取 `dmiLatestContraRate`（最新成交），涨跌 `bpNum` 单位是 **bp 不是 %**，前端红=收益率上行（=债价下跌，副标题写明）。部分行只有净价没有收益率，`pick()` 跳过空值否则 `float("")` 炸。
  - **前端 3s 轮询日内刷新**（`BondPage`）：带 `bondCode=260010` 单条只回 ~850B（不带就是全市场 2998 行 1.8MB，且服务端不认 `Accept-Encoding: gzip`，浏览器轮询扛不住），逗号拼多个代码回 0 行，所以有几个期限就发几个请求（当前 7 个，一轮 ~6KB）。中国货币网回 `Access-Control-Allow-Origin: *`，浏览器直连即可——**但只能发 simple GET**，加任何自定义头都会触发 preflight，而该站 `OPTIONS` 一律 403。轮询只认券代码，**换券要等次日 CI 全量重挑**（季度级事件，隔夜够）。窗口限北京时间工作日 9:00~20:30（银行间 9:00-17:00 成交、20:00 定版），页面挂着过夜不空转。
  - **非交易日保护靠数据自带的 `showDate`，不查 baostock 日历**（`today_rows()`）：节假日/周末接口回的是上个交易日那份，按北京日期全过滤掉即空 → 不写盘正常退出。为一张卡片挂 baostock 不划算（2026-07-22 全站挂过，login 卡 2 分钟才抛），而每行本来就带成交时刻。顺带堵住「凌晨手动跑写出 `updated` 是今天、成交时间戳是昨天」那种文件。**注意接口在次日开盘前一直回上个交易日的定版数据**，所以 9:00 前跑必然跳过——CI 两条 cron（16:30 / 18:00）都在盘中，不受影响。
  - **不做 stale 机制**：每行自带 `showDate`（该券最后一笔成交时刻，前端直接显示），拉取失败就不写文件、页面留旧值，时间戳自己会露馅。
  - 银行间 9:00-17:00 交易、20:00 定版，所以 `update.yml` 的两条 cron 里 **北京 18:00 那条才是准的**，16:30 那条写的是盘中快照（会被 18:00 覆盖）。`continue-on-error` 单独跑。改 `pick()` 跑 `tests/test_bond_rate.py`（期限解析 / 量最大 / 排除政金债与桶外 / 空收益率 / 空桶抛错 / 收益率出格 / `'---'` 成交量 / 桶不重叠 / 七个桶各落到新券，全离线）。
  - 其余源实测：东财 push2 无银行间债（`100.CN10Y` 全 `rc:100`，`searchapi` 搜 `250011`/`记账式` 全空）；新浪 `bond.finance.sina.com.cn/hq/gb/daily?symbol=CN10YT` 是活跃券口径日线（7/31 收 1.695，与本源差 1bp）可作备源，但配套的 `hq/gb/min` 只有 26 个点还断档，别当分时用；中债官方曲线 `ak.bond_china_yield()` 与 `ak.bond_zh_us_rate()`（7/31 中国10Y 1.7141）是插值曲线非活跃券，T+1 晚才出；国债期货 `hq.sinajs.cn/list=nf_T0,nf_TL0`（T=10Y、TL=30Y）实时但只有价格没有收益率。
- **纳指期货隔夜卡片**：`stock/nq_overnight.py` 拉新浪外盘 NQ 分时（`GlobalFuturesService.getGlobalFuturesMinLine`，只返回当前一个盘 ~1380 根 1min），按 dt 去重累积进 `cache/nq_min.parquet`，算「前一 A 股交易日 15:00 → 当日 9:30（北京）」涨跌幅，末尾附半程点（最后交易日 15:00 → 最新 bar，`partial:true`，前端标「截至」，次日被完整点替代）→ 导出 `nq_data.js`，`QdiiPage` 顶部卡片渲染 hero 数字 + 分时曲线（无点位自动隐藏）。**`nq_data.js` 只含最新一个窗口**（`main()` 里 `overnight(...)[-1:]`）：分时曲线 `path` 本来就只挂在 `items[-1]` 上，前端拿到最后一条之后再没碰过更早的点，导出它们是纯死数据。`cache/nq_min.parquet`（模块里叫 `MIN_BARS`）同理按 `KEEP_DAYS=15` 滚动裁剪——窗口常态跨 1 天、跨周末 3 天、**国庆最长 8 天**（09-30 15:00 → 10-08 09:30），15 天是这条底线加 `nq_night.yml` 漏跑一两次的余量；不裁则每工作日 +~1300 行无上限增长，而两个 workflow 每天各重写提交一次整份 parquet。半程点盘中陈旧：`QdiiPage` 客户端直连新浪 MinLine（`<script>` 注入绕 CORS，`stock2` 接口无防盗链）开页自刷 + 每 8s 自动轮询（base 固定只重算实时价）；过了 A 股 15:00 前端 `nqRebase()` 自己换窗口（拿实时 bar 里当日 15:00 价当新基准，同 py 端 `crossed` 逻辑），否则 15:00~18:00 曲线卡在旧窗口右边界，故不再需要开盘前 CI 跑（8:45 那个已删；但见下方 `nq_night.yml`，那个是补历史 bar 的，别混淆）。新浪外盘 NQ MinLine 实测延迟约 1 分钟（当前分钟 bar 形成中），非早前标注的 10 分钟；海外期货无免费逐笔源，1min bar 已是最快。交易日历取已入库的 `turnover_data.js` 日期列（沪深有成交额的日子就是交易日；那边未收盘不写当日，所以盘中不会提前出现今天；它在 `update.yml` 里排在 `nq_overnight` 前面），CME 假日晨盘无 bar 自动跳过该日。CI `continue-on-error` 单独跑。注意 MinLine 每天 6:00 切新盘，「昨 18:00→今 5:00」的 bar 只能在切盘前抓：`nq_night.yml` cron UTC 20:00 + 21:00（北京 4:00 / 5:00）专补这段——NQ 每日 5:00 收盘，5:00~6:00 抓到的必是刚收完的完整整夜盘。**两条不是冗余**：单条的容错只有 1 小时，2026-08-28 实际发生过 Actions 迟到 3 小时（08:05 才起），旧盘已切走，曲线从前一晚 21:32 断到 06:00 且不可补（上游只留当前盘）。4:00 那条抓半程夜盘，bar 累积进 parquet，5:00 那条补尾巴；5:00 再迟到也只缺 4:00~5:00 一小时。少了它分时曲线会从上次抓取时刻断到次日 6:00（指标只需两端点，断的只是曲线）。前端 `nqClosed()` 把 CME 闭市时段（每日 5:00-6:00 维护、周六 6:00→周一 6:00）从类目轴剔除，不留空槽。东财 push2his 备选源已试过，对非浏览器请求限流断连，弃用。改 `overnight()` 前先跑 `tests/test_nq_overnight.py`（合成 bar，覆盖完整点 / CME 假日跳过 / 过 15:00 换窗 / 周末不换窗四条分支）。
- **美股行情表（`QdiiPage` 页底的 `PerfCard`）**：`stock/us_perf.py` 拉腾讯美股日线（`usfqkline/get`，`usNDX` / `usINX` + 七巨头 `usAAPL.OQ` 之类，一次 400 根 ≈1.6 年，足够覆盖上年末+上月末两个基准）→ 算今日/本周/本月/今年以来涨跌幅（`perf()`，今日那列 `cut` = 最新那根本身 → 基准是前一根）→ `us_data.js`（只有 `items`），纯静态表格不轮询，默认今年以来降序。四个口径共用 `pct(s, cut)`（cut 之前最后一根收盘为基准），本周 cut = 最新那根所在周的周一。原先是独立的「美股纳指100」页（`#/us`，另有 QQQ 前 10 大权重股 + 财报三列、行业权重两张表），2026-11 整页撤掉，这张表并进 QDII 页，权重/行业/财报的抓取（stockanalysis、纳斯达克 earnings-surprise、东财利润表）一起删了，要找回去翻 git 历史。指数走 `data.day`、个股走 `data.qfqday`（前复权，拆股后才对得上）。**基准月份/年份取自最新那根 bar 的日期而非 `now()`**：美股按纽约交易日算，北京凌晨跑 CI 时 `now()` 已是次日，月初/年初会取错基准。单只失败（含缺基准）即整体抛错不写文件（只有腾讯一个源，无处降级），页面保留上次的 `us_data.js`，CI `continue-on-error`。沿用站内红涨绿跌口径（非美股惯例）。改 `pct()` / `perf()` 前跑 `tests/test_us_perf.py`。`fetch()`（完整浏览器 UA + 3 次重试，只重 HTTP 层）留在这个模块里是因为 `ndx_pe` / `qdii_premium` 都 import 它。**cron 独立成 `us.yml`（`us-market`）**，不挂在 daily-update 上：① 美股 16:00 ET 收盘 = 北京 04:00(夏)/05:00(冬)，腾讯日线当天早上就有，daily-update 的第二条 cron（北京 18:00）对美股零增量——美股 21:30 才开盘，跑了只是白提交一次；② 周末缺口只有单独排期才能补：美东周五盘北京周六 04:00 才收，挂在 1-5 的 cron 上要等到北京周一 16:30 才上页面，陈旧 2 天半。所以是单独一条 **UTC 23:00 周一~周五 = 北京周二~周六 07:00**（一天一次，正好盖住美股 5 个交易日的收盘，无重复）。**别写成 `0-4`（北京周一~周五 07:00）**：北京周一之前最近的美股盘就是周五，行情与周六那次全同，白跑一趟；丢了周六那次周末又挂 2 天半陈旧数据。**07:00 不是 06:00** 是为冬令时留余量：收盘后腾讯日线约 2 小时可用（北京 06:12 实测抓到当日线），06:00 冬天只剩 1 小时；Actions cron 实测延迟 11~71 分钟，07:00 落地在 07:10~08:15。代价是没有 18:00 那次免费重试，单次失败要等下一个工作日——所以 GET 都包了重试。**`us_data.js` 刻意不带 `updated`**：那是脚本跑的时刻不是数据的时刻，空跑也照样刷新；每行自带的 `date` 才是真口径，想知道 CI 何时跑的看 git log。
- **全市场成交额（`AStockPage` 第二张图，指数排名下面）**：`stock/turnover_margin.py` 的 `export_turnover()` 拉同花顺 `/a-share-index/prices/historical`（与微盘股/可转债同一个接口，返回体里除 `close_price` 外还带 `turnover`（成交额，元）和 `volume`，白拿）→ 沪 `000001.SH` + 深 `399001.SZ` 相加 → `turnover_data.js`（近 5 年日频，1210 天，25KB）。页面上有区间筛选（今年以来 / 近 1、3、5 年，默认今年以来，`select.pick` 下拉框），成交额、两融各一个 effect，换区间只重建那一张。约束：
  - **深证成指返回的是全深市成交额而不是成分股**（与深证综指 `399106` 逐位一致，也与东财 push2his 对得上），所以两个代码就够，别去凑成分股。**北交所拿不到**（`899050` 无论 `.BJ` 还是 `.SH` 都回 `Unknown thscode`），占比 <1%，图注里写明不含。
  - **窗口超 ~5 年会静默回空而不是报错**：实测 `TURNOVER_DAYS=1826` 天回 1210 根，1830 天回 0 根；跨 10 年时它 `code=1003` 说的 "at most 10 years" 是骗人的（6 年就空了）。所以拿到空 item 必须抛错，别写出一份空数据；要更长历史只能按 5 年分段拼。
  - **不带 `updated` 字段**（同 `us_data.js`）：节假日重跑数据一模一样，有时间戳就每次都是新字节，白刷一次 commit。数据到哪天看 `dates[-1]`。
  - **这个接口只服务「截止到今天的 5 年内」**：窗口整段落在过去一律回空（2020 整年、2015 整年、1995 整年实测都是空），分段拼历史这条路走不通。所以页面上没有「全部」档，最长就是近 5 年。真要更长的历史只能上东财 `push2his`（`secid=1.000001`/`0.399001`，`fields2` 带 `f57` 成交额，一次给 8716 根，1990-12-19 起，实测 2015-05-28 天量 2.363 万亿），**但它限流狠**——连打五六次就 `RemoteDisconnected`，接的话得包重试 + 把老历史存进文件别每天重拉（2026-09 试过这套，为一个跟「近 5 年」重复的按钮不值，撤了）。
  - **20 日均线不落文件，前端现算**：区间切片后仍要按完整序列算均线（不然「今年以来」档前 19 个交易日空一截），存一份反而两头对不齐；顺带省 30% 体积。
  - 盘中跑丢掉最后那天（半天成交额画出来是一根假地量柱）。成交额、两融在 `main()` 里各包一层 try/except：一个拉不到就不写那份、页面留上次的，另一个照写；任一失败退出码非 0，workflow 那步 `continue-on-error`（本地没 `HITHINK_FINANCE_API_KEY` 时成交额走的就是这条）。改这块跑 `tests/test_turnover_margin.py`（两市相加 / 空返回抛错）。
  - 对过账：2026-01-14 峰值 3.941 万亿、2024-08-13 谷值 0.477 万亿、2026-09-01 收 2.033 万亿（= 东财的沪 9443 亿 + 深 10891 亿），与公开数据一致。
- **两融余额（`AStockPage` 下面那张图）**：`stock/turnover_margin.py` 的 `export_margin()` 拉东财 datacenter 报表 `RPTA_RZRQ_LSHJ`（沪深两市融资融券汇总）→ `margin_data.js`（2010-03-31 起全历史，3989 天，105KB）。图是双轴：两融余额（万亿，蓝，左轴）+ 融资余额占流通市值比（%，黄，右轴），自带一排区间筛选（比成交额那张多一档「全部」，因为数据够）。约束：
  - **同花顺没有两融**：`/margin/*`、`/rzrq/*`、`/a-share/margin*`、`/meta/*` 全 404，它只开放指数行情和全市场 dump。所以这条**只有东财一个源**，拉不到就 try/except 跳过、页面留上次那份（同成交额）。
  - **`pageSize` 上限 800**：填 5000 既不报错也不多给，必须按 `result.pages` 翻页（当前 5 页）。少翻一页就是静默丢掉最近三年。实测 5 次请求 1.1s、**不限流**——它和限流狠的 `push2his` 不是同一个端点，别照那个的经验加节流。
  - **占流通市值比那条线不能省**：2026-06-25 余额 3.033 万亿是历史新高，占比才 2.81%；2015-07-03 占比峰值 4.70% 时余额只有 1.91 万亿。只画余额会得出「杠杆比 2015 还疯」的反结论。反过来**融券余额不导出**（293 亿 vs 融资 2.64 万亿，画上去是条贴着 x 轴的线）。
  - **两条轴都从 0 起**，右轴还钉了 `max ≥ 5`（2015 峰值 4.70%）：各自 `scale` 会把「余额创新高而占比没跟上」这唯一值钱的信息抹平，而万亿和 % 两个数量级撞在一起时两条线会叠成一根。
  - **这张图恒定比同页成交额慢一天**，不是故障：交易所收盘后当晚才公布当日余额，`update.yml` 两条 cron（北京 16:30 / 18:00）都赶不上。每趟都全量重拉，缺的次日自己补齐，所以别为它单加 cron，也不做增量。
  - 同 `turnover_data.js` **不带 `updated`**（节假日重跑数据一样，有时间戳就白刷一次 commit）。对过账：上交所官网 2026-08-31 沪市融资余额 1.3475 万亿，东财两市合计 2.6355 万亿；`RZRQYE == RZYE + RQYE` 逐位相等，3989 行零重复零空值。改这块跑 `tests/test_turnover_margin.py`（翻页翻全 / 空返回抛错）。
- **场内 QDII 溢价率走势（`QdiiPage` 的 `PremCard`，易方达纳指 159696，名单在 `FUNDS`）**：`stock/qdii_premium.py` 拉东财净值 `api.fund.eastmoney.com/f10/lsjz`（**必须带 `Referer: fundf10.eastmoney.com`**，不带 `Data` 回 null、HTTP 照样 200；`pageSize` 填多大都只给 20 条）+ 腾讯 `fqkline` **不复权** `day`（单位净值也不复权，两边同口径）→ `qdii_premium_data.js` 只存 `dates/close/nav`，溢价率 = 收盘 ÷ 净值 − 1 在前端现算。约束：
  - **增量，历史就存在输出文件里**：溢价率是同一天两个数的比值，算出来就定死了（拆份额两边一起变），所以每次读回上次的输出，只拉净值第 1 页（20 条 ≈ 4 周）+ 那段起的日线，按日期合并、同日新的覆盖旧的（盖住东财偶尔修正的近几天净值）。这页最老一条都比历史末日新就继续翻页直到接上（CI 断了一个多月也能自己补齐）。**输出文件丢了/坏了就是全量**（39 页，~8 秒），所以「别在文件开头加带 `=`/`;` 的注释」那条这里同样适用（`nq_overnight.trading_days()` 读 `turnover_data.js` 也是这个切法）。
  - 腾讯日线走**裸域 `ifzq.gtimg.cn`**（同 `QdiiPage` 的 `useBase`），这个域名下 `param` 的起始日真按日期截，增量时只回那几根。
  - **曲线恒定比行情晚一天**：QDII 的 T 日净值 T+1 才公布，当天只有价格没净值的那天被内连接丢掉、下次补上。净值表里 `2023-12-31`/`2024-06-30` 这种半年末估值行同样被内连接丢掉。
  - **假尖刺是口径本身，不是数据坏了**：A 股 15:00 收盘，T 日净值按美股当晚收盘算，美股当晚暴涨暴跌就出一根（2025-04-09 关税暂停那晚美股 +12%，当天算出 −9.2%），集思录也是这个口径，卡片副标题写明。`sanity_check()` 卡 −30%~+80%（折价实测最深 −9.2%，溢价实测 +19.1%；额度紧时场内 QDII 溢价能冲到 +39%，所以上限留宽），出格说明复权口径或单位错位。
  - 挂 `update.yml`，`continue-on-error`，不带 `updated`（同 `turnover_data.js`）。改翻页/合并跑 `tests/test_qdii_premium.py`。

## 房价侧的坑

**主指数表必须解析出 70 城，少了就 raise。** 表格是双栏并排（左 35 城 + 右 35 城），列数靠 `parse_main_index_table` 从首行推断（6 列 / 8 列）。推断错会只吃到左半栏，静默落盘 35 城残缺数据 —— 2026-01 真发生过。`EXPECT_CITIES` 断言就是防这个，不要为了「让它先跑通」把断言放宽。

**原始 HTML 必须存档，解析失败也要存。** `data/raw/YYYY-MM.html.gz`（gzip，1.4MB → ~140KB，才进得了 git）。统计局改版或撤稿后，靠它离线复现 + `--reparse`，不用重抓。写入时必须 `mtime=0`（`save_raw` 里）—— gzip 默认把当前时间写进文件头，同样的 HTML 每次压出来字节都不同，git 会把内容没变的存档全标成 modified，自动更新流程就没法靠 diff 判断有没有新数据。

**`housingData.generated.js`（生成）和 `housingData.js`（手写辅助函数）必须分开。** 早前混在一个文件里，重跑 generator 把手写函数全冲掉了。generated 文件只导出数据，js 文件 re-export 数据 + 加函数。

**数据文件只有一份 `data/70城房价.json`，按 (年, 月) 去重合并写入**（`merge_save`），不带时间戳。多份带时间戳的文件会让下游按 glob 顺序随机选中版本。

**抓取是增量的**（`existing_months()`）：已抓过的月份跳过，不重复下载。「已抓过」= 数据文件里有该月 **且** raw 存档还在，两个条件缺一不可 —— 只看数据文件的话，存档丢了的月份会被永久跳过再也补不回来。强制重抓用 `--force`。

**「没有新数据」必须正常退出，不能 `sys.exit(1)`。** 每月定时任务在统计局发布前跑到这里是常态，报错会让 CI 天天报红。只有真正抓取失败（`failures`）才退出非 0。

**城市分级只有三档：一线 4 / 二线 31 / 三线 35**（`housing/generate_js_data.py` 的 `CITY_TIERS`，国家统计局口径）。不要自造四线/五线，那对不上公报也无法对外解释。

### 房价数据形状

`data/70城房价.json`：list of entry，每 entry 一个月：
```
{year, month, pub_date, url, title,
 new_house: {城市: {环比, 同比, 平均}},      # 指数，上月=100
 second_hand: {...},
 new_house_by_area: {城市: {"90m²及以下": {...}, "90-144m²": {...}, "144m²以上": {...}}},
 second_hand_by_area: {...}}
```

前端只用「环比」。`dataByYear[year] = { months, newHouse: {城市: [每月环比]}, secondHand: {...} }`。
`HousingPage` 直接用 echarts 命令式 API（`useRef` + `useEffect`）。
