"""成交额两市相加 / 两融翻页 / 空返回抛错 自检(离线): python -m tests.test_turnover_margin"""
import json
import tempfile
import types
from pathlib import Path

import pandas as pd

from pipeline.stock import turnover_margin as tm


def read_js(out: Path) -> dict:
    t = out.read_text(encoding="utf-8")
    return json.loads(t[t.index("=") + 1:t.rindex(";")])


def with_ths_turnover(days, sh, sz):
    """假的同花顺指数日线 -> export_turnover 写出的 payload。"""
    def fake(path, **q):
        assert path == "/a-share-index/prices/historical", path
        amt = sh if q["thscode"].endswith(".SH") else sz
        return {"item": [{"date_ms": int(pd.Timestamp(d, tz="Asia/Shanghai").timestamp() * 1000),
                          "turnover": amt} for d in days]}

    orig, tm.ths_get = tm.ths_get, fake
    try:
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "turnover_data.js"
            tm.export_turnover(out)
            return read_js(out)
    finally:
        tm.ths_get = orig


def test_turnover_sums_two_exchanges():
    """沪 + 深 -> 万亿, 一天不多一天不少。"""
    p = with_ths_turnover(pd.bdate_range("2024-01-02", periods=300), sh=6e11, sz=1.4e12)
    assert p["amt"][0] == 2.0, p["amt"][:3]
    assert (p["dates"][0], p["dates"][-1]) == ("2024-01-02", "2025-02-24"), p["dates"][0]
    assert len(p["dates"]) == len(p["amt"]) == 300
    assert "updated" not in p, "带时间戳会让节假日重跑白刷一次 commit"


def test_turnover_empty_raises():
    """窗口超 ~5 年时接口静默回空(不报错), 必须抛, 否则写出一份空数据。"""
    try:
        with_ths_turnover([], sh=6e11, sz=1.4e12)
    except (RuntimeError, IndexError):
        return
    raise AssertionError("空返回没抛错")


def with_em_margin(days, bal, ratio):
    """假的东财两融报表(按 pageSize 分页) -> (export_margin 写出的 payload, 请求过的页码)。"""
    size = tm.MARGIN_PAGE
    rows = [{"DIM_DATE": f"{d:%Y-%m-%d} 00:00:00", "RZRQYE": bal, "RZYEZB": ratio} for d in days]
    pages, hits = max(1, -(-len(rows) // size)), []

    class Resp:
        def __init__(self, page):
            hits.append(page)
            self.page = page

        def raise_for_status(self):
            pass

        def json(self):
            if not rows:
                return {"result": None}  # 真接口空结果就是这个形状
            return {"result": {"pages": pages, "data": rows[(self.page - 1) * size:self.page * size]}}

    fake = types.SimpleNamespace(get=lambda url, **kw: Resp(kw["params"]["pageNumber"]))
    orig, tm.requests = tm.requests, fake
    try:
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "margin_data.js"
            tm.export_margin(out)
            return read_js(out), hits
    finally:
        tm.requests = orig


def test_margin_pages_through():
    """pageSize 上限 800: 必须按 result.pages 翻完, 少翻一页就是静默丢掉最近几年。"""
    p, hits = with_em_margin(pd.bdate_range("2010-03-31", periods=2100), bal=2.6e12, ratio=2.6)
    assert hits == [1, 2, 3], hits
    assert len(p["dates"]) == len(p["bal"]) == len(p["ratio"]) == 2100, len(p["dates"])
    assert (p["dates"][0], p["bal"][0], p["ratio"][0]) == ("2010-03-31", 2.6, 2.6), p["dates"][0]
    assert "updated" not in p, "带时间戳会让节假日重跑白刷一次 commit"


def test_margin_empty_raises():
    """拉不到就别写空文件, 页面留上次那份。"""
    try:
        with_em_margin([], bal=2.6e12, ratio=2.6)
    except RuntimeError:
        return
    raise AssertionError("空返回没抛错")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
