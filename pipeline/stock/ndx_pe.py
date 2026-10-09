"""纳指100 市盈率 + 近 20 年百分位 -> app/src/data/pe_data.js (DcaPage 策略卡的估值定额档位)。

源: worldperatio https://worldperatio.com/index/nasdaq-100/
没有接口, 从页面里抠两样:
  - 当前值: 正文那句 "... is <b>28.39</b>, calculated on <b>09 October 2026</b>", 每个美股交易日更新
  - 历史: Highcharts 的 detailPE_data, 月度, 1990-05 起; 最后一个点是当月至今(= 当前值)
免费源里只有它够 20 年: 蛋卷 NDX 估值从 2016 年起, akshare 的韭圈儿接口已删。
历史按月不按日, 对周定投换档够用 —— 20 年 240 个点, 采样粒度不改分布形状。

百分位 = 近 20 年月度点里低于当前值的占比(不含当月那个点, 它就是当前值本身)。
页面改版即解析失败抛错, 不写文件, 页面留上次那份(带 date, 陈旧看得出来)。

用法: python -m pipeline.stock.ndx_pe
"""
import json
import re
from datetime import datetime

from pipeline.paths import WEB_DATA
from pipeline.stock.us_perf import fetch

URL = "https://worldperatio.com/index/nasdaq-100/"
YEARS = 20
MIN_POINTS = 200  # 20 年应有 ~240 个月度点, 少太多说明序列被截断了, 百分位会失真


def parse(html: str) -> tuple[str, float, list[tuple[str, float]]]:
    """-> (数据日期 YYYY-MM-DD, 当前市盈率, [(YYYY-MM, 月度市盈率)...] 升序)。"""
    m = re.search(r"is <b>([\d.]+)</b>, calculated on <b>(\d{1,2} \w+ \d{4})</b>", html)
    if not m:
        raise RuntimeError("找不到当前市盈率那句, 页面改版了")
    pe = float(m.group(1))
    date = datetime.strptime(m.group(2), "%d %B %Y").strftime("%Y-%m-%d")

    i = html.find("detailPE_data =")
    if i < 0:
        raise RuntimeError("找不到 detailPE_data, 页面改版了")
    body = html[i:html.find(";", i)]
    # Date.UTC 的月份从 0 起
    series = [(f"{int(y)}-{int(mo) + 1:02d}", float(v))
              for y, mo, v in re.findall(r"Date\.UTC\((\d+),\s*(\d+),\s*\d+\)\s*,\s*([\d.]+)", body)]
    if not series:
        raise RuntimeError("detailPE_data 解析为空")
    if not 5 < pe < 100:  # 体检: 纳指100 历史上 ~12~90 之间, 出格说明抠错了字段
        raise RuntimeError(f"市盈率异常: {pe}")
    return date, pe, sorted(series)


def percentile(date: str, pe: float, series: list[tuple[str, float]], years: int = YEARS) -> dict:
    """当前值在近 years 年月度点里的百分位(%)。窗口 = [当月往前 years 年, 当月), 不含当月。"""
    month = date[:7]
    since = f"{int(month[:4]) - years}{month[4:]}"
    hist = [v for d, v in series if since <= d < month]
    if len(hist) < MIN_POINTS:
        raise RuntimeError(f"近 {years} 年只有 {len(hist)} 个月度点(< {MIN_POINTS}), 序列被截断")
    return {"date": date, "pe": pe,
            "pct": round(100 * sum(v < pe for v in hist) / len(hist), 1),
            "since": since, "n": len(hist)}


def main():
    out = percentile(*parse(fetch(URL, timeout=30).text))
    print(f"{out['date']}  PE {out['pe']}  近 {YEARS} 年百分位 {out['pct']}%  "
          f"({out['since']} 起 {out['n']} 个月)", flush=True)
    path = WEB_DATA / "pe_data.js"
    # 不带 updated: 周末重跑数据一样, 有时间戳就白刷一次 commit。date 是数据自己的日期
    path.write_text("export const NDX_PE = " + json.dumps(out, ensure_ascii=False) + ";\n", encoding="utf-8")
    print(f"已导出: {path}")


if __name__ == "__main__":
    main()
