#!/usr/bin/env python3
"""
国家统计局 - 70个大中城市商品住宅销售价格变动情况 数据抓取脚本

用法：
    # 激活虚拟环境后运行
    source .venv/bin/activate
    python scrape_housing_data.py

    # 指定年份
    python scrape_housing_data.py --year 2026

    # 抓取所有可用年份
    python scrape_housing_data.py --all

    # 输出为 CSV
    python scrape_housing_data.py --format csv

    # 输出为 JSON（默认）
    python scrape_housing_data.py --format json

    # 抓取指定 URL
    python scrape_housing_data.py --url https://www.stats.gov.cn/sj/zxfb/202606/t20260616_1963946.html

    # 离线重解析已存档的 HTML（统计局改版后修完 parser 用这个，不发网络请求）
    python scrape_housing_data.py --reparse

    # 重抓已有月份（默认增量：已抓过的月份跳过，不重复下载）
    python scrape_housing_data.py --force

输出：
    data/70城房价.json   全部月份，按 (年,月) 去重，重复运行合并而非新建文件
    data/raw/YYYY-MM.html 原始 HTML 存档，供 --reparse 使用
"""

import argparse
import gzip
import json
import csv
import os
import re
import sys
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

# ============================================================
# 配置
# ============================================================

BASE_URL = "https://www.stats.gov.cn/sj/zxfb/"
LIST_PAGE_PATTERN = "https://www.stats.gov.cn/sj/zxfb/index_{}.html"
ARTICLE_KEYWORD = "70个大中城市商品住宅销售价格变动情况"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.stats.gov.cn/",
}

REQUEST_DELAY = 1.5  # 请求间隔（秒），避免过于频繁
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# 全部月份汇总到单一文件，按 (年,月) 去重。带时间戳的多份文件会让下游按 glob 顺序随机选中版本。
DATA_FILE = os.path.join(OUTPUT_DIR, "70城房价.json")

# 原始 HTML 存档。统计局改版或撤稿后，可用 --reparse 离线重跑解析，无需重新抓取。
RAW_DIR = os.path.join(OUTPUT_DIR, "raw")

# 每张主指数表固定 70 城。解析出的城市数不等于此值，说明表格结构已变。
EXPECT_CITIES = 70


def log(msg):
    """带强制刷新的打印"""
    print(msg, flush=True)


# ============================================================
# 网络请求
# ============================================================

def fetch_page(url, retries=3):
    """获取页面 HTML 内容"""
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.encoding = "utf-8"
            if resp.status_code == 200:
                return resp.text
            log(f"  [警告] HTTP {resp.status_code}: {url}")
        except requests.RequestException as e:
            log(f"  [警告] 请求失败 (第{attempt+1}次): {e}")
            time.sleep(2)
    return None


# ============================================================
# 城市名清洗
# ============================================================

def clean_city_name(name):
    """去除城市名中的全角空格、半角空格等"""
    return re.sub(r"[\u3000\s]+", "", name)


# ============================================================
# 列表页解析 - 查找文章链接
# ============================================================

def find_article_urls(year=None):
    """
    从列表页中查找所有"70个大中城市商品住宅销售价格变动情况"的文章 URL。
    返回去重后的: [(标题, URL, 发布日期), ...]
    """
    articles = []
    seen_urls = set()
    max_pages = 30

    for page_idx in range(max_pages):
        if page_idx == 0:
            list_url = BASE_URL
        else:
            list_url = LIST_PAGE_PATTERN.format(page_idx)

        log(f"扫描列表页 ({page_idx+1}): {list_url}")
        html = fetch_page(list_url)
        if not html:
            break

        soup = BeautifulSoup(html, "lxml")
        links = soup.find_all("a", href=True)

        found_on_page = False
        for a_tag in links:
            title = a_tag.get_text(strip=True)
            href = a_tag.get("href", "")

            if ARTICLE_KEYWORD not in title:
                continue

            # 过滤年份
            if year and str(year) not in title:
                continue

            # 构造完整 URL
            if href.startswith("http"):
                full_url = href
            else:
                full_url = urljoin(BASE_URL, href)

            # URL 去重
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)

            # 提取发布日期
            date_span = a_tag.find_next_sibling("span") or a_tag.parent.find("span")
            pub_date = date_span.get_text(strip=True) if date_span else ""

            articles.append((title, full_url, pub_date))
            found_on_page = True

        # 如果连续几页都没有找到新文章，停止扫描
        if not found_on_page and page_idx > 2:
            break

        time.sleep(REQUEST_DELAY)

    # 按月份排序（从标题中提取月份）
    def sort_key(item):
        title = item[0]
        m = re.search(r"(\d{4})年(\d{1,2})月", title)
        if m:
            return (int(m.group(1)), int(m.group(2)))
        return (0, 0)

    articles.sort(key=sort_key)
    return articles


