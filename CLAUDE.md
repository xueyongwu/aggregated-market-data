# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

六块看板合并成的一个单页应用：纳指QDII、美股纳指100、A股中位数、宽基指数、国债活跃券、70城房价。
由 `stock-analysis` 和 `housing-price-trends` 两个仓库整合而来。

数据管道形状统一：**Python 抓取脚本 → `app/src/data/*.js`（ES module）→ React 页面**。

```
pipeline/                 抓取管道（Python 包，一律 python -m 调用，仓库根要在 sys.path 上）
  paths.py                ROOT / CACHE / DATA / WEB_DATA，全是绝对路径，不看 CWD
  stock/                  A股 / 指数 / 国债 / 纳指期货 / 美股
  housing/                统计局 70 城房价
tests/                    离线自检（assert 脚本，无测试框架）
app/                      Vite + React 前端
data/  cache/             房价原始数据 / parquet 缓存
```

```
stock.median_trend    同花顺 dump/腾讯快照 → cache/daily_pctchg.parquet → median_data.js → MedianPage
stock.index_perf      腾讯/新浪/中证/同花顺 ──────────────────────→ idx_data.js    → IndexPage
stock.bond_rate       中国货币网 ────────────────────────────────→ bond_data.js   → BondPage
stock.nq_overnight    新浪外盘 NQ  → cache/nq_min.parquet ───────→ nq_data.js     → QdiiPage
stock.us_perf         腾讯美股/纳斯达克/东财 ────────────────────→ us_data.js     → UsPage
housing.scrape_housing_data 统计局 → data/70城房价.json + data/raw/ ┐
housing.generate_js_data ────────────────────────────────────────┴→ housingData.generated.js → HousingPage
```

## 常用命令

```bash
source .venv/bin/activate          # Python 3.12+，依赖见 requirements.txt
export HITHINK_FINANCE_API_KEY=... # 同花顺金融数据服务(A股中位数的股票池/历史源), https://fuyao.aicubes.cn/admin 自助创建
./update.sh                        # 本地跑全部抓取(all / stock / housing 三档)

# A股 / 指数 / 债 / NQ / 美股
python -m pipeline.stock.median_trend             # 有缓存则直接导出; 无缓存走同花顺全市场 dump(~1分钟)
python -m pipeline.stock.median_trend --update    # 收盘后增量: 腾讯批量快照拉当日(~1.5s)，缺口时用同花顺 10 日 dump
python -m pipeline.stock.median_trend --refresh   # 删缓存全量重拉
python -m pipeline.stock.index_perf               # 15 个宽基/特色/港股指数今年以来涨跌幅
python -m pipeline.stock.bond_rate                # 10Y/30Y 国债活跃券收益率
python -m pipeline.stock.nq_overnight             # 纳指期货隔夜涨跌 + 分时
python -m pipeline.stock.us_perf                  # 纳指100+七巨头+权重股+财报

# 房价
python -m pipeline.housing.scrape_housing_data --year 2026   # 抓某年（默认 2026）
python -m pipeline.housing.scrape_housing_data --all         # 抓全部年份
python -m pipeline.housing.scrape_housing_data --reparse     # 离线重解析 data/raw/，零网络请求
python -m pipeline.housing.scrape_history                    # 批量补 2021-2024 历史数据
python -m pipeline.housing.generate_js_data                  # JSON → 前端 JS 数据

# 离线自检(全部不联网)
python -m tests.test_tencent_parse       # 快照解析 + baostock 降级
python -m tests.test_nq_overnight        # NQ 隔夜窗口逻辑(合成 bar)
python -m tests.test_bond_rate           # 活跃券选取(合成成交行)
python -m tests.test_us_perf             # 月/年基准选取 + 财报解析(合成日线)
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
2. `stock/us_perf.py` / `stock/index_perf.py` 的降级读回（`last()` / `last_good()`）按 `t.index("=")`…`t.rindex(";")`
   切自己上次的输出，`export const X = ` 照样命中第一个 `=`，没改这两个函数。**别在文件开头加带 `=` 或 `;` 的注释。**

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

**路由是 hash**（`#/qdii` `#/us` `#/median` `#/index` `#/bond` `#/housing`，
落地页是第一个）：GitHub Pages 纯静态托管，history 路由刷新会 404。
`app/vite.config.js` 的 `base` 是 `/aggregated-market-data/`，换托管方式要一起改。

