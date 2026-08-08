"""BTC/ETH 美元现货 当日/本周/本月/今年以来涨跌幅 -> app/src/data/crypto_data.js (CryptoPage 渲染)。

源: Kraken 公共 OHLC api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440
  无 key、无 UA 要求、无地域封锁, 一次给 720 根日线(≈2 年), 三个基准都够。
  其余源实测: 币安 451 地域封锁(GH Actions 的美国 IP 一样挂), OKX 本地通但美国 IP
  有封锁风险, Coinbase 一次只给 350 根(要 start/end 分页), 腾讯没有加密,
  新浪 hf_BTC 是 CME 比特币期货(有假日休市)不是现货。

涨跌幅口径与美股表完全一致 —— 直接复用 us_perf 的 perf()/fetch()/last(), 不另起一套。

**从 us_perf.py 拆出来的两个理由**(都不是「基准窗口」, 那个靠 bases() + 前端换基准解决):
  1. 加密 7x24, close 每跑都变。挂在 us_data.js 里会让美股那份天天被顶着提交,
     「无变化就不提交」永远不成立。
  2. us.yml 的 cron 是按美股收盘排的(UTC 1-5 = 北京周二~周六 07:00), 周日周一不跑 ——
     对 7x24 的标的本来就别扭, 浏览器拉不到实时价时降级快照最久陈旧 3 天。

用法: python -m pipeline.stock.crypto_perf
"""
import json

import pandas as pd

from pipeline.paths import WEB_DATA
from pipeline.stock.us_perf import fetch, last, perf

CRYPTO = [("比特币", "XBTUSD"), ("以太坊", "ETHUSD")]


def parse_kraken(data: dict) -> pd.Series:
    """Kraken OHLC 响应 -> 收盘序列(索引为 UTC 日期)。

    请求传 XBTUSD, 响应键却是 XXBTZUSD(Kraken 管 BTC 叫 XBT), 所以不能按请求的
    pair 去取, 只能挑 result 里除 "last" 之外的那一个键。
    行格式 [ts, o, h, l, c, vwap, vol, count], 数值全是字符串。
    """
    res = (data or {}).get("result") or {}
    rows = next((v for k, v in res.items() if k != "last"), None)
    if not rows:
        raise RuntimeError(f"Kraken 无日线: {(data or {}).get('error')}")
    s = pd.Series({x[0]: float(x[4]) for x in rows})
    s.index = pd.to_datetime(s.index, unit="s")
    return s.sort_index()


def bases(s: pd.Series, today: pd.Timestamp) -> dict:
    """前端自己换基准要用的那几根收盘: {"YYYY-MM-DD": close}。

    为什么要有这个: perf() 把「基准 -> 涨跌幅」算死成一个数字, 而四个基准都随 UTC 日切
    移动, 于是从「UTC 边界」到「下一次 CI」之间页面用的是上一档基准 —— 周切那个窗口曾长
    达 23 小时(北京周一 08:00 UTC 周切, 下次 CI 是周二 07:00)。把基准收盘一起导出去,
    前端按此刻的 UTC 时钟自己查表, 窗口就是 0, CI 什么时候跑都不影响正确性。

    带哪几根: 最近 10 根完整日线 + 当前 mtd/ytd 那两根基准。
      - 日切/周切: 新基准最远是上周日, 7 天前, 在 10 根里。
      - 月切/年切: 新基准就是「昨天」(上月最后一天 / 12-31), 同样在 10 根里。
      - 不切的日子: mtd 基准可能是 30 天前, ytd 可能是 365 天前, 所以单独带这两根。
    只有 CI 连挂 >7 天前端才会查不到, 那时它退回 perf() 算好的老数字(不比现状差)。

    今天那根是进行中的 bar(close 就是实时价, 不是收盘), 按 today 剔掉 —— 混进去会让
    前端把「今日」基准查成今天自己。
    """
    s = s[s.index < today]
    d = s.index[-1]
    keep = set(s.index[-10:])
    for cut in (d.replace(day=1), pd.Timestamp(d.year, 1, 1)):
        keep.add(s[s.index < cut].index[-1])
    return {k.strftime("%Y-%m-%d"): round(float(s[k]), 2) for k in sorted(keep)}


def crypto() -> list[dict]:
    """BTC/ETH 现货 当日/本周/本月/今年以来涨跌幅 + 前端换基准用的收盘表。

    加密 7x24 按 UTC 日切, 最新那根是当日进行中的 bar —— 于是 close 即实时价, 符合预期;
    周一必有 bar, 「本周」基准天然落到上周日收盘, perf() 不用为它开特例。
    """
    utc_today = pd.Timestamp.now(tz="UTC").normalize().tz_localize(None)
    out = []
    for name, pair in CRYPTO:
        r = fetch("https://api.kraken.com/0/public/OHLC", timeout=20,
                  params={"pair": pair, "interval": 1440})
        s = parse_kraken(r.json())
        # perf() 的 day 对加密同样成立: 7x24 连续交易, 昨日 UTC 收盘即今日开盘。
        out.append({"name": name, "code": pair} | perf(s) | {"bases": bases(s, utc_today)})
    return out


def main():
    out = WEB_DATA / "crypto_data.js"
    try:
        items = crypto()
    except Exception as e:
        # 沿用上次并标 stale(前端半透明 + 注明 + 不开实时: 那几根基准本身就旧了)。
        # 从来没成功过则不写文件, 让 workflow 的 continue-on-error 兜着, 页面留旧版。
        items = last(out, "items")
        if not items:
            raise
        for c in items:
            c["stale"] = True
        print(f"加密拉取失败({e}), 沿用上次", flush=True)

    for c in items:
        print(f"{c['name']:<6} 今日 {c['day']:+7.2f}%  本周 {c['wtd']:+7.2f}%"
              f"  本月 {c['mtd']:+7.2f}%  今年 {c['ytd']:+7.2f}%  ({c['date']})", flush=True)

    # 刻意不带 updated: 那是脚本跑的时刻不是数据的时刻。每行自己的 date 才是真口径,
    # 而且前端有实时价时连它都不看了(直接按此刻的 UTC 时钟查 bases)。
    out.write_text("export const CRYPTO = " + json.dumps({"items": items}, ensure_ascii=False) + ";\n",
                   encoding="utf-8")
    print(f"已导出: {out} ({len(items)} 个)")


if __name__ == "__main__":
    main()
