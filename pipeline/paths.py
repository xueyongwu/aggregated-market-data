"""仓库里所有落盘位置的唯一来源。

全是绝对路径（从本文件回推仓库根），所以脚本在哪个目录下跑都一样 —— 从前散在各处的
`Path("cache/...")` 只在 CWD 恰好是仓库根时才对，`python -m` 换个工作目录就写到别处去了。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CACHE = ROOT / "cache"  # parquet / ST 名单等增量缓存，部分入库（见 .gitignore）
DATA = ROOT / "data"  # 房价原始 JSON + data/raw/ 的 gzip 存档

# 抓取脚本产出的 *_data.js 是 Vite 应用的 ES module 源文件（`export const X = {...};`），
# 不是页面直接 <script> 引的 window 全局 —— 改动格式要同步 app/src/pages 里的 import。
WEB_DATA = ROOT / "app" / "src" / "data"

for _d in (CACHE, DATA, WEB_DATA):
    _d.mkdir(parents=True, exist_ok=True)
