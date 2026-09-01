"""A股全市场每日涨跌中位数趋势图。

数据源: 同花顺金融数据服务(全市场 dump, 历史 + 代码表, 要 API Key)
      + 腾讯 qt.gtimg.cn(当日批量快照) + baostock(交易日历, 及 dump 不可用时的降级)。
思路: 拉今年以来全市场日线涨跌幅 -> 缓存 parquet -> 按日取中位数
      -> 导出 app/src/data/median_data.js, AStockPage 用 ECharts 画(日中位数 + 累计, 成交额/两融那两张见 export_turnover、export_margin)。
股票池是「全量 A 股」含北交所(~5550 只): 北交所 baostock 没有, 只有同花顺 dump 给,
所以全量/补缺口都走 dump(~100 秒), 而不再逐股拉。之后走缓存, 秒级; 收盘后 --update 增量。
注: --update 默认走腾讯批量(15:00 收盘即可用, ~1.5 秒);
    缓存有缺口或腾讯不可用时回退 baostock(逐股慢, 且当日数据 ~17:30 后才有)。

用法:
    python -m pipeline.stock.median_trend             # 无缓存则全量拉, 有则直接导出 median_data.js
    python -m pipeline.stock.median_trend --refresh   # 强制重拉
    python -m pipeline.stock.median_trend --update    # 收盘后增量重拉最近10天
    然后 cd app && pnpm dev

环境变量: HITHINK_FINANCE_API_KEY(同花顺 https://fuyao.aicubes.cn/admin 自助创建)

依赖: pip install baostock pandas pyarrow
"""
import argparse
import json
import os
import tempfile
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

import pandas as pd

from pipeline.paths import CACHE, WEB_DATA

RAW = CACHE / "daily_pctchg.parquet"  # 长表: date, code, pct
ST = CACHE / "st_codes.json"          # ST 名单快照(见 st_codes)
ST_TTL_DAYS = 7

THS_API = "https://fuyao.aicubes.cn/api"   # 同花顺金融数据服务
THS_KEY_ENV = "HITHINK_FINANCE_API_KEY"

_bs_depth = 0


def save_raw(df: pd.DataFrame) -> pd.DataFrame:
    """滚动裁剪后落盘。返回裁剪后的表。

    上游只需要今年以来(导出)和最近 10 天(增量窗口/代码表降级), 更早的纯占体积——
    这份不进 git, 每次 CI 走 actions/cache 整份存取(见 .gitignore)。
    保底 30 天是为跨年: 元旦后单按今年切会清空缓存, 增量窗口全判缺口退回 baostock
    逐股慢路径, nq_overnight 也拿不到跨年的前一交易日。
    年份取自数据本身而非 now(), CI 是 UTC 时区。

    date 列先归一: 无缓存时 fetch_history/update_today_tencent 拿
    pd.DataFrame(columns=[...]) 当空占位, 它是 object dtype, concat 进来整列就成了
    object(元素还是 Timestamp, 所以跟 Timestamp 比不报错)——main 末尾拿字符串比
    "%Y-01-01" 时才炸, 落盘再读回又被 pyarrow 修回 datetime64, 只有全量那一趟现形。
    """
    df = df.assign(date=pd.to_datetime(df["date"]))
    last = df["date"].max()
    cut = min(last - pd.Timedelta(days=30), pd.Timestamp(year=last.year, month=1, day=1))
    df = df[df["date"] >= cut]
    df.to_parquet(RAW, index=False)  # 长表不存行号, 省 ~5MB
    return df


@contextmanager
def bs_session():
    """baostock 会话(全局单例, 可嵌套)。

    login 握手是秒级开销, 原先每个查询各登一次; 嵌套时只有最外层真正登录/登出。
    """
    global _bs_depth
    import baostock as bs
    if _bs_depth == 0:
        lg = bs.login()
        if lg.error_code != "0":
            raise RuntimeError(f"baostock login failed: {lg.error_msg}")
    _bs_depth += 1
    try:
        yield bs
    finally:
        _bs_depth -= 1
        if _bs_depth == 0:
            try:
                bs.logout()
            except Exception:
                pass


def ths_get(path: str, **params):
    """同花顺金融数据服务 GET。

    HTTP 200 不代表业务成功, 必须看信封里的 code(0 才是成功), 失败时 data 是 null。
    """
    import requests

    key = os.environ.get(THS_KEY_ENV)
    if not key:
        raise RuntimeError(f"缺环境变量 {THS_KEY_ENV}")
    r = requests.get(THS_API + path, params=params,
                     headers={"X-api-key": key}, timeout=60)
    r.raise_for_status()
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"THS {path} code={d.get('code')} {d.get('message')}")
    return d["data"]


DUMP_TRIES = 8


