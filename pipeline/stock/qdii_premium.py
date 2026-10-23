"""场内 QDII 每日溢价率 -> QdiiPage 溢价走势图, 一只一个文件(FUNDS):
  - 易方达纳指100 ETF(sz159696) -> app/src/data/qdii_premium_data.js

溢价率 = 当日收盘价 / 当日单位净值 - 1, 前端现算, 文件只存 dates/close/nav 三列。
  - 净值: 东财 api.fund.eastmoney.com/f10/lsjz, 要带 Referer, 否则回空。pageSize 填多大都只给 20 条
  - 收盘: 腾讯 fqkline 不复权 day(净值也是不复权的单位净值, 两边同口径; 拆份额时两边一起变, 比值不受影响)

**增量**: 溢价率是同一天两个数的比值, 算出来就定死了, 所以历史就存在输出文件里, 每次读回来,
只拉净值第 1 页(最近 20 条 ≈ 4 周) + 那段日期起的日线, 按日期合并, 同一天以新拉的为准
(东财偶尔修正近几天的净值, 这样能盖过去)。这页最老一条都比历史最后一天新 = 中间断档了
(CI 停了一个多月), 接着往后翻页直到接上。没有输出文件就全量(当前 39 页, 1 秒多)。
各只互不拖累: 一只挂了照样写别的, 最后再抛错让 CI 那步标红。

口径注意:
  - QDII 净值 T+1 才公布, 曲线恒定比行情晚一天; 当天只有价格没净值的那天按日期内连接自然丢掉, 下次补上
  - 净值表里有非交易日的估值行(2023-12-31 / 2024-06-30 这种半年末), 同样被内连接丢掉
  - A 股 15:00 收盘, 而 T 日净值按美股当晚收盘算, 美股当晚暴涨暴跌就是一根假尖刺
    (2025-04-09 关税暂停那晚美股 +12%, 当天算出 -9.2%), 集思录也是这个口径, 前端图注写明

用法: python -m pipeline.stock.qdii_premium
"""
import json

from pipeline.paths import WEB_DATA
from pipeline.stock.us_perf import fetch

# (腾讯代码, 输出文件, 导出变量名)。159696 那份文件名沿用不改, 省得前端和 CI 跟着动
FUNDS = [
    ("sz159696", WEB_DATA / "qdii_premium_data.js", "QDII_PREMIUM"),
]
NAV_URL = "https://api.fund.eastmoney.com/f10/lsjz"
# 裸域 ifzq.gtimg.cn 而不是 web.ifzq.gtimg.cn: 后者按 IP 限流(见 QdiiPage useBase 的注释)。
# 这个域名下 param 的起始日真按日期截, 增量时只拉那几根
K_URL = "https://ifzq.gtimg.cn/appstock/app/fqkline/get?param={tx},day,{start},,2000,"
START = "2010-01-01"
MAX_PAGES = 100  # 当前全量 39 页; 翻到这还没完说明翻页参数失效在原地打转
# 体检: 出格说明价格和净值错位了(复权口径/单位换了, 2:1 拆份额错一边就是 +100% 或 -50%)。
# 不对称: 折价实测最深 -9.2%, 溢价实测 +19.1%; 额度紧时场内 QDII 溢价能冲到 +39%, 上限留宽
MIN_PREM, MAX_PREM = -30, 80


def nav_page(code: str, p: int) -> list[tuple[str, float]]:
    r = fetch(NAV_URL, params=dict(fundCode=code, pageIndex=p, pageSize=20),
              headers={"Referer": "https://fundf10.eastmoney.com/"}, timeout=15)
    d = r.json()["Data"]
    if d is None:  # 不带 Referer / 参数不认时是这样, HTTP 照样 200
        raise RuntimeError(f"净值接口第 {p} 页回空: {r.text[:200]}")
    return [(x["FSRQ"], float(x["DWJZ"])) for x in d["LSJZList"] if x["DWJZ"]]


def navs(after: str | None, page) -> dict[str, float]:
    """翻到 after 那天为止(含)的净值; after 为空就翻完全部。page(p) 回第 p 页。"""
    out = {}
    for p in range(1, MAX_PAGES + 1):
        rows = page(p)
        out.update(rows)
        if not rows or (after and min(d for d, _ in rows) <= after):
            return out
    raise RuntimeError(f"净值翻了 {MAX_PAGES} 页还没完")


def closes(tx: str, start: str) -> dict[str, float]:
    d = fetch(K_URL.format(tx=tx, start=start), timeout=15).json()["data"][tx]
    return {r[0]: float(r[2]) for r in d.get("day", [])}


def merge(old: dict | None, nav: dict[str, float], px: dict[str, float], code: str) -> dict:
    """旧历史 + 新拉的(价格和净值都有的那几天), 同一天以新的为准。"""
    rows = dict(zip(old["dates"], zip(old["close"], old["nav"]))) if old else {}
    rows.update({d: (px[d], nav[d]) for d in nav.keys() & px.keys()})
    ds = sorted(rows)
    return {"code": code, "dates": ds, "close": [rows[d][0] for d in ds], "nav": [rows[d][1] for d in ds]}


def sanity_check(out: dict, old: dict | None):
    if not out["dates"]:
        raise RuntimeError("合并后一天都没有")
    if old and len(out["dates"]) < len(old["dates"]):
        raise RuntimeError("合并后比旧历史还短")
    bad = [(d, c, n) for d, c, n in zip(out["dates"], out["close"], out["nav"])
           if not MIN_PREM <= (c / n - 1) * 100 <= MAX_PREM]
    if bad:
        raise RuntimeError(f"溢价率出格({MIN_PREM}% ~ +{MAX_PREM}% 之外): {bad[:3]}")


def load(out) -> dict | None:
    """上次导出的整份历史(同 us_perf.last 的切法); 没有/坏了就当全量。"""
    try:
        t = out.read_text(encoding="utf-8")
        return json.loads(t[t.index("=") + 1:t.rindex(";")])
    except Exception:
        return None


def update(tx: str, path, var: str):
    code = tx[2:]
    old = load(path)
    after = old["dates"][-1] if old else None
    nav = navs(after, lambda p: nav_page(code, p))
    px = closes(tx, min(nav) if old else START)
    out = merge(old, nav, px, code)
    sanity_check(out, old)
    added = len(out["dates"]) - (len(old["dates"]) if old else 0)
    d, c, n = out["dates"][-1], out["close"][-1], out["nav"][-1]
    print(f"{code} {'增量' if old else '全量'}: 净值 {len(nav)} 条 / 日线 {len(px)} 根 -> 新增 {added} 天, "
          f"共 {len(out['dates'])} 天; 最新 {d} 收盘 {c} 净值 {n} 溢价 {(c / n - 1) * 100:+.2f}%", flush=True)
    # 不带 updated: 节假日重跑数据一样, 有时间戳就白刷一次 commit。数据到哪天看 dates[-1]
    path.write_text(f"export const {var} = " + json.dumps(out, separators=(",", ":")) + ";\n",
                    encoding="utf-8")
    print(f"已导出: {path}")


def main():
    failed = []
    for tx, path, var in FUNDS:
        try:
            update(tx, path, var)
        except Exception as e:
            print(f"{tx} 失败: {e!r}", flush=True)
            failed.append(tx)
    if failed:
        raise RuntimeError(f"溢价率更新失败: {failed}")


if __name__ == "__main__":
    main()
