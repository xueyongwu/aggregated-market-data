"""纳指100 + 美股七巨头 本月/今年以来累计涨跌幅 -> app/src/data/us_data.js (UsPage 渲染)。

另拉纳指100 前 11 大权重股(见 holdings())、最近一期财报单季营收与净利(见 earnings())。

数据源: 腾讯美股日线 web.ifzq.gtimg.cn/appstock/app/usfqkline/get
  一次请求 400 根日线(≈1.6 年), 足够覆盖上年末 + 上月末两个基准。
  指数走 data.day, 个股走 data.qfqday(前复权, 拆股后才对得上)。

基准月份/年份取自「最新那根 bar 的日期」而非 now(): 美股交易日按纽约算,
北京时间凌晨跑 CI 时 now() 已是次日, 月初/年初会取错基准。

单只失败即整体抛错不写文件, 页面保留上次的 us_data.js(workflow continue-on-error)。

用法: python -m pipeline.stock.us_perf
"""
import json
import re
import time
from functools import lru_cache
from pathlib import Path

import pandas as pd
import requests

from pipeline.paths import WEB_DATA


def fetch(url: str, tries: int = 3, **kw) -> requests.Response:
    """带重试的 GET。

    本脚本单独跑在 us.yml 上, 没有 daily-update 那种「18:00 再跑一次」的免费兜底,
    一次瞬时抖动就是页面停一整个工作日, 所以宁可多等 15 秒。
    只重试 HTTP 层: 解析失败(代码不存在、页面改版)重试多少次都一样。
    """
    for i in range(tries):
        try:
            r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, **kw)
            r.raise_for_status()
            return r
        except Exception as e:
            if i == tries - 1:
                raise
            print(f"  拉取失败({i + 1}/{tries}) {url}: {e}, {5 * (i + 1)}s 后重试", flush=True)
            time.sleep(5 * (i + 1))

SYMBOLS = [  # (显示名, 腾讯代码)
    ("纳斯达克100", "usNDX"),
    ("英伟达", "usNVDA.OQ"),
    ("苹果", "usAAPL.OQ"),
    ("微软", "usMSFT.OQ"),
    ("谷歌", "usGOOGL.OQ"),
    ("亚马逊", "usAMZN.OQ"),
    ("Meta", "usMETA.OQ"),
    ("特斯拉", "usTSLA.OQ"),
]


CN = {  # 权重股中文名, 缺的直接显示英文原名(成分股会换, 别为此报错)
    "AAPL": "苹果", "NVDA": "英伟达", "MSFT": "微软", "GOOGL": "谷歌-A", "GOOG": "谷歌-C",
    "AMZN": "亚马逊", "META": "Meta", "TSLA": "特斯拉", "AVGO": "博通", "AMD": "AMD",
    "MU": "美光科技", "NFLX": "奈飞", "COST": "好市多", "CSCO": "思科", "INTC": "英特尔",
    "WMT": "沃尔玛", "PLTR": "Palantir", "AMAT": "应用材料", "LRCX": "泛林集团",
    "TXN": "德州仪器", "KLAC": "科天半导体", "PANW": "派拓网络", "LIN": "林德", "AMGN": "安进",
}


SECTOR_CN = {
    "Technology": "科技", "Consumer Discretionary": "可选消费", "Communication Services": "通信服务",
    "Consumer Staples": "日常消费", "Industrials": "工业", "Healthcare": "医疗保健",
    "Utilities": "公用事业", "Materials": "原材料", "Energy": "能源",
    "Financials": "金融", "Real Estate": "房地产", "Other": "其他",
}