**页面按 `lazy()` 切包**：每页各自 import 自己那份数据（房价 70KB…），静态引入会全挤进首屏 chunk。

**导航的窄屏断点是 780px，不是别处那个 680px。** 6 个标签横排要 ~600px，加上深浅色开关和
左右内边距，735 以下横条就把页面顶出横向滚动条了——所以 780 以下换成汉堡 + 左侧抽屉
（`App.jsx` 里两处渲染的是同一份 `<a>` 列表）。加/改导航项要重测这个宽度。
抽屉的收起挂在链接的 `onClick` 上而不是跟着路由变：点已经选中的那一项不触发 `hashchange`。

**图表零件在 `app/src/chartBase.js`，表格零件在 `app/src/table.jsx`**（`useSort` / `Pct`）。
拆成多页后这些被三四个页面共用，别再各页复制一份。

## A股 / 美股侧的坑

- **CI 时区是 UTC**：`update.yml` 每个工作日跑两次 `--update` 并提交数据——UTC 08:30（北京 16:30，A 股收盘后腾讯快照早已可用，且港股 16:00 已收盘，`index_perf` 的恒指两条才是收盘价）为主，UTC 10:00（北京 18:00）兜底（万一 16:30 落到 baostock 回退分支，那时 baostock 当日数据还没出，~17:30 才有）。任何面向展示的时间必须用 `pd.Timestamp.now(tz="Asia/Shanghai")`，裸 `now()` 在 CI 里是零时区。
- **`--update` 主源是腾讯批量快照**（`qt.gtimg.cn/q=` 逗号拼代码，每请求实测上限 900 只、取 800，全市场 7 请求 ~1.5s；字段 `[6]`成交量 `[30]`时间戳 `[32]`涨跌幅%，GBK 编码）。三条硬约束：① 停牌股返回 `pct=0.00` 而非空，必须按 `成交量>0` 剔，否则中位数被 0 拉偏；② 校验 `[30]` 时间戳日期等于目标日，防隔日跑写进陈旧价；③ **未收盘不落库**——盘中快照会被当成收盘价写死，次日 `--update` 只取新一天不回补。与 baostock qfq 口径实测 30 股 0 偏差。
- **历史与补缺口走同花顺全市场 dump（`fetch_history_dump()`）**：三个签名端点各回一个 **5 分钟就过期的 S3 预签名 URL**，拿到立刻下，别缓存 URL。`daily-k` 全量 ~171MB / 1022 万行 / 近 10 年，`daily-k-10d` ~1MB / 最近 10 交易日，`adjustment-factors` ~0.3MB / 全部除权事件。实测全量重建 155 个交易日约 40~100 秒，逐股 baostock 要 10-20 分钟。要环境变量 `HITHINK_FINANCE_API_KEY`（CI 里是同名 secret），响应信封 `code==0` 才算成功、**HTTP 200 不代表成功**。两个必踩的坑：
  - **必须断点续传, 别整份重下**：2026-08-24 在 GitHub runner 上实测 171MB 拉到 5.6MB 就 `IncompleteRead` 断流（跨境大文件），当时整条降级去了 baostock 逐股、跑出 5200 只的窄口径差点覆盖好数据。S3 回 `Accept-Ranges: bytes`（实测 206），所以 `ths_dump()` 流式写盘 + 断在哪从哪续，签名过期（403）就重签接着续；连着两轮零字节才放弃。改这块跑 `tests/test_tencent_parse.py::test_dump_resumes_after_broken_download`。
  - **`date_ms` 是北京零点的毫秒戳**，直接 `pd.to_datetime(unit="ms")` 读出来是 UTC 16:00、日期整体退一天——交易日列表里会凭空冒出周日。统一走 `ths_date()`。
  - **dump 是未复权价**，除权日直接 `close/prev` 算出假暴跌（实测单只最大偏 4.6pp，分红季每天几只到十几只）。用同一份数据的复权事件还原：`(收盘*(1+每股送股) + 每股分红) / 前收盘 - 1`。配股不还原（2026 全年只有 1 例）。同一 `(代码, 除权日)` 偶有多行（5.7 万行里 3 例）：完全相同的先 `drop_duplicates`，剩下的求和——不合并的话 merge 会把那只票当天的行复制一份混进中位数。修正后与站内既有序列逐日对账 153 天，中位数最大差 0.007pp。
