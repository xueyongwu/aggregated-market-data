"""腾讯快照解析 + baostock 不可用降级 自检: python -m tests.test_tencent_parse"""
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

from pipeline.stock import median_trend as mt
from pipeline.stock.median_trend import parse_tencent_quotes

# dump 的毫秒戳是 Asia/Shanghai 零点(见 ths_date), 测试里也得按这个口径造
DAY1 = int(pd.Timestamp("2026-07-21", tz="Asia/Shanghai").timestamp() * 1000)
DAY2 = int(pd.Timestamp("2026-07-22", tz="Asia/Shanghai").timestamp() * 1000)


def line(sym, *, vol="1096087", stamp="20260721161447", pct="-2.08"):
    f = ["1", "浦发银行", sym[2:], "8.95", "9.14", "9.12", vol] + ["0"] * 23
    f += [stamp, "-0.19", pct] + ["0"] * 20      # [30]时间戳 [31]涨跌额 [32]涨跌幅
    return f'v_{sym}="' + "~".join(f) + '"'


SYM2CODE = {"sh600000": "sh.600000", "sz000001": "sz.000001", "sz300750": "sz.300750"}


def with_dead_baostock(tencent_result, body):
    """在「baostock 全挂 + 缓存里有昨日数据」的环境下跑 body(), 返回其结果。"""
    def boom(*a, **k):
        raise RuntimeError("baostock login failed: 网络接收错误。")

    orig = (mt.RAW, mt.bs_session, mt.update_today_tencent, mt.fetch_history,
            mt.fetch_history_dump)
    seen = {}
    with tempfile.TemporaryDirectory() as tmp:
        mt.RAW = Path(tmp) / "raw.parquet"
        pd.DataFrame({"date": pd.Timestamp("2026-07-21"),
                      "code": ["sh.600000", "sz.000001"], "pct": [1.0, -1.0]}).to_parquet(mt.RAW)
        mt.bs_session = boom     # login 就失败, 日历/代码表都拿不到
        mt.fetch_history = boom  # baostock 挂了就不该再走回退拉取
        mt.fetch_history_dump = boom  # 同花顺也当挂: 三个源全挂时必须不写盘
        def fake_tencent(codes, day):
            seen["codes"] = codes
            return tencent_result

        mt.update_today_tencent = fake_tencent
        try:
            return body(), seen
        finally:
            (mt.RAW, mt.bs_session, mt.update_today_tencent, mt.fetch_history,
             mt.fetch_history_dump) = orig


def with_live_baostock(days, tencent_result, body, dump_ok=True):
    """baostock 正常的环境: 日历返回 days, 代码表返回两只, 缓存里只有 07-21。

    dump_ok=False 模拟同花顺也不可用, 用来验证还能落到 baostock 窗口那条老路。
    """
    @contextmanager
    def ok_session():
        yield None

    orig = (mt.RAW, mt.bs_session, mt.trading_days, mt.all_a_codes,
            mt.update_today_tencent, mt.fetch_history, mt.fetch_history_dump)
    seen = {}
    with tempfile.TemporaryDirectory() as tmp:
        mt.RAW = Path(tmp) / "raw.parquet"
        pd.DataFrame({"date": pd.Timestamp("2026-07-21"),
                      "code": ["sh.600000", "sz.000001"], "pct": [1.0, -1.0]}).to_parquet(mt.RAW)
        mt.bs_session = ok_session
        mt.trading_days = lambda start, end: days
        mt.all_a_codes = lambda day: ["sh.600000", "sz.000001", "sh.600004"]  # 含当天新股

        def fake_tencent(codes, day):
            seen["tencent"] = codes
            return tencent_result

        def fake_fetch(codes, start, end, skip_done=True):
            seen["baostock_window"] = (start, end)
            return "from_baostock"

        def fake_dump(start, end, recent_only=False):
            seen["dump_window"] = (start, end, recent_only)
            if dump_ok:  # 固定只到 07-22, 用来验证 end 更晚时的「dump 里没这天」保护
                return pd.DataFrame({"date": pd.to_datetime(["2026-07-22"]),
                                     "code": ["sh.600000"], "pct": [3.0]})
            raise RuntimeError("同花顺 dump 不可用")

        mt.update_today_tencent, mt.fetch_history = fake_tencent, fake_fetch
        mt.fetch_history_dump = fake_dump
        try:
            return body(), seen
        finally:
            (mt.RAW, mt.bs_session, mt.trading_days, mt.all_a_codes,
             mt.update_today_tencent, mt.fetch_history, mt.fetch_history_dump) = orig


def test_normal_path_uses_baostock_codes():
    """日历齐、无缺口: 走腾讯, 代码表用 baostock 的(含当天新股)。"""
    snap = pd.DataFrame({"date": pd.Timestamp("2026-07-22"), "code": ["sh.600000"], "pct": [2.0]})
    got, seen = with_live_baostock(["2026-07-21", "2026-07-22"], snap,
                                   lambda: mt.update_incremental("2026-07-22"))
    assert got is snap and "baostock_window" not in seen and "dump_window" not in seen, seen
    assert seen["tencent"] == ["sh.600000", "sz.000001", "sh.600004"], seen


