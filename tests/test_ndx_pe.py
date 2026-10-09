"""ndx_pe 解析 + 百分位自检(离线, 合成 HTML)。跑: python -m tests.test_ndx_pe"""
from pipeline.stock.ndx_pe import parse, percentile


def page(points, pe="28.39", date="09 October 2026"):
    data = ",".join(f"[Date.UTC({y}, {m - 1}, 1),{v:.4f}]" for y, m, v in points)
    return (f"<p>The estimated <b>Price-to-Earnings (P/E) Ratio</b> for <b>Nasdaq 100 Index</b> "
            f"is <b>{pe}</b>, calculated on <b>{date}</b>.</p>\n"
            f"<script>detailPE_data = [{data},];\ndetailPE_data_avg = [];</script>")


def months(y0, m0, n, f):
    """从 (y0, m0) 起 n 个月, 值 = f(序号)。"""
    out = []
    for i in range(n):
        y, m = divmod(m0 - 1 + i, 12)
        out.append((y0 + y, m + 1, f(i)))
    return out


def test_parse():
    date, pe, s = parse(page([(1990, 5, 24.2719), (2026, 10, 28.3888)]))
    assert date == "2026-10-09" and pe == 28.39
    assert s == [("1990-05", 24.2719), ("2026-10", 28.3888)]  # Date.UTC 月份从 0 起


def test_percentile_window():
    # 2006-10 ~ 2026-09 共 240 个月, 值 0..239; 窗口外(更早)全是 0, 当月点是 999
    pts = months(1990, 5, 197, lambda i: 0) + months(2006, 10, 240, float) + [(2026, 10, 999)]
    _, _, s = parse(page(pts))
    r = percentile("2026-10-09", 60.0, s)
    assert r["n"] == 240 and r["since"] == "2006-10"
    assert r["pct"] == 25.0  # 0..59 共 60 个 < 60; 窗口外的 0 和当月的 999 都不算


def test_truncated_series_raises():
    _, _, s = parse(page(months(2016, 10, 120, float)))
    try:
        percentile("2026-10-09", 60.0, s)
    except RuntimeError:
        return
    raise AssertionError("只有 10 年数据应当抛错")


def test_layout_change_raises():
    for html in ("<p>nothing</p>", page([(2026, 10, 28.0)]).replace("detailPE_data", "x"),
                 page([(2026, 10, 28.0)], pe="280.1")):
        try:
            parse(html)
        except RuntimeError:
            continue
        raise AssertionError("页面改版/值出格应当抛错")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