- **回退 baostock 逐股的情形**：同花顺 dump 也失败时才走（全量慢 10 倍，且**没有北交所**，池子少 ~340 只）。`--update` 的分支顺序是：腾讯当日快照 → 缓存有缺口/腾讯挂 → 同花顺 10 日 dump → 它也挂 → baostock 窗口重拉（**baostock 当日数据 ~17:30 后才可用**，cron 时间是配合这个定的）。腾讯 15:00 收盘即出，若哪天想把 cron 提前，得先确认不会落到回退分支。
- **baostock 挂了也要能出数（`update_incremental()`）**：2026-07-22 实际发生过——baostock 全站不可用，login 卡 2 分多钟后抛错，而当时数据主源已经是腾讯，却被日历/代码表这两个辅助调用整条拖死。现在 login 失败即降级：代码表退回 parquet 里最近交易日那份（漏掉当天新上市的几只，5000 只样本的中位数无感），交易日判断交给腾讯快照自己——节假日快照返回上个交易日的陈旧时间戳，`parse_tencent_quotes` 的日期校验会全过滤掉，覆盖率 0 自然不写。此时**不再回退 baostock**（它本来就挂着）——但会先试同花顺 dump（独立源，不受 baostock 影响）。**dump 分支必须校验 `end` 在返回的日期里**：非交易日或当日还没定版时 dump 只回历史，照样导出就是拿新 `updated` 白刷一次 commit。改这块前先跑 `tests/test_tencent_parse.py`（覆盖正常/缺口走 dump/dump 挂了回退 baostock/dump 没有当天/非交易日/降级出数/降级不写，全离线）。
- **A股代码过滤**：`A_PREFIXES = ("sh.6", "sz.0", "sz.30", "bj.92")`，口径是**全量 A 股含北交所**（~5545 只，2026-08 从 5207 扩的）。必须用 `sz.30` 而非 `sz.3`（否则 `sz.399*` 深证指数混入）、`bj.92` 而非 `bj.9`。不含 B 股。**北交所 baostock 根本不提供**，代码表和历史都只能从同花顺来（见下条）——所以 baostock 降级路径出的数会少 ~340 只，属于临时降级不是常态。2024 年起北交所代码统一迁到 920 段，dump 里只有这一段。
- **停牌剔除**：baostock 停牌日 `pctChg` 为空字符串，拉取时已过滤。
- **非交易日保护**：`--update` 先走 `trading_days()`，节假日空跑不写脏数据（`is_trading_day()` 是它的单日包装）。
- **baostock 会话**：`bs_session()` 是可嵌套的全局单例，login 握手要 1 秒多，别再在函数里各 login 一次；`--update` 全流程共用一次登录（29s → 15s）。
- **ST 名单缓存**：`st_codes()` 结果写 `cache/st_codes.json` 存 7 天并入库，源是同花顺代码表（名字白送，且含北交所那 3 只 ST）。原先走 baostock `query_stock_basic()`（拉 5000+ 行，本脚本最慢的单次调用，且没有北交所），现在只当降级。实测 baostock 322 只 / 同花顺 206 只，差的 116 只全是已退市的，活跃截面上同花顺是超集。拉到空名单时抛错不覆盖旧缓存。**改股票池口径后要删掉 `cache/st_codes.json` 强制重取**，否则 7 天内新板块的 ST 漏剔。
- **写盘前体检**：`sanity_check()` 在写 `median_data.js` 前断言列长一致/日期升序无重复/无未来日期/中位数 `<15%`/上涨占比 `0~100`/最新日样本 `>4000`（当前实际 ~5540）。失败即抛，CI 那步红掉就不会 commit——脏数据一旦入库，次日 `--update` 只取新一天不会回补。故意不查新鲜度：节假日本就没新数据，没写就没 commit。
- **CI push 竞态**：workflow 里 push 前 `git pull --rebase`，改 workflow 时保留。
- **`daily_pctchg.parquet` 滚动裁剪**：所有写盘走 `save_raw()`，只留 `date >= min(数据最新日所在年的 1 月 1 日, 最新日 − 30 天)`。上游最深只回看今年（导出）和最近 10 天（增量窗口 / baostock 降级时的代码表），更早的纯占体积。**保底 30 天是跨年防线**：单按今年切，元旦后缓存会被清空，增量窗口全判缺口退回 dump 重拉，`stock/nq_overnight.py` 的 `trading_days()` 也拿不到跨年的前一交易日。年份取自数据最新日而非 `now()`（CI 是 UTC）。改这块跑 `tests/test_tencent_parse.py`（含年中切 / 跨年保底两条分支）。历史裁剪不缩 `.git`——旧 blob 还在，只对后续提交生效。
- **`cache/daily_pctchg.parquet` 和 `cache/nq_min.parquet` 不进 git，走 `actions/cache`**（key `stock-cache-v2-<run_id>` + `restore-keys: stock-cache-v2-`，**前缀带版本号：股票池口径变了就 +1**，让旧缓存自然失效重建——2026-08 加北交所时就是这么切的，否则 `--update` 只往老缓存里追加当天，序列前半段还是没北交所的窄口径，`update.yml` 与 `nq_night.yml` 共用一个 prefix：后者只读 daily_pctchg、只写 nq_min，存回去不会回退前者）。原因：这两份每个工作日被全量重写提交 2~3 次，parquet 已压缩、git 不 delta 压缩，按这个速率一年往 `.git` 里塞 ~1.3G。这两份都可再生。**cache 未命中不是故障但必须能自愈**：`median_trend.py` 的 `--update` 分支带 `and RAW.exists()`，缓存没了直接落到全量重拉（同花顺 dump，~1 分钟，数据完整）——少这个守卫就会走增量，`update_incremental()` 只补最近 10 天窗口，`median_data.js` 从「今年以来」静默塌成 10 天，而 `sanity_check()` 不查条数照样 commit，之后每天 +1 天要一整年才长回来。actions/cache 7 天不访问即逐出，**春节休市那一周必然触发**，所以这条路每年都会走一次，别当成边角情况。`nq_night.yml` 那步挂了 `continue-on-error`：未命中时 `trading_days()` 读不到 daily_pctchg 会抛，不该让整个 job 红。改这块跑 `tests/test_tencent_parse.py` 的 `test_update_without_cache_refetches_all`。
- **指数 YTD 卡片**：`stock/index_perf.py` 拉 15 个宽基/特色/港股指数今年以来涨跌幅 → 导出 `idx_data.js`，`IndexPage` 排名条形图渲染。源按序回退：腾讯 `fqkline`（10 个沪深指数 + 恒生指数 `hkHSI`/恒生科技 `hkHSTECH`，一次请求 400 根日线，与新浪逐日实测完全一致）→ 新浪 `stock_zh_index_daily`（akshare 封装随网站变，故降为备源；北证50 `bj899050` 腾讯只给 1 根，实际就靠它）；中证2000 `932000` 腾讯/新浪都没有，只能走中证官网 `stock_zh_index_hist_csindex`；微盘股 883418 / 可转债 883981 是同花顺自编指数，直连 `d.10jqka.com.cn/v4/line/bk_*` 接口带 ths.js 算的 v cookie。「拉到了但历史不覆盖上年末基准」也算失败并换源。全源失败则复用上次 `idx_data.js` 里那条并标 `stale:true`，前端半透明 + tooltip 注明——比静默少一根条可见。CI `continue-on-error` 单独跑。**两条恒指只挂 `tx` 不挂 `sina`**：akshare 的 `stock_zh_index_daily` 是 A 股口径不认 `hk*` 代码，挂上去也只是白失败一次。**恒指是港币计价的价格指数**，与 CNY 计价的 A 股指数同图看趋势可以，严格说隔着汇率不同币种。港股 16:00 收盘（A 股 15:00），`update.yml` 的 cron 从 15:10 挪到 16:30 就是为了这两条不落到盘中价（18:00 那条本来也会覆盖）。
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
- **纳指期货隔夜卡片**：`stock/nq_overnight.py` 拉新浪外盘 NQ 分时（`GlobalFuturesService.getGlobalFuturesMinLine`，只返回当前一个盘 ~1380 根 1min），按 dt 去重累积进 `cache/nq_min.parquet`，算「前一 A 股交易日 15:00 → 当日 9:30（北京）」涨跌幅，末尾附半程点（最后交易日 15:00 → 最新 bar，`partial:true`，前端标「截至」，次日被完整点替代）→ 导出 `nq_data.js`，`QdiiPage` 顶部卡片渲染 hero 数字 + 分时曲线（无点位自动隐藏）。**`nq_data.js` 只含最新一个窗口**（`main()` 里 `overnight(...)[-1:]`）：分时曲线 `path` 本来就只挂在 `items[-1]` 上，前端拿到最后一条之后再没碰过更早的点，导出它们是纯死数据。`cache/nq_min.parquet`（模块里叫 `MIN_BARS`）同理按 `KEEP_DAYS=15` 滚动裁剪——窗口常态跨 1 天、跨周末 3 天、**国庆最长 8 天**（09-30 15:00 → 10-08 09:30），15 天是这条底线加 `nq_night.yml` 漏跑一两次的余量；不裁则每工作日 +~1300 行无上限增长，而两个 workflow 每天各重写提交一次整份 parquet。半程点盘中陈旧：`QdiiPage` 客户端直连新浪 MinLine（`<script>` 注入绕 CORS，`stock2` 接口无防盗链）开页自刷 + 每 8s 自动轮询（base 固定只重算实时价）；过了 A 股 15:00 前端 `nqRebase()` 自己换窗口（拿实时 bar 里当日 15:00 价当新基准，同 py 端 `crossed` 逻辑），否则 15:00~18:00 曲线卡在旧窗口右边界，故不再需要开盘前 CI 跑（8:45 那个已删；但见下方 `nq_night.yml`，那个是补历史 bar 的，别混淆）。新浪外盘 NQ MinLine 实测延迟约 1 分钟（当前分钟 bar 形成中），非早前标注的 10 分钟；海外期货无免费逐笔源，1min bar 已是最快。交易日历取 `daily_pctchg.parquet` 日期列，CME 假日晨盘无 bar 自动跳过该日。CI `continue-on-error` 单独跑。注意 MinLine 每天 6:00 切新盘，「昨 18:00→今 5:00」的 bar 只能在切盘前抓：`nq_night.yml` cron UTC 21:00（北京 5:00）专补这段——NQ 每日 5:00 收盘，5:00~6:00 抓到的必是刚收完的完整整夜盘，天然容忍 Actions 常见的 10~50 分钟 cron 延迟（落地窗口有整整 1 小时）。少了它分时曲线会从上次抓取时刻断到次日 6:00（指标只需两端点，断的只是曲线）。前端 `nqClosed()` 把 CME 闭市时段（每日 5:00-6:00 维护、周六 6:00→周一 6:00）从类目轴剔除，不留空槽。东财 push2his 备选源已试过，对非浏览器请求限流断连，弃用。改 `overnight()` 前先跑 `tests/test_nq_overnight.py`（合成 bar，覆盖完整点 / CME 假日跳过 / 过 15:00 换窗 / 周末不换窗四条分支）。
- **美股页（`UsPage`）**：`stock/us_perf.py` 拉腾讯美股日线（`usfqkline/get`，`usNDX` + 七巨头 `usAAPL.OQ` 之类，一次 400 根 ≈1.6 年，足够覆盖上年末+上月末两个基准）→ 算今日/本周/本月/今年以来涨跌幅（`perf()`，今日那列 `cut` = 最新那根本身 → 基准是前一根）→ `us_data.js`，纯静态列表（无 ECharts）。两张表都走同一个 `useSort(rows, 默认列)`：每张表各持一份排序状态，全列可点，同列再点切升降，换列时数字降序、文字（标的）升序；行情表默认今年以来降序，权重表默认权重降序。三个口径共用 `pct(s, cut)`（cut 之前最后一根收盘为基准），本周 cut = 最新那根所在周的周一。第二张表是纳指100 前 11 大权重股：**权重取 QQQ 持仓占比**（纳斯达克官网和景顺官网对非浏览器请求一律 406，`stockanalysis.com/etf/qqq/holdings/` 是能直连的现成日频源），正则从 Next.js flight payload 里捞 `{no,n,s,as}`；解析不到 `top` 行即判页面结构变了。权重是独立源，失败不拖垮行情——沿用上次 `us_data.js` 里的 `holdings` 并标 `stale`（前端半透明 + 注明），没有旧值则整块隐藏卡片。GOOGL/GOOG 两个份额同时在榜是 QQQ 的真实持仓，不是重复——**`holdings(top=11)` 取 11 不取 10 就是为它俩**：两个份额各占一格，卡在 10 会挤掉一家真正的公司（当时被挤掉的是特斯拉）。**前端把这俩并成一行显示**（`UsPage` 的 `HoldCard` 里按 `code` 找 GOOGL/GOOG，权重相加、名次按合并后的权重重排 1..10、涨跌幅三列分 A/C 两行塞同一格、财报三列本就是同一份直接沿用 A 的），所以拉 11 只、显示 10 行，标题/tfoot 写「前 10 大」。改 `top=` 要同步这两处文案和重排逻辑。第三张表是行业权重（12 个 GICS 行业 + Other，权重条是纯 CSS `<i>` 宽度按最大值归一，`min-width:3px` 防尾部 0.2% 的条看不见）——**行业占比在同一份 payload 里白拿**（`sectors:[{n,w}]`，注意 `allocationChartData.sectors` 是另一套 `{name,y}` 键，别正则串了），不额外发请求，随权重表一起 stale/隐藏。行业表里「科技」那行可点开出子行业（不是第四张表，`tech_split()` 出数据，前端展开态是 `UsPage` 的 `SectorCard` 里一个布尔——只有一行可展开；子行条与父行共用同一把标尺，长度可直接横向比）：**两个源的细分都不能用**——stockanalysis 只给 12 个一级行业，纳斯达克筛选器 `download=true` 虽有 `industry` 字段但口径乱（PANW 归"电脑外设"、ASML/LRCX 归"工业机械"），所以 `TECH_SUB` 是手工归类的 GICS 信息技术口径名单（谷歌/Meta 属通信服务、亚马逊/特斯拉属可选消费，都不在内）。只对解析到的前 25 大持仓归类，剩下的长尾用「板块总权重 − 已归类」兜成"其他科技"，合计恒等于上表的科技权重；换成分股不会算错，只是细分少一块。残差为负（归类里混进非科技股）时不写该行。改 `tech_split()` 或 `TECH_SUB` 跑 `tests/test_us_perf.py`。权重表的涨跌幅三列走同一个 `metrics(腾讯代码)`（纳指成分必在纳斯达克上市，代码统一 `us{TICKER}.OQ`），`closes()` 上了 `lru_cache`——权重股与七巨头有 6 只重叠，不缓存就白拉 6 次。指数走 `data.day`、个股走 `data.qfqday`（前复权，拆股后才对得上）。**基准月份/年份取自最新那根 bar 的日期而非 `now()`**：美股按纽约交易日算，北京凌晨跑 CI 时 `now()` 已是次日，月初/年初会取错基准。单只失败即整体抛错不写文件（只有腾讯一个源，无处降级），页面保留上次的 `us_data.js`，CI `continue-on-error`。沿用站内红涨绿跌口径（非美股惯例）。改 `pct()` 前跑 `tests/test_us_perf.py`。**cron 独立成 `us.yml`（`us-market`）**，不挂在 daily-update 上：① 美股 16:00 ET 收盘 = 北京 04:00(夏)/05:00(冬)，腾讯日线当天早上就有，daily-update 的第二条 cron（北京 18:00）对美股零增量——美股 21:30 才开盘，跑了只是白提交一次；② 周末缺口只有单独排期才能补：美东周五盘北京周六 04:00 才收，挂在 1-5 的 cron 上要等到北京周一 16:30 才上页面，陈旧 2 天半。所以是单独一条 **UTC 23:00 周一~周五 = 北京周二~周六 07:00**（一天一次，正好盖住美股 5 个交易日的收盘，无重复；原来是 UTC 07:20 + UTC 22:00 周五两条，即北京周一~周五 15:20 + 周六 06:00，其中周一那次抓的还是周五收盘，纯重复）。**别写成 `0-4`（北京周一~周五 07:00）**：北京周一之前最近的美股盘就是周五，行情与周六那次全同，白跑一趟；丢了周六那次周末又挂 2 天半陈旧数据。**`us_data.js` 刻意不带 `updated`**（其余数据文件多数都有）：那是脚本跑的时刻不是数据的时刻，摆在页头会被当成行情时间，而空跑也照样刷新；两张表各自的 `date`/`asof` 才是真口径，`UsPage` 已删掉页头那行，想知道 CI 何时跑的看 git log。**07:00 不是 06:00** 是为冬令时留余量：收盘后腾讯日线约 2 小时可用（北京 06:12 实测抓到当日线），夏令时收盘北京 04:00、冬令时 05:00，06:00 冬天只剩 1 小时；Actions cron 实测延迟 11~71 分钟，07:00 落地在 07:10~08:15。代价：不再有 18:00 那次免费重试，单次失败要等下一个工作日——所以所有 GET 走 `fetch()` 包 3 次重试（只重 HTTP 层，解析失败重试无意义），权重表里单只行情拉不到也只让那一行涨跌幅留空（前端渲染 `—`），不再整块回退 stale。`asof` 优先认 `lastUpdated:"..."`：裸 `date:"..."` 会命中全文第一个同名字段，上游哪天在前面加一个就静默取错日期。持仓行数 `< TECH_MIN_ROWS(20)` 时不出科技细分（`tech_split` 靠长尾兜"其他科技"，行数少了残差会悄悄变胖，表面正常实则失真）。
- **财报三列（并在权重表里，公布日 / 营收·同比 / 净利·同比）**：`stock/us_perf.py` 的 `earnings()` 出「最近一期单季营收/归母净利润 + 各自同比」（不新增文件，故 `us.yml` 的 `git add` 不用改）。曾经是独立的第四张卡片，因为和权重表数据几乎完全重合（只多出不在前十的七巨头成员）已撤掉；**`us_data.js` 里的 `earnings` 键留着不是死数据**，是纳斯达克全挂时补权重表那三列的降级缓存（`last(out, "earnings")`），删了降级就断。**两个源拼一行**：财季与公布日走纳斯达克 `api.nasdaq.com/api/company/{TICKER}/earnings-surprise`，营收/净利/同比走东财 `RPT_USF10_FN_INCOME`。约束：
  - **`api.nasdaq.com` 能直连**——上一条里那句「纳斯达克官网 406」只对持仓/screener download 端点成立，财报接口普通 UA 就行，但**必须带 UA**，裸请求直接 `http=000` 断连（`fetch()` 已固定发 `Mozilla/5.0`）。留着这个源就为**公布日**：东财只给财季末日期，说不了哪天发的（AMD 3 月季 5/5 才公布）。
  - **`parse_surprise()` 返回的 `eps`/`est` 不导出，只用来判重**：`(财季, 公布日)` 两元组认不出双重股权——同一天公布同一财季的两家公司太常见（AAPL 与 AMZN 都是 7/30）。GOOGL/GOOG 都在 QQQ 前十，是同一家公司的同一份财报，列两行是噪音（权重表里那两行是真实持仓，别一起去掉）。判重在拉利润表之前，省一次请求。
  - **超预期这列做不了，别再试**：营收/净利没有免费的「当期一致预期」源——预期一发实际就被覆盖（stockanalysis 的 forecast payload 里 `lastDate` 之前全是实际值）。曾经上过 EPS 超预期，后来撤了；真要做得换付费源。另外**纳斯达克的 EPS 与 SEC/东财的 GAAP 摊薄 EPS 对不上**（AAPL FQ3 2026：1.91 vs 2.02），**绝不能拿别的源的 EPS 去减这里的 consensus**。
  - **财务数不能用纳斯达克 `api/company/{T}/revenue`**：月份块标签与块内 EPS 日期整体错位（AAPL 的 `September (FYE)` 块里放的是 6 月季），且最新一期常年缺失（AAPL 6 月季、NVDA 4 月季当时都没有）。东财实测与 SEC XBRL 逐位一致（AAPL 109,417,000,000）还白送同比。**必须按 `REPORT_TYPE="单季报"` 过滤**：`DATE_TYPE_CODE` 不是固定值（同一家不同季给 003/006/008），而财年末那季同时存在一行「年报」，取错就把全年营收当成单季（NVDA 2026-01-25 两行并存）。`RPT_USF10_FN_MAININDEX` 不存在，别照抄网上的报表名。
  - **不按 `ITEM_NAME` 过滤，整季拉回来自己挑**（`ITEMS` 映射，`主营收入`/`归属于普通股股东净利润`）：实测单季 25~31 个项目，`pageSize=60` 保证最新那季整块在第一页，比按名字发两次请求省事。两项缺一即抛错让整行留空——表里出现一半有一半没有的行更难看。
  - **两源的财季对齐用 45 天容差而非同年同月**：13 周财季常越到下月初——AVGO 那季 5/3 结束，纳斯达克仍标 `Apr 2026`。实测同季最远差 ~33 天，差一整季至少 ~60 天。对不上就留空这行的财务数（前端 `—`），不能把上一季的数摆在本季公布日旁边。
  - `earnings()` 返回 `(去重后的行, 代码→行)` 两样：前者是降级缓存（按行去重，双重股权只留一行），后者供权重表按代码逐行取数——只给去重后的列表会让 GOOG 那行平白空一片（映射里 GOOG 与 GOOGL 指向同一个 row 对象）。**公布日搬进权重表必须改名 `rpt`**：权重行里的 `date` 是 `metrics()` 的行情收盘日、前端 `HoldCard` 在用，同名合并会被财报日悄悄覆盖。
  - 覆盖标的 = 七巨头 + 权重表前十（`usNDX` 是指数无财报，排除）。`parse_surprise()` 按 `dateReported` 取 max 而非信上游排序（实测倒序但无契约）。单只纳斯达克失败跳该行、单只东财失败只留空那几格；纳斯达克全军覆没才沿用上次的 `earnings` 并逐行标 `stale`，没有旧值则整块隐藏卡片。
  - 改 `parse_surprise()` / `parse_income()` 跑 `tests/test_us_perf.py`（最新行选取 / 空表抛错 / 多项目取数 / 财季越月 / 项目缺失 / 财季错位六条分支，全离线）。其余源试过并弃用：腾讯无美股财务接口（`Can't load controller:UsFinanceController`）、新浪 `US_FinanceService` 返回 `Service not valid`、Yahoo `quoteSummary` 现在 401 `Invalid Crumb`、`stockanalysis.com/api/screener/*` 全 404 已废。要 GAAP 底稿再看 SEC `data.sec.gov/api/xbrl/companyconcept`（要合规 UA + 十位补零 CIK）。
- 只导出今年以来的数据（`stock/median_trend.py` 的 `main()` 末尾按 `%Y-01-01` 过滤）。

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