def test_gap_falls_back_to_dump():
    """缓存缺了 end 之前的交易日: 腾讯只给当日补不了, 走同花顺 10 日 dump。"""
    got, seen = with_live_baostock(["2026-07-20", "2026-07-21", "2026-07-22"], None,
                                   lambda: mt.update_incremental("2026-07-22"))
    assert list(got["pct"]) == [3.0], got
    assert "tencent" not in seen and "baostock_window" not in seen, seen
    assert seen["dump_window"] == ("2026-07-12", "2026-07-22", True), seen


def test_gap_dump_dead_falls_back_to_baostock():
    """同花顺也挂了: 缺口仍要靠 baostock 窗口补上(慢, 且缺北交所, 但比不出数强)。"""
    got, seen = with_live_baostock(["2026-07-20", "2026-07-21", "2026-07-22"], None,
                                   lambda: mt.update_incremental("2026-07-22"), dump_ok=False)
    assert got == "from_baostock", got
    assert seen["baostock_window"][1] == "2026-07-22", seen


def test_dump_without_end_day_writes_nothing():
    """dump 里没有 end 那天(当日还没定版): 不写盘, 免得只刷新 updated 白提交一次。"""
    got, seen = with_live_baostock(["2026-07-21", "2026-07-22", "2026-07-23"], None,
                                   lambda: mt.update_incremental("2026-07-23"))
    assert "dump_window" in seen, seen  # 前提: 确实走到了 dump 分支
    assert got is None, got


def test_non_trading_day_skipped():
    """end 不在交易日历里: 直接不写。"""
    got, seen = with_live_baostock(["2026-07-21"], None,
                                   lambda: mt.update_incremental("2026-07-22"))
    assert got is None and seen == {}, (got, seen)


def test_degrade_to_cached_codes():
    """baostock 挂了: 代码表退回缓存, 腾讯照常出数。"""
    snap = pd.DataFrame({"date": pd.Timestamp("2026-07-22"),
                         "code": ["sh.600000"], "pct": [2.0]})
    got, seen = with_dead_baostock(snap, lambda: mt.update_incremental("2026-07-22"))
    assert got is snap, got
    assert seen["codes"] == ["sh.600000", "sz.000001"], seen  # 取自缓存最近交易日


def test_degrade_no_quotes_writes_nothing():
    """baostock 挂 + 腾讯也没当日数据(如节假日): 不写盘, 也不去 baostock 回退。"""
    got, _ = with_dead_baostock(None, lambda: mt.update_incremental("2026-07-22"))
    assert got is None, got


def test_update_without_cache_refetches_all():
    """缓存丢了(daily_pctchg 走 actions/cache, 7 天不访问被逐出, 春节必现)还带 --update:
    必须走全量重拉。走增量的话只补最近 10 天窗口, median_data.js 从「今年以来」
    静默塌成 10 天 —— sanity_check 不查条数, 塌了照样 commit。"""
    orig = (mt.RAW, mt.all_a_codes, mt.fetch_history_dump, mt.update_incremental,
            mt.export_data_js, sys.argv)
    seen = {}

    def fake_full(start, end, recent_only=False):
        seen["full"] = (start, end, recent_only)
        return pd.DataFrame({"date": [pd.Timestamp.now().normalize()],
                             "code": ["sh.600000"], "pct": [1.0]})

    with tempfile.TemporaryDirectory() as tmp:
        mt.RAW = Path(tmp) / "missing.parquet"  # 缓存不存在
        mt.all_a_codes = lambda day: ["sh.600000"]
        mt.fetch_history_dump = fake_full
        mt.update_incremental = lambda end: seen.setdefault("incremental", True)
        mt.export_data_js = lambda df, out: seen.setdefault("exported", len(df))
        sys.argv = ["median_trend", "--update", "--end", "2026-07-22"]
        try:
            mt.main()
        finally:
            (mt.RAW, mt.all_a_codes, mt.fetch_history_dump, mt.update_incremental,
             mt.export_data_js, sys.argv) = orig
    assert "incremental" not in seen, seen
    assert seen.get("full", ("", "", None))[0].endswith("-01-01"), seen  # 从年初拉, 不是 10 天窗口
    assert seen.get("full", ("", "", None))[2] is False, seen          # 全量 dump, 不是 10 日增量那份
    assert seen.get("exported") == 1, seen


def save_raw_range(dates):
    """在临时 RAW 上跑 save_raw, 返回裁剪后剩下的日期范围。"""
    orig = mt.RAW
    with tempfile.TemporaryDirectory() as tmp:
        mt.RAW = Path(tmp) / "raw.parquet"
        try:
            df = mt.save_raw(pd.DataFrame({"date": pd.to_datetime(dates),
                                           "code": "sh.600000", "pct": 1.0}))
            return df["date"].min(), df["date"].max()
        finally:
            mt.RAW = orig