# 科技板块细分。手工归类, 因为两个源给的细分都不能用:
#   - stockanalysis 只有 12 个一级行业, 没有子行业
#   - 纳斯达克筛选器的 industry 字段口径乱(PANW 归"电脑外设"、ASML/LRCX 归"工业机械")
# 这里只列 GICS 信息技术口径下的成分(谷歌/Meta 属通信服务、亚马逊/特斯拉属可选消费, 不在内),
# 没收录的成分自动落进"其他科技"残差, 换成分不会算错, 只是细分少一块。
TECH_SUB = {
    "半导体": ("NVDA", "AVGO", "AMD", "MU", "TXN", "INTC", "QCOM", "ARM", "MRVL",
              "NXPI", "ADI", "MCHP", "ON"),
    "半导体设备": ("AMAT", "LRCX", "KLAC", "ASML", "TER"),
    "软件": ("MSFT", "PLTR", "ADBE", "CRWD", "PANW", "INTU", "SNPS", "CDNS", "WDAY",
            "ADSK", "FTNT", "DDOG", "TEAM", "ZS", "APP"),
    "硬件与网络设备": ("AAPL", "CSCO", "ANET", "STX", "WDC"),
}
SUB_OF = {code: sub for sub, codes in TECH_SUB.items() for code in codes}
TECH_MIN_ROWS = 20  # 上游常态给 25 行; 低于这个数细分的残差不可信, 见 holdings()


def tech_split(rows: list[tuple], tech_total: float) -> list[dict]:
    """把科技板块总权重拆成子行业。

    rows 是解析到的持仓(通常前 25, 覆盖科技板块八成以上), 逐只按 SUB_OF 归类;
    剩下没进榜的长尾用「板块总权重 − 已归类」兜成"其他科技", 保证合计正好等于总权重。
    """
    sub: dict[str, float] = {}
    for _, _, code, w in rows:
        if code in SUB_OF:
            sub[SUB_OF[code]] = sub.get(SUB_OF[code], 0) + float(w)
    out = [{"name": k, "weight": round(v, 2)} for k, v in sub.items()]
    out.sort(key=lambda x: x["weight"], reverse=True)
    rest = round(tech_total - sum(x["weight"] for x in out), 2)
    if rest > 0.005:  # 负残差 = 归类里混进了非科技股, 宁可不显示也别写个负数
        out.append({"name": "其他科技", "weight": rest})
    return out


def holdings(top: int = 11) -> dict:
    """纳指100 前 N 大权重股 + 行业权重 + 科技板块细分。

    取 11 不取 10: 谷歌两个份额(GOOGL/GOOG)各占一格, 卡在 10 会挤掉一家真正的公司。

    权重取 QQQ(景顺纳指100 ETF, 完全复制该指数)的持仓占比 —— 纳斯达克官方和
    景顺官网都对非浏览器请求返回 406, stockanalysis.com 是能直连的现成来源(日频)。
    页面把持仓塞在 Next.js 的 flight payload 里, 直接正则捞 {no,n,s,as} 四元组。
    """
    r = fetch("https://stockanalysis.com/etf/qqq/holdings/", timeout=25)
    rows = re.findall(r'\{no:(\d+),n:"([^"]+)",s:"\$([A-Z.]+)",as:"([\d.]+)%"', r.text)
    if len(rows) < top:
        raise RuntimeError(f"持仓解析到 {len(rows)} 行, 页面结构可能变了")
    # asof 优先认 lastUpdated —— 裸 `date:"..."` 会命中全文第一个同名字段,
    # 上游哪天在前面加一个就静默取错日期, 而键名 lastUpdated 是唯一的。
    asof = re.search(r'lastUpdated:"([^"]+)"', r.text) or re.search(r'\bdate:"([^"]+)"', r.text)
    sec = re.search(r'sectors:\[(.*?)\]', r.text)  # 同一份 payload 里带行业占比, 白拿
    secs = re.findall(r'\{n:"([^"]+)",w:([\d.]+)\}', sec.group(1)) if sec else []
    tech = next((float(w) for n, w in secs if n == "Technology"), 0.0)
    return {
        "asof": pd.to_datetime(asof.group(1)).strftime("%Y-%m-%d") if asof else "",
        "items": [{"rank": int(no), "code": sym, "name": CN.get(sym, name), "weight": float(w)}
                  for no, name, sym, w in rows[:top]],
        "sectors": [{"name": SECTOR_CN.get(n, n), "weight": float(w)} for n, w in secs],
        # 行数不够就不给细分: tech_split 靠长尾兜"其他科技", 只剩十几行时残差会悄悄变胖,
        # 表面正常实则失真 —— 宁可前端不显示展开箭头。
        "tech": tech_split(rows, tech) if tech and len(rows) >= TECH_MIN_ROWS else [],
    }


