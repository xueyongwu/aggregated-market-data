"""纳指期货(NQ主连)隔夜涨跌: 前一A股交易日15:00 -> 当日9:30 (北京时间)。

新浪全球期货分时接口只返回当前一个盘(~1380根1min, 北京6:00~次日5:00),
每日拉取按时间戳去重累积进 cache/nq_min.parquet, 攒出跨日窗口。
冷启动首日缺前一日15:00基准, 次个交易日起出数。CME休市日(美国假日)自动跳过。

A股交易日历直接取 cache/daily_pctchg.parquet 的日期列, 不额外调接口。

用法: python nq_overnight.py
输出: cache/nq_min.parquet (dt, price)
      app/src/data/nq_data.js (NQ_OVERNIGHT, EtfPage 隔夜卡片; 只含最新一个窗口)
"""
import json
import re
import time
from pathlib import Path

import pandas as pd
import requests

from paths import WEB_DATA

URL = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/"
       "GlobalFuturesService.getGlobalFuturesMinLine?symbol=NQ")
CACHE = Path("cache/nq_min.parquet")
# 只画最新一个隔夜窗口, bar 留够它就行: 常态1天, 跨周末3天, 国庆最长8天(09-30 15:00
# -> 10-08 09:30)。15 天是这条底线 + nq_night.yml 漏跑一两次的余量, 同时给缓存封顶
# ——不裁的话每工作日 +~1300 行, 而两个 workflow 每天各重写提交一次整份 parquet。
KEEP_DAYS = 15


def fetch_bars(tries: int = 3) -> pd.DataFrame:
    # 重试兜住新浪瞬时故障: 这条抓取一夜只有一次机会(5:00~6:00 切盘前), 失败即整夜
    # bar 永久丢失 —— 接口只吐当前盘, 次日补不回来。5xx 和「200 但返回错误 JSON」
    # 两种都要覆盖, 所以整段裹进 try 而非只重试 HTTP 层。
    for i in range(tries):
        try:
            r = requests.get(URL, headers={"Referer": "https://finance.sina.com.cn"},
                             timeout=20)
            r.raise_for_status()
            rows = json.loads(re.search(r"\((.*)\)", r.text, re.S).group(1))["minLine_1d"]
            # 首行比常规行多4个前缀字段(日期/昨结/交易所/空), 统一从尾部取: [-1]=时间戳 [-5]=价
            return pd.DataFrame({"dt": pd.to_datetime([x[-1] for x in rows]),
                                 "price": [float(x[-5]) for x in rows]})
        except Exception as e:
            if i == tries - 1:
                raise
            print(f"新浪 NQ 拉取失败({i + 1}/{tries}): {e}, {5 * (i + 1)}s 后重试")
            time.sleep(5 * (i + 1))


def trading_days() -> list[pd.Timestamp]:
    d = pd.read_parquet("cache/daily_pctchg.parquet", columns=["date"])["date"].unique()
    return sorted(pd.to_datetime(d))


def overnight(bars: pd.DataFrame, tdays: list[pd.Timestamp]) -> list[dict]:
    s = pd.Series(bars["price"].values, index=bars["dt"]).sort_index()
    items = []
    for prev, d in zip(tdays, tdays[1:]):
        base = s.asof(prev + pd.Timedelta(hours=15))  # 前一交易日15:00最近价
        opens = s[(s.index >= d + pd.Timedelta(hours=6)) &
                  (s.index <= d + pd.Timedelta(hours=9, minutes=30))]
        if pd.isna(base) or opens.empty:  # 缓存未覆盖 或 当日晨CME无盘
            continue
        o = float(opens.iloc[-1])
        items.append({"d": d.strftime("%Y-%m-%d"), "_prev": prev,
                      "_end": d + pd.Timedelta(hours=9, minutes=30),
                      "pct": round((o / base - 1) * 100, 2) + 0,  # +0 归一化 -0.0
                      "base": round(float(base), 2)})

    # 半程点: 上一A股收盘15:00 -> 最新bar, 下一交易日9:30后被完整点替代
    cut = tdays[-1] + pd.Timedelta(hours=15)
    # 滚动: daily_pctchg 未含当日(收盘后~17:30才出), 但 NQ 已越过更晚的A股收盘;
    # 取已越过的最近工作日15:00(其后仍有bar)为新周期基准, 15:00即换窗不等CI。
    crossed = [ts for ts in s.index
               if ts > cut and ts.hour == 15 and ts.minute == 0 and ts.weekday() < 5]
    if crossed and s.index[-1] > crossed[-1]:
        cut = crossed[-1]
    base = s.asof(cut)
    tail = s[s.index > cut]
    if not pd.isna(base) and not tail.empty:
        o = float(tail.iloc[-1])
        items.append({"d": tail.index[-1].strftime("%Y-%m-%d"),
                      "t": tail.index[-1].strftime("%Y-%m-%d %H:%M"),
                      "_prev": cut - pd.Timedelta(hours=15), "_end": tail.index[-1],
                      "pct": round((o / base - 1) * 100, 2) + 0,  # +0 归一化 -0.0
                      "base": round(float(base), 2), "partial": True})

    # 最新窗口分时: 上一A股收盘(15:00)=0 到 窗口末尾, 供 EtfPage 隔夜分时图
    if items:
        it = items[-1]
        b0, start, end = it["base"], it["_prev"] + pd.Timedelta(hours=15), it["_end"]
        seg = s[(s.index > start) & (s.index <= end)]
        it["path"] = [[it["_prev"].strftime("%m-%d ") + "15:00", 0.0]] + \
            [[t.strftime("%m-%d %H:%M"), round((p / b0 - 1) * 100, 2) + 0]
             for t, p in seg.items()]
    for it in items:
        it.pop("_prev", None); it.pop("_end", None)
    return items


def main():
    new = fetch_bars()
    if CACHE.exists():
        merged = (pd.concat([pd.read_parquet(CACHE), new])
                  .drop_duplicates("dt", keep="last").sort_values("dt"))
    else:
        merged = new
    merged = merged[merged["dt"] >= merged["dt"].max() - pd.Timedelta(days=KEEP_DAYS)]
    merged.to_parquet(CACHE, index=False)

    now = pd.Timestamp.now(tz="Asia/Shanghai")
    # 前端只画最新一个窗口的分时(带 path 的那条), 更早的隔夜点没人读, 不导出
    items = overnight(merged, trading_days())[-1:]
    payload = {"updated": now.strftime("%Y-%m-%d %H:%M"), "items": items}
    WEB_DATA.joinpath("nq_data.js").write_text(
        "export const NQ_OVERNIGHT = " + json.dumps(payload, ensure_ascii=False) + ";\n",
        encoding="utf-8")
    print(f"NQ 1min: 拉取{len(new)}根 合并后{len(merged)}根 "
          f"({merged['dt'].min()} ~ {merged['dt'].max()}) 隔夜点位 {len(items)} 天")


if __name__ == "__main__":
    main()
