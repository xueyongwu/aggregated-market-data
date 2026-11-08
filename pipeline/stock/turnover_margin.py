"""A股页的两张图: 沪深两市成交额 -> turnover_data.js, 两融余额 -> margin_data.js。

两个独立的源、独立的文件: 一个挂了不拖累另一个, 拉不到就不写, 页面留上次那份。
任一失败则退出码非 0(workflow 那步 continue-on-error, 只为日志里看得见)。

turnover_data.js 的日期列还兼任 A 股交易日历(nq_overnight.trading_days 读它)。

用法: python -m pipeline.stock.turnover_margin
环境变量: HITHINK_FINANCE_API_KEY(成交额要, 两融不要)
"""
import json
import sys
from pathlib import Path

import pandas as pd
import requests

from pipeline.paths import WEB_DATA
from pipeline.stock.ths import ths_date, ths_get

TURNOVER_DAYS = 1826  # 同花顺窗口硬上限 ~5 年, 见下面的坑 1


def export_turnover(out: Path):
    """沪深两市日成交额(万亿) -> turnover_data.js。

    同花顺 /a-share-index/prices/historical 除收盘外还给 turnover(成交额, 元), 白拿:
    沪(000001.SH) + 深(399001.SZ) 就是全市场口径 —— 深证成指返回的是**全深市**成交额
    而非成分股(与深证综指 399106 逐位一致, 也与东财 push2his 对得上)。北交所拿不到
    (899050 无论 .BJ 还是 .SH 都回 Unknown thscode), 占比 <1%, 不补。

    三个坑:
    1. 窗口超 ~5 年**静默回空**而不是报错(实测 1826 天回 1210 根, 1830 天回 0 根),
       所以 TURNOVER_DAYS 别往大调; 跨 10 年时它 code=1003 说的 "at most 10 years"
       是骗人的。空了必须抛, 别写出一份空数据。要更长的历史只能按 5 年分段拼。
    2. 盘中跑拿到的是半天成交额, 画出来是一根假的地量柱 —— 未收盘就丢掉最后那天。
       这也保证了交易日历里不会提前出现「今天」(nq_overnight 靠它判断 A 股收盘)。
    3. 不带 updated 字段(同 us_data.js): 节假日重跑数据一模一样, 有时间戳就每次都是
       新字节, 白刷一次 commit。数据到哪天看 dates[-1]。
    """
    now = pd.Timestamp.now(tz="Asia/Shanghai")
    win = dict(interval="1d",
               start=int((now - pd.Timedelta(days=TURNOVER_DAYS)).timestamp() * 1000),
               end=int(now.timestamp() * 1000))

    def amount(code: str) -> pd.Series:
        rows = ths_get("/a-share-index/prices/historical", thscode=code, **win)["item"]
        if not rows:
            raise RuntimeError(f"{code} 返回空(窗口超上限也是这个表现)")
        return pd.Series([x["turnover"] for x in rows],
                         index=ths_date(pd.Series([x["date_ms"] for x in rows]))).sort_index()

    amt = ((amount("000001.SH") + amount("399001.SZ")) / 1e12).dropna()  # 元 -> 万亿
    if amt.index[-1].date() == now.date() and now.hour < 15:
        amt = amt.iloc[:-1]
    amt = amt.round(3)
    if len(amt) < 200 or not 0 < amt.max() < 20:
        raise RuntimeError(f"成交额不合常理: {len(amt)} 个交易日, 峰值 {amt.max()} 万亿")

    # 20 日均线交给前端算: 区间筛选切片后仍要按完整序列算均线, 存一份反而两头对不齐
    payload = {"dates": [d.strftime("%Y-%m-%d") for d in amt.index], "amt": amt.tolist()}
    out.write_text("export const TURNOVER = " + json.dumps(payload) + ";\n", encoding="utf-8")
    print(f"成交额已导出: {out}  ({len(amt)} 交易日 {payload['dates'][0]}~{payload['dates'][-1]}, "
          f"最新 {amt.iloc[-1]} 万亿)")


