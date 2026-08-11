"""1Y~30Y 国债活跃券收益率(收益率曲线) -> app/src/data/bond_data.js (BondPage)。

源: 中国货币网(外汇交易中心)现券成交
    https://www.chinamoney.com.cn/ags/ms/cm-u-md-bond/CbtPri
一次请求给全市场当日全部成交(2998 行, ~1.8MB), 银行间 9:00-17:00 交易, 20:00 定版。
七个期限是从这同一份里挑的, 不额外发请求。

活跃券 = 同期限桶内当日成交量最大的国债。券每季换, 故按「剩余期限 + 成交量」挑,
不硬编码券代码。收益率单位 %, 涨跌单位 bp(收益率上行=债价下跌)。

用法: python -m pipeline.stock.bond_rate
"""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

from pipeline.paths import WEB_DATA

API = "https://www.chinamoney.com.cn/ags/ms/cm-u-md-bond/CbtPri"
# pageSize 被接口忽略(填 15 也回全量 2998 行), 但填 100 会撞 WAF 403, 别改大
PARAMS = {"lang": "cn", "flag": "1", "pageNum": "1", "pageSize": "15"}

BUCKETS = [  # (显示名, 剩余期限下限, 上限) —— 新发 10Y 剩 9.8 年, 老券摊到 9.0 就该换新券了
    ("1年", 0.7, 1.2),    # 桶按「新券剩余 ≈ 期限, 到下次续发前一路衰减」定, 相邻桶不重叠:
    ("2年", 1.5, 2.2),    # 2Y 半年一续发, 剩余在 1.5~2.0 之间转; 5Y/7Y/10Y 一季一续发。
    ("3年", 2.5, 3.2),    # 桶内取成交量最大的那只, 老券量小自然选不中。
    ("5年", 4.4, 5.2),
    ("7年", 6.4, 7.2),
    ("10年", 9.0, 10.5),
    ("30年", 28.0, 30.5),
]
# 只有这两个桶空了才算失败: 它俩是页面的主卡, 也是全天成交最活跃的两只, 必然有量。
# 短端(尤其 1 年)常年只有贴现国债成交, 曲线上缺一个点比整个文件不写强。
CORE = {"10年", "30年"}


def years(term: str) -> float:
    """'9.79Y' / '172D' -> 年。接口只有这两种后缀。"""
    v = float(term[:-1])
    return v if term.endswith("Y") else v / 365


def is_treasury(name: str) -> bool:
    """国债类: 附息/特别/超长特别/注资特别/续作特别。贴现国债是零息短债, 报价口径不同, 剔掉。"""
    return "国债" in name and "贴现" not in name


def amount(r: dict) -> float:
    """当日累计成交量(亿)。开盘头几分钟接口这列给 '---', 按 0 算。

    CI 两条 cron 都在收盘后跑, 全 0 只会发生在早盘手动跑 —— 那时桶内全部并列 0,
    挑出来的是列表里第一只, 不是活跃券。别拿早盘那次的产物当准。
    """
    try:
        return float(r["dmiTtlTradedAmnt"])
    except (TypeError, ValueError):
        return 0.0


def today_rows(records: list[dict], today: str) -> list[dict]:
    """只留当日成交。节假日/周末接口回的是上个交易日那份, 全过滤掉即空。

    交易日历不查 baostock: 为一张卡片多挂一个会整站挂掉的依赖不划算(2026-07-22 真挂过,
    login 卡 2 分钟才抛), 而每行自带 showDate —— 数据自己就能回答今天是不是交易日。
    顺带保证挑出来的券不会是上个交易日的陈旧价。
    """
    return [r for r in records if str(r.get("showDate", "")).startswith(today)]


def pick(records: list[dict], lo: float, hi: float) -> dict:
    """桶内成交量最大的国债 = 活跃券。桶内无券即抛错, 好过悄悄少一行。"""
    best = None
    for r in records:
        if not is_treasury(r["abdAssetEncdShrtDesc"]) or not r.get("dmiLatestContraRate"):
            continue
        if not lo <= years(r["termToMaturity"]) <= hi:
            continue
        if best is None or amount(r) > amount(best):
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
            "vol": round(amount(best), 1) or None,  # 早盘那列是 '---', 给 None 让前端显 —
            "time": best["showDate"]}


def main():
    r = requests.get(API, params=PARAMS, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    r.raise_for_status()
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    today = now.strftime("%Y-%m-%d")
    records = today_rows(r.json()["records"], today)
    if not records:
        print(f"{today} 无当日成交(非交易日或尚未开盘), 跳过写盘")
        return
    items = []
    for label, lo, hi in BUCKETS:
        try:
            it = pick(records, lo, hi) | {"term": label}
        except RuntimeError as e:
            if label in CORE:
                raise
            print(f"{label:<4} 跳过: {e}", flush=True)
            continue
        items.append(it)
        bp = f"{it['bp']:+.2f}bp" if it["bp"] is not None else "—"
        print(f"{label:<4} {it['name']:<14} {it['yield']:.4f}%  "
              f"{bp:<9} 剩余{it['maturity']}  {it['vol']}亿  {it['time']}", flush=True)

    out = WEB_DATA / "bond_data.js"
    payload = {"updated": now.strftime("%Y-%m-%d %H:%M"), "items": items}
    out.write_text("export const BOND_ACTIVE = " + json.dumps(payload, ensure_ascii=False) + ";\n",
                   encoding="utf-8")
    print(f"已导出: {out}")


if __name__ == "__main__":
    main()
