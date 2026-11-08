"""纳指100 + 标普500 + 美股七巨头 当日/本周/本月/今年以来涨跌幅 -> app/src/data/us_data.js
(QdiiPage 页底那张表渲染)。

数据源: 腾讯美股日线 web.ifzq.gtimg.cn/appstock/app/usfqkline/get
  一次请求 400 根日线(≈1.6 年), 足够覆盖上年末 + 上月末两个基准。
  指数走 data.day, 个股走 data.qfqday(前复权, 拆股后才对得上)。

基准月份/年份取自「最新那根 bar 的日期」而非 now(): 美股交易日按纽约算,
北京时间凌晨跑 CI 时 now() 已是次日, 月初/年初会取错基准。

单只失败即整体抛错不写文件, 页面保留上次的 us_data.js(workflow continue-on-error)。

用法: python -m pipeline.stock.us_perf
"""
import json
import time

import pandas as pd
import requests

from pipeline.paths import WEB_DATA


# 完整浏览器 UA + Accept。ndx_pe / qdii_premium 也走这个 fetch(): 有的源(Cloudflare 那类)
# 对裸 "Mozilla/5.0" 直接 403, 带全这两个头才放行; 腾讯/东财照样认。
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
}


def fetch(url: str, tries: int = 3, **kw) -> requests.Response:
    """带重试的 GET。

    本脚本单独跑在 us.yml 上, 没有 daily-update 那种「18:00 再跑一次」的免费兜底,
    一次瞬时抖动就是页面停一整个工作日, 所以宁可多等 15 秒。
    只重试 HTTP 层: 解析失败(代码不存在、页面改版)重试多少次都一样。
    额外的 headers(比如 Referer)叠在 HEADERS 上, 不替换整套 UA。
    """
    kw["headers"] = {**HEADERS, **kw.get("headers", {})}
    for i in range(tries):
        try:
            r = requests.get(url, **kw)
            r.raise_for_status()
            return r
        except Exception as e:
            if i == tries - 1:
                raise
            print(f"  拉取失败({i + 1}/{tries}) {url}: {e}, {5 * (i + 1)}s 后重试", flush=True)
            time.sleep(5 * (i + 1))


SYMBOLS = [  # (显示名, 腾讯代码)
    ("纳斯达克100", "usNDX"),
    ("标普500", "usINX"),  # 腾讯的标普代码是 INX 不是 SPX/SP500(那两个回空 day)
    ("英伟达", "usNVDA.OQ"),
    ("苹果", "usAAPL.OQ"),
    ("微软", "usMSFT.OQ"),
    ("谷歌", "usGOOGL.OQ"),
    ("亚马逊", "usAMZN.OQ"),
    ("Meta", "usMETA.OQ"),
    ("特斯拉", "usTSLA.OQ"),
]


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

    基准都取自「最新那根 bar 的日期」而非 now(), 理由见模块头。缺基准即抛错。
    """
    d = s.index[-1]
    cuts = {
        # cut = 最新那根本身 -> 基准是前一根收盘, 即当日涨跌幅
        "day": d,
        # cut = 本周一 -> 基准落到上周最后一个交易日收盘(通常上周五, 假期则更早)
        "wtd": d - pd.Timedelta(days=d.weekday()),
        "mtd": d.replace(day=1),
        "ytd": pd.Timestamp(d.year, 1, 1),
    }
    return {k: pct(s, cut) for k, cut in cuts.items()} | {
        "close": round(float(s.iloc[-1]), 2), "date": d.strftime("%Y-%m-%d")}


def metrics(symbol: str) -> dict:
    """腾讯代码 -> 当日/本周/本月/今年以来涨跌幅 + 最新收盘。"""
    return perf(closes(symbol))


def main():
    items = []
    for name, sym in SYMBOLS:
        m = metrics(sym)
        items.append({"name": name} | m)
        print(f"{name:<10} 本周 {m['wtd']:+7.2f}%  本月 {m['mtd']:+7.2f}%"
              f"  今年 {m['ytd']:+7.2f}%  ({m['date']})", flush=True)

    items.sort(key=lambda x: x["ytd"], reverse=True)
    out = WEB_DATA / "us_data.js"
    # 刻意不带 updated: 那是脚本跑的时刻不是数据的时刻, 每行自带的 date 才是真口径,
    # 摆在页头反而误导(空跑也照样刷新)。想知道 CI 什么时候跑的看 git log。
    out.write_text("export const US_PERF = " + json.dumps({"items": items}, ensure_ascii=False)
                   + ";\n", encoding="utf-8")
    print(f"已导出: {out} ({len(items)} 只)")


if __name__ == "__main__":
    main()