MARGIN_API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
MARGIN_PAGE = 800  # 东财硬上限: pageSize 填 5000 也只回 800, 且不报错


def export_margin(out: Path):
    """沪深两融余额 + 融资余额占流通市值比 -> margin_data.js。

    源是东财 datacenter 的 RPTA_RZRQ_LSHJ(沪深两市融资融券汇总), 2010-03-31 起
    全历史一次拉全(3989 个交易日, ~105KB), 实测 5 次请求 1.1 秒且不限流 —— 它跟
    push2his(连打五六次就 RemoteDisconnected)不是同一个端点, 别按那个的经验加节流。
    **同花顺没有两融**(/margin /rzrq /a-share/margin* 全 404), 所以这条只有东财一个源。

    三个坑:
    1. pageSize 上限 800, 必须按 result.pages 翻页 —— 填大既不报错也不给更多,
       少翻一页就是静默丢掉最近三年。
    2. 占流通市值比那条线不能省: 2026-06-25 余额 3.03 万亿是历史新高, 占比只有
       2.81%; 2015-07-03 占比 4.70% 时余额才 1.91 万亿。只画余额会得出「杠杆比
       2015 还疯」的反结论。融券余额则相反 —— 293 亿 vs 融资 2.64 万亿, 画上去
       就是条贴着 x 轴的线, 不导出。
    3. 交易所是收盘后当晚才公布当日余额, update.yml 两条 cron(北京 16:30/18:00)
       都赶不上, **这张图恒定比同页成交额慢一天**, 不是故障。每趟都全量重拉, 缺的
       次日自己补上, 所以不必为它单加 cron, 也不做增量。
    不带 updated 字段, 同 export_turnover(那边的坑 3)。
    """
    rows, page, pages = [], 1, 1
    while page <= pages:
        r = requests.get(MARGIN_API, timeout=30, headers={"User-Agent": "Mozilla/5.0"},
                         params={"reportName": "RPTA_RZRQ_LSHJ", "source": "WEB", "client": "WEB",
                                 "columns": "DIM_DATE,RZRQYE,RZYEZB", "sortColumns": "dim_date",
                                 "sortTypes": 1, "pageSize": MARGIN_PAGE, "pageNumber": page})
        r.raise_for_status()
        res = r.json().get("result") or {}
        rows += res.get("data") or []
        pages, page = res.get("pages") or 1, page + 1
    if not rows:
        raise RuntimeError("东财两融返回空")

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["DIM_DATE"])
    df = df.drop_duplicates("date").sort_values("date")
    bal = (df["RZRQYE"].astype(float) / 1e12).round(3)  # 融资+融券余额, 元 -> 万亿
    ratio = df["RZYEZB"].astype(float).round(2)         # 融资余额 / 流通市值, %
    if len(df) < 2000 or not 0 < bal.max() < 10 or not 0 < ratio.max() < 10:
        raise RuntimeError(f"两融不合常理: {len(df)} 天, 峰值 {bal.max()} 万亿 / {ratio.max()}%")

    payload = {"dates": df["date"].dt.strftime("%Y-%m-%d").tolist(),
               "bal": bal.tolist(), "ratio": ratio.tolist()}
    out.write_text("export const MARGIN = " + json.dumps(payload) + ";\n", encoding="utf-8")
    print(f"两融已导出: {out}  ({len(df)} 交易日 {payload['dates'][0]}~{payload['dates'][-1]}, "
          f"最新 {bal.iloc[-1]} 万亿 / 占流通市值 {ratio.iloc[-1]}%)")


def main():
    failed = []
    for name, fn, out in (("成交额", export_turnover, "turnover_data.js"),
                          ("两融", export_margin, "margin_data.js")):
        try:
            fn(WEB_DATA / out)
        except Exception as e:  # 各管各的: 一个挂了另一个照写
            print(f"{name}导出失败(保留上次的 {out}): {e}", flush=True)
            failed.append(name)
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
