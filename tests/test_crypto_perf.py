"""crypto_perf 的 Kraken 解析 + 前端换基准表自检(离线, 合成日线)。

跑: python -m tests.test_crypto_perf
"""
import pandas as pd

from pipeline.stock.crypto_perf import bases, parse_kraken


def daily(start, end):
    """[start, end] 每天一根, 收盘 = 月*100 + 日, 方便肉眼对日期。"""
    idx = pd.date_range(start, end, freq="D")
    return pd.Series([d.month * 100 + d.day for d in idx], index=idx, dtype=float)


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
    # 代码写错/上游报错 -> 抛错, 由 main() 退回上次的 crypto_data.js
    for bad in (None, {}, {"error": ["EQuery:Unknown asset pair"], "result": {}},
                {"result": {"last": 1785600000}}):
        try:
            parse_kraken(bad)
        except RuntimeError:
            continue
        raise AssertionError(f"空结果应抛 RuntimeError: {bad}")


def test_bases_covers_four_baselines():
    # 平常的日子(月中): mtd 基准在最近 10 根之外, ytd 更远, 两根都必须单独带上
    b = bases(daily("2025-11-01", "2026-08-08"), pd.Timestamp("2026-08-08"))
    assert "2026-08-08" not in b            # 今天那根是进行中的 bar, 不是收盘, 必须剔掉
    assert b["2026-08-07"] == 807.0         # day 基准 = 昨天
    assert b["2026-08-02"] == 802.0         # wtd 基准: 08-08 是周六 -> 上周日 08-02
    assert b["2026-07-31"] == 731.0         # mtd 基准 = 上月最后一天(10 根之外)
    assert b["2025-12-31"] == 1231.0        # ytd 基准 = 去年 12-31
    assert set(b) >= {f"2026-07-{d}" for d in range(29, 32)}   # 最近 10 根连续无洞
    assert len(b) == 11                     # 10 根 + ytd(mtd 那根本来就在 10 根里)


def test_bases_rollover_day_new_base_is_yesterday():
    # 月切/年切当天: 新基准就是「昨天」, 天然落在最近 10 根里 —— 这正是窗口能归零的原因
    for today, want in (("2026-08-01", "2026-07-31"), ("2026-01-01", "2025-12-31")):
        b = bases(daily("2024-06-01", today), pd.Timestamp(today))
        assert today not in b
        assert want in b, f"{today} 查不到新基准 {want}"


def test_bases_week_rollover():
    # 周切(UTC 周一)当天: wtd 新基准 = 昨天(周日)。2026-08-03 是周一
    b = bases(daily("2025-11-01", "2026-08-03"), pd.Timestamp("2026-08-03"))
    assert "2026-08-03" not in b
    assert b["2026-08-02"] == 802.0


if __name__ == "__main__":
    for f in (test_kraken_renamed_pair, test_kraken_empty_raises,
              test_bases_covers_four_baselines, test_bases_rollover_day_new_base_is_yesterday,
              test_bases_week_rollover):
        f()
        print(f"ok  {f.__name__}")