def num(v) -> float:
    """上游同一个字段时而 "1.88" 时而 "$1,234.5" 时而 float, 统一成数。"""
    return float(str(v).replace("$", "").replace(",", "").strip())


def parse_surprise(data: dict) -> dict:
    """纳斯达克 earnings-surprise 响应 -> 最近一期的财季与公布日。

    只认表里 dateReported 最新的那行, 不假设上游的排序(实测是倒序, 但没有契约)。
    要的是「哪一季、哪天公布的」—— 东财只给财季末日期, 说不了公布日(AMD 3 月季 5/5 才发)。
    eps/est 不导出, 只用来判重: 同一天公布同一财季的两家公司太常见(AAPL 与 AMZN 都是 7/30),
    光靠财季+公布日认不出双重股权。
    """
    rows = ((data or {}).get("earningsSurpriseTable") or {}).get("rows") or []
    if not rows:
        raise RuntimeError("无 earningsSurpriseTable")
    r = max(rows, key=lambda x: pd.to_datetime(x["dateReported"]))
    return {
        "qtr": r["fiscalQtrEnd"],                                    # 财季, 如 "Jun 2026"
        "date": pd.to_datetime(r["dateReported"]).strftime("%Y-%m-%d"),
        "eps": num(r["eps"]),
        "est": num(r["consensusForecast"]),
    }


@lru_cache(maxsize=None)  # 与权重表的 ticker 有重叠
def surprise(ticker: str) -> dict:
    r = fetch(f"https://api.nasdaq.com/api/company/{ticker}/earnings-surprise", timeout=20)
    return parse_surprise(r.json().get("data"))


ITEMS = {"主营收入": ("rev", "revYoy"), "归属于普通股股东净利润": ("ni", "niYoy")}


def parse_income(data: dict, qtr: str) -> dict:
    """东财 F10 单季利润表响应 -> 单季营收/归母净利润 + 各自同比。qtr 是纳斯达克那边的财季。

    两个源各报各的, 必须校验落在同一个财季: 东财哪天滞后一期, 宁可这行营收留空,
    也不能把上一季的营收摆在本季的公布日旁边。

    不能按「同年同月」比: 13 周财季常越到下月初(AVGO 那季 5/3 结束, 纳斯达克仍标 Apr 2026),
    实测同季最远差 ~33 天, 而差一整季至少 ~60 天, 45 天卡在中间。
    """
    rows = ((data or {}).get("result") or {}).get("data") or []
    if not rows:
        raise RuntimeError("无单季报")
    d = pd.to_datetime(rows[0]["REPORT_DATE"])  # 已按 REPORT_DATE 倒序
    if abs((d - pd.to_datetime(qtr)).days) >= 45:
        raise RuntimeError(f"财季对不上: 东财 {d.date()} vs 纳斯达克 {qtr}")
    out = {}
    for r in rows:
        if r["REPORT_DATE"] == rows[0]["REPORT_DATE"] and r["ITEM_NAME"] in ITEMS:
            amt, yoy = ITEMS[r["ITEM_NAME"]]
            out[amt], out[yoy] = float(r["AMOUNT"]), round(float(r["YOY_RATIO"]), 2)
    if len(out) != 2 * len(ITEMS):
        raise RuntimeError(f"单季项目缺失, 只取到 {sorted(out)}")
    return out


