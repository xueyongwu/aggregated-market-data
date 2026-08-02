#!/usr/bin/env python3
"""
批量抓取 2021-2024 年历史数据
通过搜索国家统计局网站获取文章URL，然后抓取数据
"""

import sys
import os
import json
import time
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrape_housing_data import (
    fetch_page, extract_table_data, extract_month_from_title,
    save_raw, merge_save, existing_months,
    ARTICLE_KEYWORD, BASE_URL, HEADERS, log
)
import requests
from bs4 import BeautifulSoup

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def find_all_articles_for_years(target_years):
    """扫描足够多的列表页来找到指定年份的文章"""
    articles = []
    seen_urls = set()
    max_pages = 70  # 扫描更多页面
    
    for page_idx in range(max_pages):
        if page_idx == 0:
            list_url = BASE_URL
        else:
            list_url = f"https://www.stats.gov.cn/sj/zxfb/index_{page_idx}.html"
        
        log(f"扫描列表页 ({page_idx+1}/{max_pages}): {list_url}")
        
        try:
            resp = requests.get(list_url, headers=HEADERS, timeout=30)
            resp.encoding = "utf-8"
            if resp.status_code != 200:
                log(f"  HTTP {resp.status_code}, 停止")
                break
            html = resp.text
        except Exception as e:
            log(f"  请求失败: {e}")
            break
        
        soup = BeautifulSoup(html, "lxml")
        links = soup.find_all("a", href=True)
        
        found_any = False
        for a_tag in links:
            title = a_tag.get_text(strip=True)
            href = a_tag.get("href", "")
            
            if ARTICLE_KEYWORD not in title:
                continue
            
            # 检查是否是目标年份
            is_target = False
            for year in target_years:
                if str(year) in title:
                    is_target = True
                    break
            
            if not is_target:
                continue
            
            if href.startswith("http"):
                full_url = href
            else:
                full_url = requests.compat.urljoin(BASE_URL, href)
            
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)
            
            date_span = a_tag.find_next_sibling("span") or a_tag.parent.find("span")
            pub_date = date_span.get_text(strip=True) if date_span else ""
            
            articles.append((title, full_url, pub_date))
            found_any = True
            log(f"  ✅ 找到: {title}")
        
        time.sleep(1.0)
    
    # 按年月排序
    def sort_key(item):
        m = re.search(r"(\d{4})年(\d{1,2})月", item[0])
        if m:
            return (int(m.group(1)), int(m.group(2)))
        return (0, 0)
    
    articles.sort(key=sort_key)
    return articles


def scrape_articles(articles, force=False):
    """抓取文章数据。已抓过的月份默认跳过。返回 (成功数据, 失败标题)"""
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
            failures.append(title)
            continue

        data["year"] = year_val
        data["month"] = month_val
        data["pub_date"] = pub_date
        data["url"] = url

        log(f"  ✅ 新建: {len(data['new_house'])}城 | 二手: {len(data['second_hand'])}城")
        all_data.append(data)

        if i < len(articles):
            time.sleep(1.0)

    if skipped:
        log(f"\n⏭️  跳过 {len(skipped)} 个已抓过的月份: {', '.join(skipped)}")

    return all_data, failures


def main():
    log("=" * 60)
    log("  批量抓取 2021-2024 年历史数据")
    log("=" * 60)
    
    target_years = [2021, 2022, 2023, 2024]
    
    # 1. 查找文章
    log("\n📋 步骤1: 查找文章链接...")
    articles = find_all_articles_for_years(target_years)
    
    if not articles:
        log("❌ 未找到任何文章")
        return
    
    log(f"\n找到 {len(articles)} 篇文章:")
    for title, url, date in articles:
        log(f"  [{date}] {title}")
    
    # 2. 抓取数据
    log(f"\n📊 步骤2: 抓取数据...")
    all_data, failures = scrape_articles(articles)

    if not all_data:
        # 历史数据已经抓全时会走到这里，是正常情况，不是失败
        if failures:
            log(f"❌ {len(failures)} 篇抓取失败，且无新数据")
            sys.exit(1)
        log("✅ 无新数据，历史数据已抓全")
        return

    # 3. 保存（合并进统一数据文件）
    log(f"\n💾 步骤3: 保存数据...")
    merge_save(all_data)

    # 4. 摘要
    log(f"\n{'=' * 60}")
    log(f"  本次抓取 {len(all_data)} 个月数据")
    for entry in all_data:
        log(f"  {entry.get('year', '?')}年{entry.get('month', '?')}月")
    log(f"{'=' * 60}")

    if failures:
        log(f"\n⚠️  {len(failures)} 篇失败:")
        for t in failures:
            log(f"    - {t}")
        sys.exit(1)


if __name__ == "__main__":
    main()