# ============================================================
# 文章页解析 - 提取表格数据
# ============================================================

def extract_table_data(html):
    """
    从文章页 HTML 中提取房价数据表格。

    返回: {
        "title": str,
        "new_house": {"城市名": {"环比": val, "同比": val, "平均": val}, ...},
        "second_hand": {"城市名": {"环比": val, "同比": val, "平均": val}, ...},
        "new_house_by_area": {...},
        "second_hand_by_area": {...},
    }
    """
    soup = BeautifulSoup(html, "lxml")

    # 获取标题
    title_tag = soup.select_one(".detail-title h1, .detail-title h2, h1")
    title = title_tag.get_text(strip=True) if title_tag else ""

    # 定位 PC 端内容区域（前6个表格）
    content = soup.select_one(".detail-text-content.mhide") or soup.select_one(".txt-content")
    if not content:
        content = soup

    # 获取所有数据表格（PC端，共6个）
    tables = content.select("table.trs_word_table")
    if not tables:
        tables = content.find_all("table")

    # 取前6个（PC端的6个表格）
    tables = tables[:6] if len(tables) > 6 else tables

    if len(tables) < 2:
        raise ValueError(f"只找到 {len(tables)} 张表格，至少需要 2 张（新建/二手主指数表）")

    result = {
        "title": title,
        "new_house": {},
        "second_hand": {},
        "new_house_by_area": {},
        "second_hand_by_area": {},
    }

    # 表1: 新建商品住宅销售价格指数
    result["new_house"] = parse_main_index_table(tables[0])

    # 表2: 二手住宅销售价格指数
    result["second_hand"] = parse_main_index_table(tables[1])

    # 表3-6: 分类指数（按面积分）
    if len(tables) >= 6:
        result["new_house_by_area"] = parse_area_index_tables(tables[2:4])
        result["second_hand_by_area"] = parse_area_index_tables(tables[4:6])

    # 主指数表是双栏并排（左35城+右35城），列数靠推断。推断错会只吃到左半栏，
    # 静默产出 35 城的残缺数据。这里必须报错，不能让脏数据落盘。
    for key in ("new_house", "second_hand"):
        n = len(result[key])
        if n != EXPECT_CITIES:
            raise ValueError(
                f"{key} 只解析出 {n} 城，应为 {EXPECT_CITIES} 城 —— 表格结构可能已变"
            )

    return result


def parse_main_index_table(table):
    """
    解析主指数表格（表1/表2）。

    表格结构：双栏并排，左35城 + 右35城
    可能格式：
      - 6列: 城市|环比|同比 | 城市|环比|同比 (无平均列)
      - 8列: 城市|环比|同比|平均 | 城市|环比|同比|平均
    前2行为表头，后续35行为数据。
    """
    rows = table.find_all("tr")
    data = {}

    # 跳过表头行（前2行）
    data_rows = rows[2:] if len(rows) > 2 else rows

    # 自动检测列数：从第一个数据行推断
    col_per_side = 3  # 默认无平均列
    if data_rows:
        first_cells = data_rows[0].find_all(["td", "th"])
        n = len(first_cells)
        if n >= 8:
            col_per_side = 4
        elif n >= 6:
            col_per_side = 3

    offsets = [0, col_per_side]  # 左半部分起始 和 右半部分起始

    for row in data_rows:
        cells = row.find_all(["td", "th"])
        for offset in offsets:
            if len(cells) >= offset + col_per_side:
                city = clean_city_name(cells[offset].get_text(strip=True))
                huanbi = parse_number(cells[offset + 1].get_text(strip=True))
                tongbi = parse_number(cells[offset + 2].get_text(strip=True)) if col_per_side >= 3 else None
                avg = parse_number(cells[offset + 3].get_text(strip=True)) if col_per_side >= 4 else None

                if city and huanbi is not None:
                    data[city] = {
                        "环比": huanbi,
                        "同比": tongbi,
                        "平均": avg,
                    }

    return data