@lru_cache(maxsize=None)
def income(ticker: str, qtr: str) -> dict:
    """单季营收/归母净利润走东财 F10。

    纳斯达克自己那个 api/company/{T}/revenue 试过, 不能用: 月份块标签与块内 EPS 日期
    整体错位(AAPL 的 "September (FYE)" 块里放的是 6 月季), 且最新一期常年缺失
    (AAPL 6 月季、NVDA 4 月季当时都没有)。东财实测与 SEC XBRL 逐位一致, 还白送同比。
    REPORT_TYPE 必须按 "单季报" 过滤: DATE_TYPE_CODE 不是固定值(同一家不同季给 003/006/008),
    而财年末那一季同时存在一行"年报", 取错就把全年营收当成单季。
    不按 ITEM_NAME 过滤而是整季拉回来自己挑: 实测单季 25~31 个项目, 一次拿全比按名字
    发两次请求省事, pageSize 60 保证最新那季整块都在第一页。
    """
    r = fetch("https://datacenter.eastmoney.com/securities/api/data/v1/get", timeout=20, params={
        "reportName": "RPT_USF10_FN_INCOME",
        "columns": "REPORT_DATE,ITEM_NAME,AMOUNT,YOY_RATIO,REPORT_TYPE",
        "filter": f'(SECUCODE="{ticker}.O")(REPORT_TYPE="单季报")',
        "pageNumber": 1, "pageSize": 60, "sortColumns": "REPORT_DATE", "sortTypes": -1,
        "source": "SECURITIES", "client": "PC"})
    return parse_income(r.json(), qtr)


def earnings(tickers: list[str]) -> tuple[list[dict], dict[str, dict]]:
    """逐只拉最近一期财报: 单季营收/归母净利润 + 各自同比(东财), 财季与公布日(纳斯达克)。

    返回 (去重后的行, 代码 -> 行)。两者要分开: 财报表按行去重(双重股权列两行是噪音),
    权重表却是按代码逐行取数 —— GOOG 被去掉后若映射里没有它, 权重表那行会平白空一片。
    映射里 GOOG 与 GOOGL 指向同一个 row 对象。
    """
    out, seen, by_code = [], {}, {}
    for t in tickers:
        try:
            s = surprise(t)
        except Exception as e:  # 新上市/刚换成分的没有历史, 很正常
            print(f"  {t} 财报拉取失败: {e}(跳过该行)", flush=True)
            continue
        # 双重股权(GOOGL/GOOG 都在 QQQ 前十)是同一家公司的同一份财报, 列两行是纯噪音。
        # 按数值判重而非硬编码股票对, 换成分不用改代码。判重放在拉利润表之前, 省一次请求。
        key = (s["qtr"], s["date"], s["eps"], s["est"])
        if key in seen:
            by_code[t] = seen[key]
            continue
        row = {"code": t, "name": CN.get(t, t), "qtr": s["qtr"], "date": s["date"]}
        try:
            row |= income(t, s["qtr"])
        except Exception as e:  # 利润表是另一个源, 缺了只让这行的数留空, 别丢掉整行
            print(f"  {t} 利润表拉取失败: {e}(该行营收/净利留空)", flush=True)
        seen[key] = by_code[t] = row
        out.append(row)
    return out, by_code


@lru_cache(maxsize=None)  # 权重股与七巨头有 6 只重叠, 别重复请求
def closes(symbol: str) -> pd.Series:
    r = fetch("https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get",
              params={"param": f"{symbol},day,,,400,qfq"}, timeout=15)
    d = r.json()["data"][symbol]
    rows = d.get("qfqday") or d.get("day") or []
    if not rows:
        raise RuntimeError(f"{symbol}: 腾讯无日线")
    s = pd.Series({x[0]: float(x[2]) for x in rows})  # 行: [date, open, close, high, low, ...]
    s.index = pd.to_datetime(s.index)
    return s.sort_index()


def pct(s: pd.Series, cut: pd.Timestamp) -> float:
    """cut 之前最后一根收盘为基准, 到最新收盘的涨跌幅%。"""
    base = s[s.index < cut]
    if base.empty:
        raise RuntimeError(f"日线不覆盖基准 {cut.date()}({len(s)} 根)")
    return round((s.iloc[-1] / base.iloc[-1] - 1) * 100, 2)


def perf(s: pd.Series) -> dict:
    """收盘序列 -> 当日/本周/本月/今年以来涨跌幅 + 最新收盘。

    基准都取自「最新那根 bar 的日期」而非 now(), 理由见模块头。
    """
    d = s.index[-1]
    return {
        # cut = 最新那根本身 -> 基准是前一根收盘, 即当日涨跌幅
        "day": pct(s, d),
        # cut = 本周一 -> 基准落到上周最后一个交易日收盘(通常上周五, 假期则更早)
        "wtd": pct(s, d - pd.Timedelta(days=d.weekday())),
        "mtd": pct(s, d.replace(day=1)),
        "ytd": pct(s, pd.Timestamp(d.year, 1, 1)),
        "close": round(float(s.iloc[-1]), 2),
        "date": d.strftime("%Y-%m-%d"),
    }


