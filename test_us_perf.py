"""us_perf.pct() 基准选取自检(离线, 合成日线)。跑: python test_us_perf.py"""
import pandas as pd

from us_perf import parse_income, parse_kraken, parse_surprise, pct, tech_split


def series(pairs):
    s = pd.Series({d: c for d, c in pairs})
    s.index = pd.to_datetime(s.index)
    return s.sort_index()


def test_month_base():
    # 基准必须是上月最后一根(06-30 的 100), 不是本月第一根
    s = series([("2026-06-30", 100.0), ("2026-07-01", 110.0), ("2026-07-30", 120.0)])
    assert pct(s, pd.Timestamp(2026, 7, 1)) == 20.0


def test_week_base():
    # 本周口径: cut = 最新那根所在周的周一(07-27), 基准落到上周五 07-24 的 100
    s = series([("2026-07-23", 90.0), ("2026-07-24", 100.0),
                ("2026-07-27", 105.0), ("2026-07-30", 120.0)])
    d = s.index[-1]
    assert pct(s, d - pd.Timedelta(days=d.weekday())) == 20.0


def test_year_base():
    # 跨年: 基准 12-31。1 月时年基准与月基准同为 01-01, 结果一致
    s = series([("2025-12-31", 200.0), ("2026-01-02", 210.0), ("2026-01-30", 180.0)])
    assert pct(s, pd.Timestamp(2026, 1, 1)) == -10.0


def test_prev_close():
    # 当日涨跌幅的写法: cut = 最新那根本身, 基准落到前一根
    s = series([("2026-07-29", 100.0), ("2026-07-30", 95.0)])
    assert pct(s, s.index[-1]) == -5.0


def test_no_base_raises():
    # 日线深度不够覆盖基准: 抛错, 好过悄悄拿本月第一根当基准
    s = series([("2026-07-01", 100.0), ("2026-07-30", 120.0)])
    try:
        pct(s, pd.Timestamp(2026, 7, 1))
    except RuntimeError:
        return
    raise AssertionError("缺基准时应抛 RuntimeError")


def rows(*pairs):
    return [(str(i), "", code, w) for i, (code, w) in enumerate(pairs, 1)]


def test_tech_split_residual():
    # 已归类 20 + 未收录的 GOOGL(非科技口径, 不该计入) -> 其他科技 = 53.6 - 20
    out = tech_split(rows(("NVDA", "12"), ("MSFT", "5"), ("AAPL", "3"), ("GOOGL", "9")), 53.6)
    assert {x["name"]: x["weight"] for x in out} == {
        "半导体": 12.0, "软件": 5.0, "硬件与网络设备": 3.0, "其他科技": 33.6}
    assert round(sum(x["weight"] for x in out), 2) == 53.6  # 合计必须等于板块总权重
    assert [x["name"] for x in out][:3] == ["半导体", "软件", "硬件与网络设备"]  # 按权重降序


def test_tech_split_no_negative_rest():
    # 归类结果超过板块总权重(分类口径漂了) -> 不写负数的"其他科技"
    out = tech_split(rows(("NVDA", "60")), 53.6)
    assert [x["name"] for x in out] == ["半导体"]


def surprise_rows(*triples):
    return {"earningsSurpriseTable": {"rows": [
        {"fiscalQtrEnd": q, "dateReported": d, "eps": e, "consensusForecast": c,
         "percentageSurprise": s} for q, d, e, c, s in triples]}}


def test_surprise_picks_latest():
    # 不假设上游排序: 取 dateReported 最新那行(4/30 那条), 而非表里第一行
    got = parse_surprise(surprise_rows(
        ("Dec 2025", "1/29/2026", 2.84, "2.65", "7.17"),
        ("Mar 2026", "4/30/2026", 2.01, "1.92", "4.69"),
        ("Sep 2025", "10/30/2025", 1.85, "1.73", "6.94"),
    ))
    assert got == {"qtr": "Mar 2026", "date": "2026-04-30", "eps": 2.01, "est": 1.92}