def ths_dump(kind: str, columns: list[str] | None = None) -> pd.DataFrame:
    """下载同花顺全市场 Parquet。断点续传, 因为 daily-k 有 171MB 且跨境。

    签名端点只回一个 S3 预签名 URL, 约 5 分钟过期——拿到立刻下, 别缓存 URL。
    daily-k 全量 ~171MB/1000 万行(近 10 年), daily-k-10d ~1MB, adjustment-factors ~0.3MB。

    必须续传而不是整份重来: 2026-08-24 在 GitHub runner 上实测, 171MB 拉到 5.6MB 就
    IncompleteRead 断流, 整份重下等于赌运气。S3 回 Accept-Ranges: bytes(实测 206),
    所以断在哪从哪续; 签名过期(403)就重签一个接着续, 已下的字节不浪费。
    流式写盘而不是 r.content: 后者要把 171MB 整份读进内存才开始解析。
    """
    import requests

    fd, tmp = tempfile.mkstemp(suffix=f".{kind}.parquet", dir=CACHE)
    os.close(fd)
    tmp = Path(tmp)
    try:
        url, done, expect, stalled = None, 0, None, 0
        for _ in range(DUMP_TRIES):
            if url is None:
                url = ths_get(f"/dump/market-dumps/{kind}/download-url")["presigned_url"]
            before = done
            try:
                headers = {"Range": f"bytes={done}-"} if done else {}
                with requests.get(url, headers=headers, stream=True,
                                  timeout=(10, 120)) as r:
                    if r.status_code == 403:  # 签名过期, 重签接着续
                        url = None
                        continue
                    r.raise_for_status()
                    expect = done + int(r.headers.get("Content-Length") or 0)
                    with open(tmp, "ab" if done else "wb") as f:
                        for chunk in r.iter_content(1 << 20):
                            f.write(chunk)
                            done += len(chunk)
            except requests.RequestException as e:
                print(f"  {kind} 断在 {done}/{expect} 字节({e}), 续传...", flush=True)
            if expect and done >= expect:
                return pd.read_parquet(tmp, columns=columns)
            stalled = stalled + 1 if done == before else 0
            if stalled >= 2:  # 连着两轮一个字节都没进, 再试也是白试
                break
        raise RuntimeError(f"同花顺 {kind} 只下到 {done}/{expect} 字节")
    finally:
        tmp.unlink(missing_ok=True)


def ths_date(ms: pd.Series) -> pd.Series:
    """同花顺毫秒戳 -> 交易日(naive Timestamp 零点), 与缓存的 date 列同格式。

    这些戳是 Asia/Shanghai 零点。直接 pd.to_datetime(unit="ms") 读出来是 UTC 16:00,
    日期整体退一天——周一会变成周日, 交易日历里凭空冒出周末。必须显式转时区。
    """
    return (pd.to_datetime(ms, unit="ms", utc=True)
              .dt.tz_convert("Asia/Shanghai").dt.tz_localize(None).dt.normalize())


def ths_code(s: pd.Series) -> pd.Series:
    """600519.SH -> sh.600519(与 baostock/缓存同格式)。"""
    return s.str[-2:].str.lower() + "." + s.str[:-3]


@lru_cache(maxsize=1)
def ths_tickers() -> tuple[tuple[str, str], ...]:
    """同花顺 A 股代码表 ((sh.600519, 贵州茅台), ...)。一次 ~5560 行, <1 秒。

    这是唯一含北交所的代码源, 且自带中文名, 顺带把 ST 名单也解决了
    (baostock 的 query_stock_basic 要拉 5000+ 行, 是原先本脚本最慢的单次调用)。
    exchange 参数上游实测不生效(传什么都回全量), 按前缀自己筛, 传上只是为了它哪天修好。
    """
    it = ths_get("/meta/tickers/list", exchange="SH,SZ,BJ",
                 asset_type="a-share", limit=10000)["item"]
    return tuple((f'{x["thscode"][-2:].lower()}.{x["thscode"][:-3]}', x["name"]) for x in it)


# A 股宇宙前缀(baostock 格式): 沪主板/科创 sh.6, 深主板/中小 sz.0, 创业板 sz.30(300/301/302),
# 北交所 bj.92(2024 年起北交所代码统一迁到 920 段, dump 里只有这一段)。
# 用 sz.30 而非 sz.3, 否则 sz.399* 深证指数会混入; 同理 bj.92 而非 bj.9。
# 北交所 baostock 不提供, 靠同花顺 dump/代码表补, 见 ths_tickers / fetch_history_dump。
A_PREFIXES = ("sh.6", "sz.0", "sz.30", "bj.92")


