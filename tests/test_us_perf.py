"""us_perf.pct() 基准选取自检(离线, 合成日线)。跑: python -m tests.test_us_perf"""
import pandas as pd

from pipeline.stock.us_perf import pct, perf


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


def test_perf_raises_without_base():
    # 年内新上市(缺上年末基准): 整只抛错, 由 main() 让整份不写, 好过拿错基准
    s = series([("2026-07-15", 50.0), ("2026-09-30", 100.0), ("2026-10-02", 110.0)])
    try:
        perf(s)
    except RuntimeError:
        return
    raise AssertionError("缺基准时 perf 应抛 RuntimeError")


if __name__ == "__main__":
    for f in (test_week_base, test_month_base, test_year_base, test_prev_close, test_no_base_raises,
              test_perf_raises_without_base):
        f()
        print(f"ok  {f.__name__}")