def metrics(symbol: str) -> dict:
    """腾讯代码 -> 本周/本月/今年以来涨跌幅 + 最新收盘。"""
    return perf(closes(symbol))


def last(out: Path, key: str):
    """上次导出的某一块, 供本次拉取失败时降级复用。"""
    try:
        t = out.read_text(encoding="utf-8")
        return json.loads(t[t.index("=") + 1:t.rindex(";")])[key]
    except Exception:
        return None


def main():
    items = []
    for name, sym in SYMBOLS:
        m = metrics(sym)
        items.append({"name": name} | m)
        print(f"{name:<10} 本周 {m['wtd']:+7.2f}%  本月 {m['mtd']:+7.2f}%"
              f"  今年 {m['ytd']:+7.2f}%  ({m['date']})", flush=True)

    items.sort(key=lambda x: x["ytd"], reverse=True)
    out = WEB_DATA / "us_data.js"

    try:  # 权重是另一个源, 挂了不该把行情一起拖掉: 沿用上次的并标 stale
        hold = holdings()
        for h in hold["items"]:  # 纳指成分必在纳斯达克上市, 腾讯代码统一 .OQ 后缀
            try:
                h.update(metrics(f"us{h['code']}.OQ"))
            except Exception as e:  # 单只拿不到不该让整张权重表回退成上周的
                print(f"  {h['code']} 行情拉取失败: {e}(该行涨跌幅留空)", flush=True)
        print(f"权重股 {len(hold['items'])} 只 / 行业 {len(hold['sectors'])} 个"
              f" (截至 {hold['asof']})", flush=True)
    except Exception as e:
        hold = last(out, "holdings")
        print(f"权重拉取失败({e}), " + ("沿用上次" if hold else "本次不带权重表"), flush=True)
        if hold:
            hold["stale"] = True

    # 财报覆盖页面上已有的两张表(七巨头 + 权重股), 去重保序; 指数 NDX 没有财报, 排除
    tickers = [s[2:].split(".")[0] for _, s in SYMBOLS if s != "usNDX"]
    tickers += [h["code"] for h in (hold or {}).get("items", []) if h["code"] not in tickers]
    # payload 里的 earnings 已经没有前端在渲染(财报表撤了, 三列并进权重表), 留着只为
    # 下面这条降级: 纳斯达克全挂时拿上次的补上权重表那三列。删了它降级就断了。
    earn, by_code = earnings(tickers)
    if earn:
        earn.sort(key=lambda x: x["date"], reverse=True)
        print(f"财报 {len(earn)}/{len(tickers)} 只 (最近 {earn[0]['date']})", flush=True)
    else:  # 全军覆没才算源挂了, 沿用上次
        earn = last(out, "earnings") or []
        by_code = {r["code"]: r for r in earn}
        print("财报全部拉取失败, " + ("沿用上次" if earn else "本次权重表不带财报列"), flush=True)

    # 权重表也带上财报三列。公布日搬过去得改名 rpt: 权重表行里的 date 是 metrics() 的
    # 行情收盘日, 前端 holdSub 在用, 同名会被财报日悄悄覆盖。
    for h in (hold or {}).get("items", []):
        e = by_code.get(h["code"])
        if e:
            h |= {"rpt": e["date"]} | {k: e[k] for k in ("rev", "revYoy", "ni", "niYoy") if k in e}

    # 刻意不带 updated: 那是脚本跑的时刻不是数据的时刻, 两张表各自的 date/asof 才是真口径,
    # 摆在页头反而误导(空跑也照样刷新)。想知道 CI 什么时候跑的看 git log。
    payload = {"items": items, "holdings": hold, "earnings": earn}
    out.write_text("export const US_PERF = " + json.dumps(payload, ensure_ascii=False) + ";\n",
                   encoding="utf-8")
    print(f"已导出: {out} ({len(items)} 只)")


if __name__ == "__main__":
    main()