def test_save_raw_normalizes_object_dates():
    """无缓存那趟: 空占位帧把 date 列 concat 成 object, save_raw 要归一回 datetime64。
    不归一的话 main 末尾 df["date"] >= "%Y-01-01" 直接 TypeError(全量重拉 13 分钟后才炸)。"""
    orig = mt.RAW
    with tempfile.TemporaryDirectory() as tmp:
        mt.RAW = Path(tmp) / "raw.parquet"
        empty = pd.DataFrame(columns=["date", "code", "pct"])  # object dtype
        real = pd.DataFrame({"date": pd.to_datetime(["2026-07-21", "2026-07-22"]),
                             "code": "sh.600000", "pct": 1.0})
        try:
            df = mt.save_raw(pd.concat([empty, real], ignore_index=True))
        finally:
            mt.RAW = orig
    assert df["date"].dtype.kind == "M", df["date"].dtype
    assert (df["date"] >= "2026-01-01").all()  # main 末尾就是这么比的


def test_save_raw_cuts_to_year_start():
    """年中: 切到今年 1 月 1 日, 今年的一天不少。"""
    lo, hi = save_raw_range(pd.date_range("2025-07-16", "2026-07-30", freq="D"))
    assert (lo, hi) == (pd.Timestamp("2026-01-01"), pd.Timestamp("2026-07-30")), (lo, hi)


def test_save_raw_keeps_30d_across_new_year():
    """跨年: 单按今年切会只剩几天, 保底 30 天要把去年 12 月的尾巴留住。"""
    lo, hi = save_raw_range(pd.date_range("2026-11-01", "2027-01-05", freq="D"))
    assert (lo, hi) == (pd.Timestamp("2026-12-06"), pd.Timestamp("2027-01-05")), (lo, hi)


def test_dump_pct_adjusts_for_dividends():
    """dump 是未复权价, 除权日必须用复权事件还原, 否则单只能偏 4pp 把中位数拖歪。

    顺带守住另外三件事: 停牌(成交量 0)剔除、北交所进池、非 A 股代码不进池。
    """
    bars = pd.DataFrame({
        "thscode": ["600000.SH"] * 2 + ["920002.BJ"] * 2 + ["000601.SZ"] * 2
                   + ["399001.SZ"] * 2 + ["600004.SH"] * 2,
        "date_ms": [DAY1, DAY2] * 5,
        # 600000 除权日: 收 9.0, 前收 10.0, 每股分红 0.5 -> 裸算 -10%, 实际 -5%
        # 000601 同日既分红又送股, 且上游给了重复行(见 fetch_history_dump 里的去重)
        "close_price": [10.0, 9.0, 20.0, 22.0, 10.0, 5.0, 3000.0, 3300.0, 8.0, 8.0],
        "volume": [1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 0],  # 600004 次日停牌
    })
    adj = pd.DataFrame({
        "thscode": ["600000.SH", "000601.SZ", "000601.SZ", "000601.SZ"],
        "ex_date_ms": [DAY2] * 4,
        "dividend_per_share": [0.5, 0.2, 0.0, 0.2],   # 末行与首行完全重复 -> 应去重不叠加
        "per_share_bonus": [0.0, 0.0, 1.0, 0.0],      # 10 送 10
    })
    orig = (mt.RAW, mt.ths_dump)
    with tempfile.TemporaryDirectory() as tmp:
        mt.RAW = Path(tmp) / "raw.parquet"
        mt.ths_dump = lambda kind, columns=None: (
            adj if kind == "adjustment-factors" else bars)[columns]
        try:
            out = mt.fetch_history_dump("2026-07-22", "2026-07-22")
        finally:
            (mt.RAW, mt.ths_dump) = orig
    got = dict(zip(out["code"], out["pct"].round(4)))
    assert got["sh.600000"] == -5.0, got          # (9.0 + 0.5) / 10 - 1
    assert got["bj.920002"] == 10.0, got          # 北交所进池
    assert got["sz.000601"] == 2.0, got           # (5.0 * 2 + 0.2) / 10 - 1, 重复行不叠加
    assert "sz.399001" not in got, got            # 指数不是 A 股
    assert "sh.600004" not in got, got            # 停牌: 成交量 0
    assert set(out["date"]) == {pd.Timestamp("2026-07-22")}, out  # 前一天只用来当基准


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)

    text = ";".join([
        line("sh600000"),
        line("sz000001", vol="0", pct="0.00"),          # 停牌: 成交量 0, pct 恒 0
        line("sz300750", stamp="20260720161447"),        # 陈旧: 非当日快照
        line("sh601398"),                                # 不在本批 code 表内
    ])
    got = parse_tencent_quotes(text, "20260721", SYM2CODE)
    assert got == {"sh.600000": -2.08}, got

    assert parse_tencent_quotes('v_sh600000="1~名~600000~8.95"', "20260721", SYM2CODE) == {}  # 字段截断
    assert parse_tencent_quotes("", "20260721", SYM2CODE) == {}
    print("ok")


if __name__ == "__main__":
    main()