def parse_area_index_tables(tables):
    """
    解析分类指数表格（按面积段：90m²以下/90-144m²/144m²以上）。
    """
    combined = {}

    for table in tables:
        rows = table.find_all("tr")

        # 找数据行：跳过含 th 或 colspan/rowspan 的表头行
        data_rows = []
        for row in rows:
            ths = row.find_all("th")
            if ths:
                continue
            cells = row.find_all("td")
            if not cells:
                continue
            # 检查是否是纯数据行
            first_text = clean_city_name(cells[0].get_text(strip=True))
            if first_text and len(first_text) >= 2:
                data_rows.append(row)

        for row in data_rows:
            cells = row.find_all(["td", "th"])
            if not cells:
                continue

            city = clean_city_name(cells[0].get_text(strip=True))
            if not city:
                continue

            values = []
            for cell in cells[1:]:
                values.append(parse_number(cell.get_text(strip=True)))

            if city not in combined:
                combined[city] = {}

            if len(values) >= 9:
                combined[city] = {
                    "90m²及以下": {
                        "环比": values[0], "同比": values[1], "平均": values[2]
                    },
                    "90-144m²": {
                        "环比": values[3], "同比": values[4], "平均": values[5]
                    },
                    "144m²以上": {
                        "环比": values[6], "同比": values[7], "平均": values[8]
                    },
                }
            elif len(values) >= 3:
                combined[city] = {
                    "环比": values[0],
                    "同比": values[1] if len(values) > 1 else None,
                    "平均": values[2] if len(values) > 2 else None,
                }

    return combined


def parse_number(text):
    """将文本转为数字，失败返回 None"""
    if not text:
        return None
    text = text.strip()
    if text in ("", "-", "—", "—", "/"):
        return None
    try:
        return float(text.replace(",", "").replace("，", ""))
    except (ValueError, TypeError):
        return None


# ============================================================
# 提取月份信息
# ============================================================

def extract_month_from_title(title):
    """
    从标题中提取年份和月份。
    例如: "2026年5月份70个大中城市商品住宅销售价格变动情况"
    返回: ("2026", "5")
    """
    m = re.search(r"(\d{4})年(\d{1,2})月", title)
    if m:
        return m.group(1), m.group(2)
    return None, None


# ============================================================
# 数据保存
# ============================================================

def save_json(all_data, filepath):
    """保存为 JSON 文件"""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(all_data, f, ensure_ascii=False, indent=2)
    log(f"\n✅ JSON 已保存: {filepath}")


def raw_path(year, month):
    # gzip: 单篇原始 HTML 约 1.4MB，压缩后约 1/10，才好进 git
    return os.path.join(RAW_DIR, f"{year}-{int(month):02d}.html.gz")


def save_raw(html, year, month):
    """存档原始 HTML。解析失败也要存，才能离线复现和修 parser。"""
    if not (year and month):
        return
    os.makedirs(RAW_DIR, exist_ok=True)
    # mtime=0: gzip 默认把当前时间写进文件头，同样的 HTML 每次压出来字节都不同，
    # git 会把内容没变的存档全标成 modified —— 自动更新流程就没法靠 diff 判断有没有新数据。
    with open(raw_path(year, month), "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", mtime=0) as gz:
            gz.write(html.encode("utf-8"))


def load_raw(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return f.read()


def existing_months():
    """
    已抓过的 (年, 月)。用于增量抓取：这些月份直接跳过，不重新下载文章页（每篇约 1.4MB）。

    两个条件都满足才算"已有"：DATA_FILE 里解析出了数据，且 raw 存档还在。
    少了任一个都得重抓 —— 只有存档没数据说明当时解析失败了，只有数据没存档则无法离线复现。
    """
    if not os.path.exists(DATA_FILE):
        return set()

    with open(DATA_FILE, encoding="utf-8") as f:
        entries = json.load(f)

    return {
        (e["year"], int(e["month"]))
        for e in entries
        if os.path.exists(raw_path(e["year"], e["month"]))
    }


def merge_save(new_entries):
    """按 (年,月) 合并进 DATA_FILE，同月覆盖。"""
    rows = {}
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, encoding="utf-8") as f:
            for entry in json.load(f):
                rows[(entry["year"], int(entry["month"]))] = entry

    for entry in new_entries:
        rows[(entry["year"], int(entry["month"]))] = entry

    merged = [rows[k] for k in sorted(rows)]
    save_json(merged, DATA_FILE)
    log(f"   共 {len(merged)} 个月 ({merged[0]['year']}年{merged[0]['month']}月 "
        f"→ {merged[-1]['year']}年{merged[-1]['month']}月)")


