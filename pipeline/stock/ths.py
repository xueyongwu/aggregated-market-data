"""同花顺金融数据服务客户端(turnover_margin / index_perf 共用, 别各写一份)。

环境变量: HITHINK_FINANCE_API_KEY(https://fuyao.aicubes.cn/admin 自助创建)
"""
import os

import pandas as pd
import requests

THS_API = "https://fuyao.aicubes.cn/api"
THS_KEY_ENV = "HITHINK_FINANCE_API_KEY"


def ths_get(path: str, **params):
    """同花顺金融数据服务 GET。

    HTTP 200 不代表业务成功, 必须看信封里的 code(0 才是成功), 失败时 data 是 null。
    """
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


def ths_date(ms: pd.Series) -> pd.Series:
    """同花顺毫秒戳 -> 交易日(naive Timestamp 零点)。

    这些戳是 Asia/Shanghai 零点。直接 pd.to_datetime(unit="ms") 读出来是 UTC 16:00,
    日期整体退一天——周一会变成周日, 交易日历里凭空冒出周末。必须显式转时区。
    """
    return (pd.to_datetime(ms, unit="ms", utc=True)
              .dt.tz_convert("Asia/Shanghai").dt.tz_localize(None).dt.normalize())