def all_a_codes(day: str) -> list[str]:
    """指定交易日全部 A 股代码(baostock 格式 sh.600000 / sz.000001 / bj.920002)。

    主源同花顺代码表(含北交所 ~340 只)。它挂了才回退 baostock query_all_stock——
    那份没有北交所, 池子会少一截, 只当临时降级: 中位数口径当天变窄, 次日恢复。
    query_all_stock 还含指数(sh.000*/sz.399*)和 B 股(sh.900*/sz.200*), 靠 A_PREFIXES 滤掉。
    """
    try:
        codes = sorted(c for c, _ in ths_tickers() if c.startswith(A_PREFIXES))
        if len(codes) < 4000:
            raise RuntimeError(f"同花顺代码表仅 {len(codes)} 只, 疑似不全")
        return codes
    except Exception as e:
        print(f"同花顺代码表失败({e}), 回退 baostock(无北交所)。", flush=True)

    with bs_session() as bs:
        d = pd.Timestamp(day)
        codes = []
        for _ in range(7):  # end 非交易日则回退找最近交易日
            rs = bs.query_all_stock(day=d.strftime("%Y-%m-%d"))
            while rs.error_code == "0" and rs.next():
                codes.append(rs.get_row_data()[0])
            if codes:
                break
            d -= pd.Timedelta(days=1)
    return [c for c in codes if c.startswith(A_PREFIXES)]


def fetch_history(codes: list[str], start: str, end: str) -> pd.DataFrame:
    """baostock 逐股重拉 start..end 窗口, 每 100 股落盘, 按 (date,code) 去重合并。

    只剩「同花顺 dump 也挂了, 拿它补几天缺口」这一个用途——全量重建走 dump, 不再逐股
    (慢 10 倍, 且 baostock 没有北交所)。原先那个跳过已缓存 code 的断点续传开关
    随全量路径一起删了: 补窗口本来就要全部重拉。
    """
    import baostock as bs

    have = pd.read_parquet(RAW) if RAW.exists() else pd.DataFrame(columns=["date", "code", "pct"])
    todo = list(codes)
    rows = [have]

    def _login():
        lg = bs.login()
        if lg.error_code != "0":
            raise RuntimeError(f"baostock login failed: {lg.error_msg}")

    def _fetch_one(code):
        rs = bs.query_history_k_data_plus(
            code, "date,pctChg", start_date=start, end_date=end,
            frequency="d", adjustflag="3",  # 3=不复权, 涨跌幅用原始
        )
        if rs.error_code != "0":
            raise RuntimeError(rs.error_msg)  # 触发重连重试
        recs = []
        while rs.next():
            recs.append(rs.get_row_data())
        return recs

    print(f"待拉取 {len(todo)} 股。", flush=True)
    with bs_session():
        for i, code in enumerate(todo, 1):
            recs = None
            for attempt in range(3):  # 单股失败重连重试, 不阻断整轮
                try:
                    recs = _fetch_one(code)
                    break
                except Exception as e:
                    if attempt == 2:
                        print(f"  skip {code}: {e}", flush=True)
                    else:
                        try:
                            bs.logout()
                        except Exception:
                            pass
                        _login()  # 断连后重登
            if recs:
                d = pd.DataFrame(recs, columns=["date", "pct"])
                d = d[d["pct"] != ""]  # 停牌日 pctChg 为空 -> 剔除
                if not d.empty:
                    rows.append(pd.DataFrame({
                        "date": pd.to_datetime(d["date"]),
                        "code": code,
                        "pct": d["pct"].astype(float),
                    }))
            if i % 100 == 0:
                print(f"  {i}/{len(todo)} ...", flush=True)
                pd.concat(rows, ignore_index=True).to_parquet(RAW, index=False)  # 阶段落盘

    out = pd.concat(rows, ignore_index=True).drop_duplicates(["date", "code"])
    return save_raw(out)