def export_csv():
    """
    从 DATA_FILE 导出全量 CSV。

    必须读 DATA_FILE 而不是本次抓到的数据 —— 增量抓取下本次可能只抓到 1 个月甚至 0 个月，
    拿它导出会得到一份只有新月份的残缺 CSV。
    """
    with open(DATA_FILE, encoding="utf-8") as f:
        save_csv(json.load(f), os.path.join(OUTPUT_DIR, "70城房价.csv"))


def save_csv(all_data, filepath):
    """保存为 CSV 文件"""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)

    with open(filepath, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "年份", "月份", "类型", "城市",
            "环比(上月=100)", "同比(上年同月=100)", "平均(上年同期=100)"
        ])

        for entry in all_data:
            year = entry.get("year", "")
            month = entry.get("month", "")

            for house_type in ["new_house", "second_hand"]:
                type_label = "新建商品住宅" if house_type == "new_house" else "二手住宅"
                city_data = entry.get(house_type, {})

                for city, values in city_data.items():
                    writer.writerow([
                        year, month, type_label, city,
                        values.get("环比", ""),
                        values.get("同比", ""),
                        values.get("平均", ""),
                    ])

    log(f"\n✅ CSV 已保存: {filepath}")


# ============================================================
# 主流程
# ============================================================

def scrape(year=None, fmt="json", force=False):
    """
    主抓取函数。

    参数:
        year: 指定年份（如 2026），None 表示不限年份
        fmt: 输出格式 "json" 或 "csv"
        force: 重抓已有月份（默认跳过）
    """
    log("=" * 60)
    log("  国家统计局 - 70城房价数据抓取")
    log("=" * 60)

    # 1. 查找文章链接
    log("\n📋 步骤1: 查找数据页面链接...")
    articles = find_article_urls(year=year)

    if not articles:
        log("❌ 未找到任何匹配的文章，请检查年份或网络连接。")
        return

    log(f"\n找到 {len(articles)} 篇文章:")
    for i, (title, url, date) in enumerate(articles, 1):
        log(f"  {i}. [{date}] {title}")
        log(f"     {url}")

    # 2. 逐篇抓取数据
    log(f"\n📊 步骤2: 抓取数据...")
    all_data = []
    failures = []
    skipped = []

    have = set() if force else existing_months()

    for i, (title, url, pub_date) in enumerate(articles, 1):
        year_val, month_val = extract_month_from_title(title)

        if year_val and month_val and (year_val, int(month_val)) in have:
            skipped.append(f"{year_val}-{int(month_val):02d}")
            continue

        log(f"\n[{i}/{len(articles)}] {title}")
        log(f"  URL: {url}")

        html = fetch_page(url)
        if not html:
            log("  ❌ 页面获取失败")
            failures.append(title)
            continue

        save_raw(html, year_val, month_val)

        try:
            data = extract_table_data(html)
        except ValueError as e:
            log(f"  ❌ 解析失败: {e}")
            log(f"     原始 HTML 已存档，修好 parser 后可用 --reparse 重跑")
            failures.append(title)
            continue

        data["year"] = year_val
        data["month"] = month_val
        data["pub_date"] = pub_date
        data["url"] = url

        log(f"  ✅ 新建: {len(data['new_house'])}城 | 二手: {len(data['second_hand'])}城")
        all_data.append(data)

        if i < len(articles):
            time.sleep(REQUEST_DELAY)

    if skipped:
        log(f"\n⏭️  跳过 {len(skipped)} 个已抓过的月份: {', '.join(skipped)}")
        log("   （要重抓请加 --force）")

    if not all_data:
        # 没有新数据 ≠ 失败。每月定时任务在数据发布前跑到这里是常态，必须正常退出，
        # 否则 CI 会天天报红。真正的失败走 failures 分支。
        if failures:
            log(f"\n❌ {len(failures)} 篇抓取失败，且无新数据。")
            sys.exit(1)
        log("\n✅ 无新数据，已是最新。")
        if fmt == "csv":
            export_csv()
        return

    # 3. 保存数据
    log(f"\n💾 步骤3: 保存数据...")
    merge_save(all_data)
    if fmt == "csv":
        export_csv()

    # 4. 输出摘要
    log("\n" + "=" * 60)
    log("  📊 抓取摘要")
    log("=" * 60)
    for entry in all_data:
        ym = f"{entry.get('year', '?')}年{entry.get('month', '?')}月"
        new_cities = entry.get("new_house", {})
        second_cities = entry.get("second_hand", {})

        new_up = [c for c, v in new_cities.items() if v.get("环比") and v["环比"] > 100]
        second_up = [c for c, v in second_cities.items() if v.get("环比") and v["环比"] > 100]

        log(f"\n  {ym}:")
        log(f"    新房环比上涨: {len(new_up)}城 → {new_up[:8]}{'...' if len(new_up) > 8 else ''}")
        log(f"    二手环比上涨: {len(second_up)}城 → {second_up[:8]}{'...' if len(second_up) > 8 else ''}")

    log(f"\n✅ 完成! 共抓取 {len(all_data)} 个月数据")

    if failures:
        log(f"\n⚠️  {len(failures)} 篇失败:")
        for t in failures:
            log(f"    - {t}")
        sys.exit(1)


