# aggregated-market-data

六块市场数据看板合并成的一个单页应用，数据全部由 GitHub Actions 定时抓取后自动部署到 GitHub Pages。

| 页面 | 路由 | 内容 |
| --- | --- | --- |
| 纳指 · QDII | `#/qdii` | 纳指期货隔夜涨跌 + 分时、12 只场内纳指 QDII 的溢价/区间涨跌对照 |
| 美股纳指100 | `#/us` | 纳指100 与七巨头的周/月/年涨跌、QQQ 前 10 大权重股（含最新财报）、行业权重 |
| A股中位数 | `#/median` | 全市场当日涨跌幅中位数、累计中位数、涨跌停与涨跌分布 |
| 宽基指数 | `#/index` | 15 个宽基/特色/港股指数今年以来涨跌幅排名 |
| 国债活跃券 | `#/bond` | 银行间 1Y~30Y 各期限成交量最大的券：10Y/30Y 大数字 + 明细表 |
| 70城房价 | `#/housing` | 国家统计局 70 城新建商品住宅/二手住宅环比指数，2021 年至今 |

多个页面带浏览器端实时轮询（国债 3s、场内快照 8s），CI 那份只是开页时的静态基准。
深浅色主题全站统一，选择记在 `localStorage`；导航宽屏是顶部横条，780px 以下换成左侧抽屉。

## 目录

```
pipeline/               抓取管道（Python 包，一律 python -m 调用）
  paths.py              ROOT / CACHE / DATA / WEB_DATA，全是绝对路径
  stock/                A股中位数、宽基指数、国债、纳指期货、美股
  housing/              统计局 70 城房价
tests/                  离线自检（assert 脚本，无测试框架）
data/                   房价原始 JSON + data/raw/ 的 gzip 存档
cache/                  parquet 缓存（CI 增量依赖，部分入库，见 .gitignore）
app/                    Vite + React 19 + ECharts 6 单页应用
  src/data/*.js         抓取脚本产出的 ES module 数据（提交入库）
  src/pages/            六个页面
  src/chartBase.js      ECharts 共用零件
  src/table.jsx         行情表共用零件（useSort / Pct）
.github/workflows/      4 条抓取 + 1 条构建部署
```

## 本地跑起来

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./update.sh                 # 抓数据（all / stock / housing）
python -m tests.test_us_perf   # 离线自检，tests/ 下逐个跑

cd app && pnpm install
pnpm dev                    # http://localhost:5173
pnpm build                  # 产物在 app/dist
```

## 自动更新

| workflow | cron（UTC） | 干什么 |
| --- | --- | --- |
| `update.yml` | 08:30、10:00 工作日 | A股中位数 + 指数 + 国债 + NQ |
| `us.yml` | 23:00 周一~周五 | 美股 |
| `nq_night.yml` | 21:00 周日~周四 | 补 NQ 整夜盘的 1min bar |
| `housing.yml` | 每月 15–25 日 04:00 | 统计局 70 城房价 |
| `deploy.yml` | 上面四条各自触发 | `pnpm build` → GitHub Pages |

数据是 Vite 的源文件，改了必须重新构建才上线，所以每条抓取 workflow 提交后都显式
`gh workflow run deploy.yml` —— GITHUB_TOKEN 推的 commit 不会自动触发别的 workflow。

数据源全部是公开免费接口，各源的坑和取舍写在 `CLAUDE.md` 里。
