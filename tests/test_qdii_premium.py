"""qdii_premium 增量翻页 + 合并自检(离线, 合成净值页)。跑: python -m tests.test_qdii_premium"""
from pipeline.stock.qdii_premium import merge, navs, sanity_check


def pages(dates, size=3):
    """日期倒序切成每页 size 条的假净值接口, 返回 (page 函数, 被请求过的页号)。"""
    ds = sorted(dates, reverse=True)
    asked = []

    def page(p):
        asked.append(p)
        return [(d, 1.0) for d in ds[(p - 1) * size:p * size]]
    return page, asked


DAYS = [f"2026-09-{i:02d}" for i in range(1, 11)]  # 10 天, 每页 3 条 -> 4 页


def test_full_pages_all():
    page, asked = pages(DAYS)
    assert sorted(navs(None, page)) == DAYS and asked == [1, 2, 3, 4, 5]  # 第 5 页空才停


def test_incremental_one_page():
    page, asked = pages(DAYS)
    navs("2026-09-08", page)  # 第 1 页是 10/09/08, 已经接上
    assert asked == [1]


def test_gap_pages_until_overlap():
    page, asked = pages(DAYS)
    got = navs("2026-09-03", page)  # 断档: 1~2 页都比历史新, 第 3 页(04/03/02)才接上
    assert asked == [1, 2, 3] and "2026-09-04" in got


def test_merge_inner_join_and_overwrite():
    old = {"code": "159696", "dates": ["2026-09-01", "2026-09-02"], "close": [2.0, 2.0], "nav": [1.8, 1.8]}
    nav = {"2026-09-02": 1.9, "2026-09-03": 1.9, "2026-06-30": 1.7}  # 09-02 东财修正; 06-30 是半年末估值行
    px = {"2026-09-02": 2.1, "2026-09-03": 2.2, "2026-09-04": 2.3}  # 09-04 净值还没出
    out = merge(old, nav, px, "159696")
    assert out["dates"] == ["2026-09-01", "2026-09-02", "2026-09-03"]
    assert out["close"] == [2.0, 2.1, 2.2] and out["nav"] == [1.8, 1.9, 1.9]
    sanity_check(out, old)


def test_sanity_rejects():
    old = {"dates": ["a", "b"], "close": [1, 1], "nav": [1, 1]}
    for out in ({"dates": [], "close": [], "nav": []},
                {"dates": ["a"], "close": [1], "nav": [1]},  # 比旧的短
                {"dates": ["a", "b"], "close": [1, 2], "nav": [1, 1]}):  # 溢价 +100%, 错位了
        try:
            sanity_check(out, old)
        except RuntimeError:
            continue
        raise AssertionError(f"应当抛错: {out}")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