def reparse():
    """离线重跑：解析 data/raw/ 下已存档的 HTML，不发任何网络请求。"""
    import glob as _glob

    files = sorted(_glob.glob(os.path.join(RAW_DIR, "*.html.gz")))
    if not files:
        log(f"❌ {RAW_DIR} 下没有存档的 HTML")
        sys.exit(1)

    log(f"📂 重解析 {len(files)} 份存档 HTML...")
    all_data = []
    failures = []

    for path in files:
        stem = os.path.basename(path).split(".")[0]  # "2026-05"
        year_val, month_val = stem.split("-")
        month_val = str(int(month_val))

        try:
            data = extract_table_data(load_raw(path))
        except ValueError as e:
            log(f"  ❌ {stem}: {e}")
            failures.append(stem)
            continue

        data["year"] = year_val
        data["month"] = month_val
        log(f"  ✅ {stem}: 新建 {len(data['new_house'])}城 | 二手 {len(data['second_hand'])}城")
        all_data.append(data)

    if not all_data:
        log("\n❌ 全部解析失败")
        sys.exit(1)

    # 重解析拿不到 pub_date/url，从已有 DATA_FILE 里补回来，别把字段抹掉
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, encoding="utf-8") as f:
            old = {(e["year"], int(e["month"])): e for e in json.load(f)}
        for entry in all_data:
            prev = old.get((entry["year"], int(entry["month"])))
            if prev:
                entry["pub_date"] = prev.get("pub_date", "")
                entry["url"] = prev.get("url", "")

    merge_save(all_data)

    if failures:
        log(f"\n⚠️  {len(failures)} 份失败: {failures}")
        sys.exit(1)


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="国家统计局 - 70个大中城市商品住宅销售价格数据抓取",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python scrape_housing_data.py                    # 抓取2026年数据（默认）
  python scrape_housing_data.py --year 2025        # 抓取2025年数据
  python scrape_housing_data.py --all              # 抓取所有可用年份
  python scrape_housing_data.py --format csv       # 输出为CSV
  python scrape_housing_data.py --url URL          # 抓取指定URL
        """
    )
    parser.add_argument("--year", type=int, default=2026,
                        help="指定抓取年份 (默认: 2026)")
    parser.add_argument("--all", action="store_true",
                        help="抓取所有可用年份")
    parser.add_argument("--format", choices=["json", "csv"], default="json",
                        help="输出格式 (默认: json)")
    parser.add_argument("--url", type=str,
                        help="直接抓取指定URL的数据页面")
    parser.add_argument("--reparse", action="store_true",
                        help="离线重解析 data/raw/ 下的存档 HTML，不发网络请求")
    parser.add_argument("--force", action="store_true",
                        help="重抓已有月份（默认跳过已抓过的，只抓新数据）")

    args = parser.parse_args()

    if args.reparse:
        reparse()
        return

    if args.url:
        # 单 URL 模式
        log(f"📊 抓取指定 URL: {args.url}")
        html = fetch_page(args.url)
        if not html:
            log("❌ 页面获取失败")
            sys.exit(1)

        title = BeautifulSoup(html, "lxml").select_one("h1")
        year_val, month_val = extract_month_from_title(title.get_text() if title else "")
        save_raw(html, year_val, month_val)

        try:
            data = extract_table_data(html)
        except ValueError as e:
            log(f"❌ 解析失败: {e}")
            sys.exit(1)

        data["year"] = year_val
        data["month"] = month_val
        data["url"] = args.url
        merge_save([data])
        return

    year = None if args.all else args.year
    scrape(year=year, fmt=args.format, force=args.force)


if __name__ == "__main__":
    main()