def test_surprise_empty_raises():
    # 上游给 data:null(代码不存在/无历史) -> 抛错, 由 earnings() 跳过该行
    for bad in (None, {}, {"earningsSurpriseTable": {"rows": []}}):
        try:
            parse_surprise(bad)
        except RuntimeError:
            continue
        raise AssertionError(f"空表应抛 RuntimeError: {bad}")


def income(*rows):
    """(报告期, 项目名, 金额, 同比) -> 东财响应壳子。"""
    return {"result": {"data": [{"REPORT_DATE": d, "ITEM_NAME": n, "AMOUNT": a,
                                 "YOY_RATIO": y, "REPORT_TYPE": "单季报"} for d, n, a, y in rows]}}


Q3 = ("2026-06-27 00:00:00", "主营收入", 109417000000, 16.3567)
Q3N = ("2026-06-27 00:00:00", "归属于普通股股东净利润", 29789000000, 27.1187)


def test_income_ok():
    # 只取最新报告期那一块, 营收与净利各带自己的同比; 更早的季与无关项目都不能混进来
    got = parse_income(income(Q3, ("2026-06-27 00:00:00", "毛利", 54770000000, 25.28), Q3N,
                              ("2026-03-28 00:00:00", "主营收入", 111184000000, 16.6)), "Jun 2026")
    assert got == {"rev": 109417000000.0, "revYoy": 16.36,
                   "ni": 29789000000.0, "niYoy": 27.12}


def test_income_quarter_spills_next_month():
    # 13 周财季越到下月初(AVGO 5/3 结束, 纳斯达克标 Apr 2026)仍算同一季, 不能按同月比
    got = parse_income(income(("2026-05-03 00:00:00", "主营收入", 22187000000, 47.87),
                              ("2026-05-03 00:00:00", "归属于普通股股东净利润", 9307000000, 87.51)),
                       "Apr 2026")
    assert got["rev"] == 22187000000.0


def test_income_missing_item_raises():
    # 只有营收没有净利: 整行留空, 好过表里出现一半有一半没有的行
    try:
        parse_income(income(Q3), "Jun 2026")
    except RuntimeError:
        return
    raise AssertionError("项目缺失应抛 RuntimeError")


def test_income_quarter_mismatch():
    # 东财滞后一期: 宁可这行留空, 也不能把上一季的数摆在本季公布日旁边
    for bad in (income(("2026-03-28 00:00:00", "主营收入", 111184000000, 16.6)), income(), {}):
        try:
            parse_income(bad, "Jun 2026")
        except RuntimeError:
            continue
        raise AssertionError(f"对不上财季应抛 RuntimeError: {bad}")


def test_kraken_renamed_pair():
    # 请求传 XBTUSD 响应键却是 XXBTZUSD, 不能按 pair 取; "last" 那个键不是行情
    s = parse_kraken({"error": [], "result": {"XXBTZUSD": [
        [1785542400, "62725.1", "63307.2", "62710.6", "63000.1", "0", "0", 1],
        [1785628800, "63000.1", "63084.8", "62268.5", "62989.6", "0", "0", 1]],
        "last": 1785628800}})
    assert list(s) == [63000.1, 62989.6]                 # 取第 5 列(收盘), 字符串转数
    assert s.index[-1] == pd.Timestamp("2026-08-02")     # UTC 日切
    assert s.index.is_monotonic_increasing


def test_kraken_empty_raises():
    # 代码写错/上游报错 -> 抛错, 由 main() 退回上次的加密数据, 不影响美股那几张表
    for bad in (None, {}, {"error": ["EQuery:Unknown asset pair"], "result": {}},
                {"result": {"last": 1785600000}}):
        try:
            parse_kraken(bad)
        except RuntimeError:
            continue
        raise AssertionError(f"空结果应抛 RuntimeError: {bad}")


if __name__ == "__main__":
    for f in (test_week_base, test_month_base, test_year_base, test_prev_close, test_no_base_raises,
              test_tech_split_residual, test_tech_split_no_negative_rest,
              test_surprise_picks_latest, test_surprise_empty_raises,
              test_income_ok, test_income_quarter_spills_next_month,
              test_income_missing_item_raises, test_income_quarter_mismatch,
              test_kraken_renamed_pair, test_kraken_empty_raises):
        f()
        print(f"ok  {f.__name__}")