def fetch_history_dump(start: str, end: str, recent_only: bool = False) -> pd.DataFrame:
    """同花顺全市场 dump -> 日涨跌幅长表, 并入缓存。替代 baostock 逐股拉取。

    两个理由非它不可:
    1. 北交所 baostock 根本没有, 「全量 A 股」这个口径只能从这儿来(~340 只);
    2. 全量 ~100 秒, 逐股要 10-20 分钟——actions/cache 7 天不访问即逐出, 春节休市那周
       必然走一次全量, 这条路每年都会跑。
    recent_only 用 daily-k-10d(最近 10 交易日, ~1MB/1 秒), 供补缺口。

    dump 是未复权价, 除权日直接 close/prev 会算出假暴跌(实测单只最大偏 4.6pp,
    分红季每天几只到十几只), 用同一份数据的复权事件还原:
        pct = (收盘 * (1 + 每股送股) + 每股分红) / 前收盘 - 1
    配股(allotment_*)不还原: 2026 年至今全市场只有 1 例, 为它引一套配股价公式不划算。
    与站内既有序列逐日对账 153 个交易日: 中位数最大差 0.007pp(两位小数的舍入噪音),
    上涨占比最大差 0.11pp。
    """
    kind = "daily-k-10d" if recent_only else "daily-k"
    df = ths_dump(kind, ["thscode", "date_ms", "close_price", "volume"])
    df["date"] = ths_date(df["date_ms"])
    # 窗口首日也要有涨跌幅, 得留出前收盘: 往前多带 15 天(够跨春节以外的任何长假), 最后再切掉
    df = df[(df["date"] >= pd.Timestamp(start) - pd.Timedelta(days=15))
            & (df["date"] <= pd.Timestamp(end))].sort_values(["thscode", "date"])
    if df.empty:
        raise RuntimeError(f"同花顺 {kind} 在 {start}~{end} 无数据")

    adj = ths_dump("adjustment-factors",
                   ["thscode", "ex_date_ms", "dividend_per_share", "per_share_bonus"])
    adj["date"] = ths_date(adj["ex_date_ms"])
    # 同一 (代码, 除权日) 偶有多行(57000 行里 3 例): 完全相同的是上游重复, 先去重;
    # 剩下的是分红/送股拆成了两行, 求和。不合并的话 merge 会把那只票当天的行复制一份, 混进中位数。
    adj = (adj.drop_duplicates()
              .groupby(["thscode", "date"], as_index=False)
              [["dividend_per_share", "per_share_bonus"]].sum())

    df["prev"] = df.groupby("thscode", sort=False)["close_price"].shift()
    df = df.merge(adj[["thscode", "date", "dividend_per_share", "per_share_bonus"]],
                  on=["thscode", "date"], how="left")
    df["pct"] = ((df["close_price"] * (1 + df["per_share_bonus"].fillna(0))
                  + df["dividend_per_share"].fillna(0)) / df["prev"] * 100 - 100)
    df["code"] = ths_code(df["thscode"])

    out = df[(df["date"] >= pd.Timestamp(start))
             & (df["volume"] > 0)          # 成交量 0 = 停牌, 不剔会拉偏中位数
             & df["pct"].notna()
             & df["code"].str.startswith(A_PREFIXES)][["date", "code", "pct"]]
    have = pd.read_parquet(RAW) if RAW.exists() else None
    if have is not None:
        out = (pd.concat([have, out], ignore_index=True)
                 .drop_duplicates(["date", "code"], keep="last"))  # dump 是定版, 覆盖旧值
    days = out["date"].nunique()
    print(f"同花顺 {kind}: {len(out)} 行 / {days} 个交易日 / {out['code'].nunique()} 只。", flush=True)
    return save_raw(out)


TENCENT_Q = "https://qt.gtimg.cn/q="
TENCENT_CHUNK = 800  # 实测每请求上限 900 只(1000 返回空), 取 800 留余量


def parse_tencent_quotes(text: str, stamp: str, sym2code: dict[str, str]) -> dict[str, float]:
    """解析 qt.gtimg.cn 返回体 -> {baostock代码: 当日涨跌幅%}。

    行格式 v_sh600000="1~名称~600000~现价~昨收~今开~成交量(手)~...";
    字段: [6]成交量 [30]时间戳 yyyymmddHHMMSS [32]涨跌幅%。
    """
    out = {}
    for line in text.split(";"):
        k, _, v = line.partition("=")
        code = sym2code.get(k.strip()[2:])  # 去掉 v_ 前缀
        if not code:
            continue
        f = v.strip().strip('"').split("~")
        if len(f) < 33 or not f[30].startswith(stamp):
            continue  # 字段异常, 或快照不是当日(隔日跑/长期停牌的陈旧价)
        if float(f[6] or 0) <= 0:
            continue  # 成交量 0 = 停牌, 腾讯给 pct=0.00 而非空, 不剔会拉偏中位数
        out[code] = float(f[32] or 0)
    return out


