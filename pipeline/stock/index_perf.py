"""宽基/特色指数今年以来涨跌幅 -> app/src/data/idx_data.js (IndexPage 排名条形图)。

数据源:
  tx      腾讯 web.ifzq.gtimg.cn 日线接口      沪深/北证/港股指数, 一次请求给全年日线
  sina    akshare stock_zh_index_daily        tx 的备源(akshare 封装随网站变, 故降为备)
  csindex akshare stock_zh_index_hist_csindex 中证2000(新浪/腾讯都无 932000)
  ths     同花顺官方 fuyao.aicubes.cn(要 API Key) 微盘股/可转债(883418.TI/883981.TI, 同花顺自编指数)

基准 = 上年最后交易日收盘, YTD = 最新收盘/基准 - 1。
单指数全部源失败时退回上次 idx_data.js 里的值并标 stale, 页面灰显; 没有旧值才少一根条。

环境变量: HITHINK_FINANCE_API_KEY(同花顺, 只有 ths 那两条指数用得到)

用法: python -m pipeline.stock.index_perf
"""
import json
from pathlib import Path

import pandas as pd

from pipeline.paths import WEB_DATA

TX = ("tx", "sina")  # 腾讯为主, 新浪兜底

INDICES = [  # (名称, 源(按序尝试), 代码)
    ("上证50", TX, "sh000016"),
    ("沪深300", TX, "sh000300"),
    ("中证A500", TX, "sh000510"),
    ("中证500", TX, "sh000905"),
    ("中证1000", TX, "sh000852"),
    ("中证2000", ("csindex",), "932000"),
    ("微盘股", ("ths",), "883418.TI"),
    ("创业板50", TX, "sz399673"),
    ("科创50", TX, "sh000688"),
    ("科创100", TX, "sh000698"),
    ("科创200", TX, "sh000699"),
    ("北证50", TX, "bj899050"),
    ("可转债", ("ths",), "883981.TI"),
    # 港股: 腾讯同一个 fqkline 接口, 代码前缀 hk。只挂 tx —— akshare 的 stock_zh_index_daily
    # 是 A 股口径不认 hk 代码, 挂了也是白挂一次。注意是港币计价, 与 A 股同图看趋势可以,
    # 严格说隔着汇率不同币种。
    ("恒生指数", ("tx",), "hkHSI"),
    ("恒生科技", ("tx",), "hkHSTECH"),
]


def tencent_close(symbol: str) -> pd.Series:
    """腾讯日线收盘序列。400 根足够覆盖 YTD + 上年末基准(接口上限 800)。"""
    import requests
    r = requests.get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                     params={"param": f"{symbol},day,,,400,qfq"},
                     headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    d = r.json()["data"][symbol]
    rows = d.get("qfqday") or d.get("day") or []
    if not rows:
        raise RuntimeError("腾讯无此指数日线")  # 932000/883* 就是这种
    s = pd.Series({x[0]: float(x[2]) for x in rows})  # 行: [date, open, close, high, low, ...]
    s.index = pd.to_datetime(s.index)
    return s.sort_index()


def sina_close(symbol: str) -> pd.Series:
    import akshare as ak
    df = ak.stock_zh_index_daily(symbol=symbol)
    return pd.Series(df["close"].values, index=pd.to_datetime(df["date"]))


def csindex_close(symbol: str, start: str, end: str) -> pd.Series:
    import akshare as ak
    df = ak.stock_zh_index_hist_csindex(symbol=symbol, start_date=start, end_date=end)
    return pd.Series(df["收盘"].values, index=pd.to_datetime(df["日期"]))


