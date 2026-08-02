"""前端数据目录。

抓取脚本产出的 *_data.js 是 Vite 应用的 ES module 源文件（`export const X = {...};`），
不再是页面直接 <script> 引的 window 全局 —— 改动格式要同步 app/src/pages 里的 import。
"""
from pathlib import Path

WEB_DATA = Path(__file__).resolve().parent / "app" / "src" / "data"
WEB_DATA.mkdir(parents=True, exist_ok=True)