def update_today_tencent(codes: list[str], day: str) -> pd.DataFrame | None:
    """腾讯批量快照拉当日涨跌幅并并入缓存: 全市场 ~7 个请求 1.5 秒。

    与 baostock 逐股窗口重拉(5000+ 请求)结果实测一致(qfq 口径校验 30 股 0 偏差),
    且 15:00 收盘即可用, 不必等 baostock 的 ~17:30。
    覆盖率不足或请求失败返回 None, 由调用方回退 baostock。
    """
    import requests

    stamp = day.replace("-", "")
    quotes = {}
    try:
        for i in range(0, len(codes), TENCENT_CHUNK):
            chunk = codes[i:i + TENCENT_CHUNK]
            sym2code = {c.replace(".", ""): c for c in chunk}
            r = requests.get(TENCENT_Q + ",".join(sym2code),
                             headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
            r.raise_for_status()
            quotes.update(parse_tencent_quotes(r.content.decode("gbk", "ignore"), stamp, sym2code))
    except Exception as e:
        print(f"腾讯快照失败({e}), 回退 baostock。", flush=True)
        return None

    if len(quotes) < len(codes) * 0.9:  # 停牌一般远不到 10%, 缺这么多说明源有问题
        print(f"腾讯快照仅 {len(quotes)}/{len(codes)} 只, 回退 baostock。", flush=True)
        return None

    have = pd.read_parquet(RAW) if RAW.exists() else pd.DataFrame(columns=["date", "code", "pct"])
    today = pd.DataFrame({"date": pd.Timestamp(day), "code": list(quotes), "pct": list(quotes.values())})
    out = (pd.concat([have, today], ignore_index=True)
             .drop_duplicates(["date", "code"], keep="last"))  # 重跑以新快照为准
    out = save_raw(out)
    print(f"腾讯快照 {day}: {len(quotes)} 只。", flush=True)
    return out


def trading_days(start: str, end: str) -> list[str]:
    """baostock 交易日历。用于节假日空跑保护 + 检测缓存缺口。"""
    with bs_session() as bs:
        rs = bs.query_trade_dates(start_date=start, end_date=end)
        days = []
        while rs.error_code == "0" and rs.next():
            d, is_open = rs.get_row_data()[:2]
            if is_open == "1":
                days.append(d)
        return days


def is_trading_day(day: str) -> bool:
    """节假日 cron 空跑, 不写脏数据。"""
    return day in trading_days(day, day)


def st_codes() -> set[str]:
    """名称含 ST 的代码集合(其 ±5% 涨跌停与普通涨跌无法区分, 统计时剔除)。

    走同花顺代码表(名字白送, 且含北交所那 3 只 ST——baostock 那份根本没有北交所)。
    戴帽摘帽是低频事件, 结果缓存 ST_TTL_DAYS 天, 缓存文件入库免得每次 CI 都重拉。
    同花顺挂了回退 baostock query_stock_basic(拉 5000+ 行, 慢, 且缺北交所)。
    """
    if ST.exists():
        blob = json.loads(ST.read_text(encoding="utf-8"))
        if pd.Timestamp(blob["updated"]) > pd.Timestamp.now() - pd.Timedelta(days=ST_TTL_DAYS):
            return set(blob["codes"])
    try:
        out = {c for c, name in ths_tickers() if "ST" in name.upper()}
    except Exception as e:
        print(f"同花顺代码表失败({e}), ST 名单回退 baostock。", flush=True)
        with bs_session() as bs:
            rs = bs.query_stock_basic()
            out = set()
            while rs.error_code == "0" and rs.next():
                code, name = rs.get_row_data()[:2]
                if "ST" in name.upper():
                    out.add(code)
    if not out:
        raise RuntimeError("ST 名单为空, 疑似接口异常")  # 不覆盖旧缓存
    ST.write_text(json.dumps({"updated": pd.Timestamp.now().strftime("%Y-%m-%d"),
                              "codes": sorted(out)}), encoding="utf-8")
    return out


def update_incremental(end: str) -> pd.DataFrame | None:
    """收盘后增量。返回 None = 非交易日或拿不到可信当日数据, 调用方直接退出不写盘。

    baostock 只用来查交易日历、代码表和回退拉取——数据主源已是腾讯, 所以它挂了要能降级:
    代码表退回缓存里最近交易日那份(漏掉当天新上市的几只, 5000 只样本的中位数无感),
    交易日判断交给腾讯快照自己——节假日快照返回的是上个交易日的陈旧时间戳,
    parse_tencent_quotes 的日期校验会全过滤掉, 覆盖率为 0 自然判定不写。
    """
    recent = (pd.Timestamp(end) - pd.Timedelta(days=10)).strftime("%Y-%m-%d")
    days, codes, bs_ok = None, None, True
    try:
        with bs_session():  # 日历/代码表共用一次登录
            days = trading_days(recent, end)
            if end not in days:
                print(f"{end} 非交易日, 跳过。", flush=True)
                return None
            codes = all_a_codes(end)
    except Exception as e:
        bs_ok = False
        print(f"baostock 不可用({e}), 降级: 缓存代码表 + 腾讯快照自判交易日。", flush=True)

    have = pd.read_parquet(RAW) if RAW.exists() else None
    if codes is None:
        if have is None:
            raise RuntimeError("baostock 不可用且无缓存, 无从确定股票池")
        last = have["date"].max()
        codes = sorted(have.loc[have["date"] == last, "code"].unique())
        print(f"用 {last:%Y-%m-%d} 的缓存代码表 {len(codes)} 只。", flush=True)

    cached = set(have["date"].dt.strftime("%Y-%m-%d")) if have is not None else set()
    gaps = [d for d in (days or []) if d != end and d not in cached]
    df = None
    if gaps:  # CI 漏跑过, 腾讯只给当日, 补不了 -> 走 baostock 窗口
        print(f"缓存缺 {gaps}, 腾讯只给当日补不了, 走 dump 窗口。", flush=True)
    else:
        df = update_today_tencent(codes, end)
    if df is None:  # 补缺口: 同花顺 10 日 dump 一次拿全(含北交所), 1 秒
        try:
            out = fetch_history_dump(recent, end, recent_only=True)
            if pd.Timestamp(end) not in set(out["date"]):
                # baostock 挂着时交易日判断全靠数据自己: dump 里没有 end 那天,
                # 就是非交易日或当日还没定版——照样导出只会拿新 updated 白刷一次 commit。
                print(f"同花顺 dump 里没有 {end}, 非交易日或数据未就绪, 不更新。", flush=True)
                return None
            return out
        except Exception as e:
            print(f"同花顺 dump 失败({e}), 回退 baostock 窗口重拉。", flush=True)
    if df is None and not bs_ok:  # 回退路径也要 baostock, 它挂着就别写半截数据
        print("腾讯与同花顺都没数据且 baostock 不可用, 本次不更新。", flush=True)
        return None
    if df is None:  # baostock 增量: 重拉最近10天窗口, 按 (date,code) 去重合并
        df = fetch_history(codes, recent, end)
    return df


def sanity_check(p: dict):
    """写盘前体检。字段错位/源返回半截数据时直接抛, 不留脏 median_data.js。

    只查内容不查新鲜度: 节假日本就不该有新数据, 没写就没 commit, 不算故障。
    """
    n = len(p["dates"])
    assert n and all(len(p[k]) == n for k in ("median", "cum", "count", "upRatio")), "列长度不齐"
    assert len(set(p["dates"])) == n, "日期重复"
    assert p["dates"] == sorted(p["dates"]), "日期未升序"
    today = pd.Timestamp.now(tz="Asia/Shanghai").strftime("%Y-%m-%d")
    assert p["dates"][-1] <= today, f"出现未来日期 {p['dates'][-1]}"
    assert all(abs(x) < 15 for x in p["median"]), "中位数越界(疑似字段错位)"
    assert all(0 <= x <= 100 for x in p["upRatio"]), "上涨占比越界"
    assert p["count"][-1] > 4000, f"最新交易日仅 {p['count'][-1]} 只, 疑似拉取不全"


def export_data_js(df: pd.DataFrame, out: Path):
    """按日聚合 -> 写 median_data.js 供 AStockPage (ECharts) 读取。"""
    g = df.groupby("date")["pct"]
    med = g.median().sort_index().round(3)
    n = g.size().reindex(med.index)              # 每日样本量
    up = df[df["pct"] > 0].groupby("date").size().reindex(med.index).fillna(0)
    cum = med.cumsum().round(3)                   # 累计中位数

    ld = df[df["date"] == med.index[-1]]  # 最新交易日截面
    # 涨跌停按板块阈值近似(北交所 bj ±29.9%, 科创68/创业30 ±19.9%, 其余 ±9.9%),
    # ST 剔除; 拉名单失败则降级不剔
    try:
        lu = ld[~ld["code"].isin(st_codes())]
    except Exception as e:
        print(f"ST 名单拉取失败, 涨跌停统计未剔 ST: {e}", flush=True)
        lu = ld
    lim = pd.Series(9.9, index=lu.index)
    lim[lu["code"].str.startswith(("sh.68", "sz.30"))] = 19.9
    lim[lu["code"].str.startswith("bj.")] = 29.9

    payload = {
        "dates": [d.strftime("%Y-%m-%d") for d in med.index],
        "median": med.tolist(),
        "cum": cum.tolist(),
        "count": n.astype(int).tolist(),
        "upRatio": (up / n * 100).round(1).tolist(),  # 上涨家数占比 %
        "latest": {
            "limitUp": int((lu["pct"] >= lim).sum()),
            "limitDown": int((lu["pct"] <= -lim).sum()),
            "up": int((ld["pct"] > 0).sum()),
            "flat": int((ld["pct"] == 0).sum()),
            "down": int((ld["pct"] < 0).sum()),
        },
        "updated": pd.Timestamp.now(tz="Asia/Shanghai").strftime("%Y-%m-%d %H:%M"),
    }
    sanity_check(payload)  # 脏数据宁可让 CI 红, 也别 commit 进去(次日 --update 不回补)
    out.write_text("export const MEDIAN_DATA = " + json.dumps(payload, ensure_ascii=False) + ";\n",
                   encoding="utf-8")
    print(f"数据已导出: {out}  ({len(med)} 交易日, 中位数样本 ~{int(n.median())} 股/日)")
    print(med.tail(10).to_string())


TURNOVER_DAYS = 1826  # 同花顺窗口硬上限 ~5 年, 见下面的坑 1


def export_turnover(out: Path):
    """沪深两市日成交额(万亿) -> turnover_data.js (AStockPage 底部那张图)。

    同花顺 /a-share-index/prices/historical 除收盘外还给 turnover(成交额, 元), 白拿:
    沪(000001.SH) + 深(399001.SZ) 就是全市场口径 —— 深证成指返回的是**全深市**成交额
    而非成分股(与深证综指 399106 逐位一致, 也与东财 push2his 对得上)。北交所拿不到
    (899050 无论 .BJ 还是 .SH 都回 Unknown thscode), 占比 <1%, 不补。

    三个坑:
    1. 窗口超 ~5 年**静默回空**而不是报错(实测 1826 天回 1210 根, 1830 天回 0 根),
       所以 TURNOVER_DAYS 别往大调; 跨 10 年时它 code=1003 说的 "at most 10 years"
       是骗人的。空了必须抛, 别写出一份空数据。要更长的历史只能按 5 年分段拼。
    2. 盘中跑拿到的是半天成交额, 画出来是一根假的地量柱 —— 未收盘就丢掉最后那天,
       同 --update 的「未收盘不落库」。
    3. 不带 updated 字段(同 us_data.js): 节假日重跑数据一模一样, 有时间戳就每次都是
       新字节, 白刷一次 commit。数据到哪天看 dates[-1]。
    """
    now = pd.Timestamp.now(tz="Asia/Shanghai")
    win = dict(interval="1d",
               start=int((now - pd.Timedelta(days=TURNOVER_DAYS)).timestamp() * 1000),
               end=int(now.timestamp() * 1000))

    def amount(code: str) -> pd.Series:
        rows = ths_get("/a-share-index/prices/historical", thscode=code, **win)["item"]
        if not rows:
            raise RuntimeError(f"{code} 返回空(窗口超上限也是这个表现)")
        return pd.Series([x["turnover"] for x in rows],
                         index=ths_date(pd.Series([x["date_ms"] for x in rows]))).sort_index()

    amt = ((amount("000001.SH") + amount("399001.SZ")) / 1e12).dropna()  # 元 -> 万亿
    if amt.index[-1].date() == now.date() and now.hour < 15:
        amt = amt.iloc[:-1]
    amt = amt.round(3)
    if len(amt) < 200 or not 0 < amt.max() < 20:
        raise RuntimeError(f"成交额不合常理: {len(amt)} 个交易日, 峰值 {amt.max()} 万亿")

    # 20 日均线交给前端算: 区间筛选切片后仍要按完整序列算均线, 存一份反而两头对不齐
    payload = {"dates": [d.strftime("%Y-%m-%d") for d in amt.index], "amt": amt.tolist()}
    out.write_text("export const TURNOVER = " + json.dumps(payload) + ";\n", encoding="utf-8")
    print(f"成交额已导出: {out}  ({len(amt)} 交易日 {payload['dates'][0]}~{payload['dates'][-1]}, "
          f"最新 {amt.iloc[-1]} 万亿)")


MARGIN_API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
MARGIN_PAGE = 800  # 东财硬上限: pageSize 填 5000 也只回 800, 且不报错


def export_margin(out: Path):
    """沪深两融余额 + 融资余额占流通市值比 -> margin_data.js (AStockPage 那张两融图)。

    源是东财 datacenter 的 RPTA_RZRQ_LSHJ(沪深两市融资融券汇总), 2010-03-31 起
    全历史一次拉全(3989 个交易日, ~105KB), 实测 5 次请求 1.1 秒且不限流 —— 它跟
    push2his(连打五六次就 RemoteDisconnected)不是同一个端点, 别按那个的经验加节流。
    **同花顺没有两融**(/margin /rzrq /a-share/margin* 全 404), 所以这条只有东财一个源。

    三个坑:
    1. pageSize 上限 800, 必须按 result.pages 翻页 —— 填大既不报错也不给更多,
       少翻一页就是静默丢掉最近三年。
    2. 占流通市值比那条线不能省: 2026-06-25 余额 3.03 万亿是历史新高, 占比只有
       2.81%; 2015-07-03 占比 4.70% 时余额才 1.91 万亿。只画余额会得出「杠杆比
       2015 还疯」的反结论。融券余额则相反 —— 293 亿 vs 融资 2.64 万亿, 画上去
       就是条贴着 x 轴的线, 不导出。
    3. 交易所是收盘后当晚才公布当日余额, update.yml 两条 cron(北京 16:30/18:00)
       都赶不上, **这张图恒定比同页成交额慢一天**, 不是故障。每趟都全量重拉, 缺的
       次日自己补上, 所以不必为它单加 cron, 也不做增量。
    不带 updated 字段, 同 export_turnover(那边的坑 3)。
    """
    import requests

    rows, page, pages = [], 1, 1
    while page <= pages:
        r = requests.get(MARGIN_API, timeout=30, headers={"User-Agent": "Mozilla/5.0"},
                         params={"reportName": "RPTA_RZRQ_LSHJ", "source": "WEB", "client": "WEB",
                                 "columns": "DIM_DATE,RZRQYE,RZYEZB", "sortColumns": "dim_date",
                                 "sortTypes": 1, "pageSize": MARGIN_PAGE, "pageNumber": page})
        r.raise_for_status()
        res = r.json().get("result") or {}
        rows += res.get("data") or []
        pages, page = res.get("pages") or 1, page + 1
    if not rows:
        raise RuntimeError("东财两融返回空")

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["DIM_DATE"])
    df = df.drop_duplicates("date").sort_values("date")
    bal = (df["RZRQYE"].astype(float) / 1e12).round(3)  # 融资+融券余额, 元 -> 万亿
    ratio = df["RZYEZB"].astype(float).round(2)         # 融资余额 / 流通市值, %
    if len(df) < 2000 or not 0 < bal.max() < 10 or not 0 < ratio.max() < 10:
        raise RuntimeError(f"两融不合常理: {len(df)} 天, 峰值 {bal.max()} 万亿 / {ratio.max()}%")

    payload = {"dates": df["date"].dt.strftime("%Y-%m-%d").tolist(),
               "bal": bal.tolist(), "ratio": ratio.tolist()}
    out.write_text("export const MARGIN = " + json.dumps(payload) + ";\n", encoding="utf-8")
    print(f"两融已导出: {out}  ({len(df)} 交易日 {payload['dates'][0]}~{payload['dates'][-1]}, "
          f"最新 {bal.iloc[-1]} 万亿 / 占流通市值 {ratio.iloc[-1]}%)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=pd.Timestamp.now().strftime("%Y-01-01"))
    ap.add_argument("--end", default=pd.Timestamp.now().strftime("%Y-%m-%d"))
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--update", action="store_true", help="收盘后追加今日快照")
    a = ap.parse_args()

    # --update 但缓存没了 -> 落到下面的全量分支。缓存现在存 actions/cache(见 .gitignore),
    # 7 天不访问会被逐出, 春节休市那一周必现。走增量的话 update_incremental 只让 baostock
    # 补最近 10 天窗口, 导出的 median_data.js 就从「今年以来」静默塌成 10 天
    # —— sanity_check 不查条数, 塌了照样 commit, 之后每天 +1 天要一整年才长回来。
    if a.update and RAW.exists():
        # 盘中快照会被当成收盘价写死(次日的 --update 只取新一天, 不回补), 故未收盘不落库
        now = pd.Timestamp.now(tz="Asia/Shanghai")
        if a.end == now.strftime("%Y-%m-%d") and now.hour < 15:  # 外层已保证有缓存
            print(f"{a.end} 尚未收盘({now:%H:%M}), 不落库, 仅用缓存导出。", flush=True)
            df = pd.read_parquet(RAW)
        else:
            df = update_incremental(a.end)
            if df is None:  # 非交易日, 或没有可信的当日数据
                return
    elif a.refresh or not RAW.exists():
        if a.refresh and RAW.exists():
            RAW.unlink()
        # 这里是「重写整份序列」, 失败就抛, 不降级 baostock。
        # 用没有北交所的窄口径重写会把整条曲线换成另一个口径, 而且不自愈: 次日 --update
        # 只往这份缓存追加当天(腾讯是有北交所的), 序列前半段 5200 后半段 5540, 更难看。
        # 抛错 = CI 那步红 + 不 commit, 页面保留 git 里那份完整的, 比写窄口径强。
        print("全市场拉取中(同花顺 dump, ~2 分钟)...")
        df = fetch_history_dump(a.start, a.end)
    else:
        print("用缓存。--refresh 重拉, --update 追加今日。")
        df = pd.read_parquet(RAW)

    df = df[df["date"] >= pd.Timestamp.now().strftime("%Y-01-01")]  # 只导出今年以来
    export_data_js(df, WEB_DATA / "median_data.js")

    try:  # 独立的源和文件: 拉不到就不写, 页面留上次那份, 别拖累中位数
        export_turnover(WEB_DATA / "turnover_data.js")
    except Exception as e:
        print(f"成交额导出失败(保留上次的 turnover_data.js): {e}", flush=True)

    try:  # 同上, 另一个独立源(东财)
        export_margin(WEB_DATA / "margin_data.js")
    except Exception as e:
        print(f"两融导出失败(保留上次的 margin_data.js): {e}", flush=True)


if __name__ == "__main__":
    main()