def ths_close(symbol: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.Series:
    """同花顺自编指数日线(883418.TI 微盘股 / 883981.TI 可转债), 走官方 API。

    原先是直连 d.10jqka.com.cn 的内部接口, 得先用 py_mini_racer 跑 akshare 打包的
    ths.js 算出反爬 cookie `v` —— 全项目最脆的一处, 人家改一次 js 就断。官方 API
    同一份数据(2026-08-20 收盘逐位一致: 微盘股 2082.254 / 可转债 2033.24), 换掉了。
    这两条没有备源: 只有同花顺自己编这两个指数。拉不到就走 main 里的 stale 降级。
    """
    from pipeline.stock.median_trend import ths_date, ths_get  # 同花顺客户端在那边, 别重写一份

    d = ths_get("/a-share-index/prices/historical", thscode=symbol, interval="1d",
                start=int(start.timestamp() * 1000), end=int(end.timestamp() * 1000))
    rows = d["item"]
    if not rows:
        raise RuntimeError("同花顺无此指数日线")
    return pd.Series([float(x["close_price"]) for x in rows],
                     index=ths_date(pd.Series([x["date_ms"] for x in rows]))).sort_index()


def close_series(src: str, sym: str, now: pd.Timestamp) -> pd.Series:
    if src == "tx":
        return tencent_close(sym)
    if src == "sina":
        return sina_close(sym)
    if src == "csindex":
        return csindex_close(sym, f"{now.year - 1}1201", now.strftime("%Y%m%d"))
    return ths_close(sym, pd.Timestamp(f"{now.year - 1}-12-01", tz="Asia/Shanghai"), now)


def ytd_item(name: str, src: str, sym: str, now: pd.Timestamp, jan1: pd.Timestamp) -> dict:
    """单指数 YTD。历史深度不够(如腾讯的 bj899050 只给 1 根)同样抛错, 好让调用方换源。"""
    s = close_series(src, sym, now)
    prev_year = s[s.index < jan1]
    cur = s[s.index >= jan1]
    if prev_year.empty or cur.empty:
        raise RuntimeError(f"日线不覆盖上年末基准({len(s)} 根)")
    return {"name": name,
            "ytd": round((cur.iloc[-1] / prev_year.iloc[-1] - 1) * 100, 2),
            "close": round(float(cur.iloc[-1]), 2),
            "date": cur.index[-1].strftime("%Y-%m-%d"),
            "src": src}


def last_good(out: Path) -> dict:
    """上次导出的 {指数名: 条目}, 供单指数失败时降级复用。"""
    try:
        t = out.read_text(encoding="utf-8")
        blob = json.loads(t[t.index("=") + 1:t.rindex(";")])
        return {x["name"]: x for x in blob["items"]}
    except Exception:
        return {}


def main():
    now = pd.Timestamp.now(tz="Asia/Shanghai")
    jan1 = pd.Timestamp(f"{now.year}-01-01")
    out = WEB_DATA / "idx_data.js"
    old = last_good(out)
    items = []
    for name, srcs, sym in INDICES:
        item, err = None, None
        for src in srcs:
            try:
                item = ytd_item(name, src, sym, now, jan1)
                break
            except Exception as e:
                err = f"{src} {sym}: {e}"
                print(f"  {name} {err}", flush=True)
        if item is None:
            prev = old.get(name)  # 全源失败: 用上次的值并标 stale, 好过页面无声少一根条
            if prev:
                items.append(prev | {"stale": True})
                print(f"stale {name}: 沿用 {prev['date']} 的数据", flush=True)
            else:
                print(f"skip {name}({err})", flush=True)
            continue
        items.append(item)
        print(f"{name:<6} {item['ytd']:+7.2f}%  ({item['date']}, {item['src']})", flush=True)

    if not items:
        raise SystemExit("全部指数拉取失败, 不写 idx_data.js")
    items.sort(key=lambda x: x["ytd"], reverse=True)
    payload = {"updated": now.strftime("%Y-%m-%d %H:%M"), "items": items}
    out.write_text("export const INDEX_YTD = " + json.dumps(payload, ensure_ascii=False) + ";\n",
                   encoding="utf-8")
    print(f"已导出: {out} ({len(items)} 个指数)")


if __name__ == "__main__":
    main()
