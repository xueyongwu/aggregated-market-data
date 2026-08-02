"""10Y/30Y 国债活跃券收益率 -> app/src/data/bond_data.js (AStockPage 卡片)。

源: 中国货币网(外汇交易中心)现券成交
    https://www.chinamoney.com.cn/ags/ms/cm-u-md-bond/CbtPri
一次请求给全市场当日全部成交(2998 行, ~1.8MB), 银行间 9:00-17:00 交易, 20:00 定版。

活跃券 = 同期限桶内当日成交量最大的国债。券每季换, 故按「剩余期限 + 成交量」挑,
不硬编码券代码。收益率单位 %, 涨跌单位 bp(收益率上行=债价下跌)。

用法: python bond_rate.py
"""
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

from paths import WEB_DATA

API = "https://www.chinamoney.com.cn/ags/ms/cm-u-md-bond/CbtPri"
# pageSize 被接口忽略(填 15 也回全量 2998 行), 但填 100 会撞 WAF 403, 别改大
PARAMS = {"lang": "cn", "flag": "1", "pageNum": "1", "pageSize": "15"}

BUCKETS = [  # (显示名, 剩余期限下限, 上限) —— 新发 10Y 剩 9.8 年, 老券摊到 9.0 就该换新券了
    ("10年", 9.0, 10.5),
    ("30年", 28.0, 30.5),
]


def years(term: str) -> float:
    """'9.79Y' / '172D' -> 年。接口只有这两种后缀。"""
    v = float(term[:-1])
    return v if term.endswith("Y") else v / 365


def is_treasury(name: str) -> bool:
    """国债类: 附息/特别/超长特别/注资特别/续作特别。贴现国债是零息短债, 报价口径不同, 剔掉。"""
    return "国债" in name and "贴现" not in name


def pick(records: list[dict], lo: float, hi: float) -> dict:
    """桶内成交量最大的国债 = 活跃券。桶内无券即抛错, 好过悄悄少一行。"""
    best = None
    for r in records:
        if not is_treasury(r["abdAssetEncdShrtDesc"]) or not r.get("dmiLatestContraRate"):
            continue
        if not lo <= years(r["termToMaturity"]) <= hi:
            continue
        if best is None or float(r["dmiTtlTradedAmnt"]) > float(best["dmiTtlTradedAmnt"]):
            best = r
    if best is None:
        raise RuntimeError(f"剩余期限 {lo}~{hi} 年无国债成交")
    y = float(best["dmiLatestContraRate"])
    if not 0 < y < 10:  # 体检: 收益率是百分数, 出格说明字段口径变了
        raise RuntimeError(f"{best['abdAssetEncdShrtDesc']} 收益率异常: {y}")
    return {"name": best["abdAssetEncdShrtDesc"],
            "code": best["bondcode"],
            "yield": y,
            "bp": float(best["bpNum"]) if best.get("bpNum") is not None else None,
            "maturity": best["termToMaturity"],
            "vol": round(float(best["dmiTtlTradedAmnt"]), 1),
            "time": best["showDate"]}


def main():
    r = requests.get(API, params=PARAMS, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    r.raise_for_status()
    records = r.json()["records"]
    items = []
    for label, lo, hi in BUCKETS:
        it = pick(records, lo, hi) | {"term": label}
        items.append(it)
        print(f"{label:<4} {it['name']:<14} {it['yield']:.4f}%  "
              f"{it['bp']:+.2f}bp  剩余{it['maturity']}  {it['vol']}亿  {it['time']}", flush=True)

    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    out = WEB_DATA / "bond_data.js"
    payload = {"updated": now.strftime("%Y-%m-%d %H:%M"), "items": items}
    out.write_text("export const BOND_ACTIVE = " + json.dumps(payload, ensure_ascii=False) + ";\n",
                   encoding="utf-8")
    print(f"已导出: {out}")


if __name__ == "__main__":
    main()
