#!/usr/bin/env python3
"""
从抓取的 JSON 数据生成前端 JS 数据文件
支持多年度数据，自动按年份分组
"""

import json
import os
import sys
from collections import defaultdict

from pipeline import paths

DATA_FILE = str(paths.DATA / "70城房价.json")

# 只写数据，不写函数。辅助函数手写在 housingData.js 里 —— 两者混在一个文件时，
# 重跑本脚本会把手写函数全部冲掉。
OUTPUT_FILE = str(paths.WEB_DATA / "housingData.generated.js")

# 城市分级 —— 国家统计局口径（与数据源同口径，只有三档）：
#   一线 4 城，二线 31 城（省会 + 计划单列市），三线 35 城（其余）
# 不要再自造四线/五线：那是拍脑袋切的，无法对外解释，也对不上统计局公报。
CITY_TIERS = {
    "一线": ["北京", "上海", "广州", "深圳"],
    "二线": [
        "天津", "石家庄", "太原", "呼和浩特", "沈阳", "大连", "长春", "哈尔滨",
        "南京", "杭州", "宁波", "合肥", "福州", "厦门", "南昌", "济南", "青岛",
        "郑州", "武汉", "长沙", "南宁", "海口", "重庆", "成都", "贵阳", "昆明",
        "西安", "兰州", "西宁", "银川", "乌鲁木齐"
    ],
    "三线": [
        "唐山", "秦皇岛", "包头", "丹东", "锦州", "吉林", "牡丹江", "无锡",
        "扬州", "徐州", "温州", "金华", "蚌埠", "安庆", "泉州", "九江", "赣州",
        "烟台", "济宁", "洛阳", "平顶山", "宜昌", "襄阳", "岳阳", "常德", "韶关",
        "湛江", "惠州", "桂林", "北海", "三亚", "泸州", "南充", "遵义", "大理"
    ]
}


def load_data():
    """加载统一数据文件（scrape_housing_data.py 已按 (年,月) 去重并排序）"""
    if not os.path.exists(DATA_FILE):
        print(f"❌ 数据文件不存在: {DATA_FILE}")
        print("   先跑: python -m pipeline.housing.scrape_housing_data")
        sys.exit(1)

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    print(f"✓ 已加载: {os.path.basename(DATA_FILE)} ({len(data)} 个月)")
    return data


def organize_data_by_year(all_data):
    """按年份组织数据"""
    sorted_entries = sorted(all_data, key=lambda e: (e["year"], int(e["month"])))

    data_by_year = defaultdict(lambda: {"months": [], "newHouse": {}, "secondHand": {}})

    for entry in sorted_entries:
        year = entry.get("year")
        month = entry.get("month")
        
        if not year or not month:
            continue
        
        month_label = f"{month}月"
        
        if month_label not in data_by_year[year]["months"]:
            data_by_year[year]["months"].append(month_label)
        
        # 新房数据
        new_house = entry.get("new_house", {})
        for city, values in new_house.items():
            if city not in data_by_year[year]["newHouse"]:
                data_by_year[year]["newHouse"][city] = []
            
            huanbi = values.get("环比")
            data_by_year[year]["newHouse"][city].append(huanbi if huanbi is not None else None)
        
        # 二手房数据
        second_hand = entry.get("second_hand", {})
        for city, values in second_hand.items():
            if city not in data_by_year[year]["secondHand"]:
                data_by_year[year]["secondHand"][city] = []
            
            huanbi = values.get("环比")
            data_by_year[year]["secondHand"][city].append(huanbi if huanbi is not None else None)
    
    return dict(data_by_year)


def generate_js_file(data_by_year):
    """生成 JS 数据文件"""
    lines = [
        "// 自动生成，请勿手改 —— 由 generate_js_data.py 覆盖写入。",
        "// 辅助函数写在同目录的 housingData.js（手写）里。",
        "//",
        "// 70个大中城市商品住宅销售价格环比指数（上月=100）",
        "// 数据来源：国家统计局",
        "",
        "// 城市分级",
        "export const cityTiers = " + json.dumps(CITY_TIERS, ensure_ascii=False, indent=2) + ";",
        "",
        "// 按年份组织的数据",
        "export const dataByYear = {"
    ]
    
    for year in sorted(data_by_year.keys()):
        year_data = data_by_year[year]
        months = year_data["months"]
        new_house = year_data["newHouse"]
        second_hand = year_data["secondHand"]
        
        lines.append(f'  "{year}": {{')
        lines.append(f'    months: {json.dumps(months, ensure_ascii=False)},')
        
        # 新房数据
        lines.append('    newHouse: {')
        for city, values in sorted(new_house.items()):
            values_str = json.dumps(values)
            lines.append(f'      "{city}": {values_str},')
        lines.append('    },')
        
        # 二手房数据
        lines.append('    secondHand: {')
        for city, values in sorted(second_hand.items()):
            values_str = json.dumps(values)
            lines.append(f'      "{city}": {values_str},')
        lines.append('    },')
        
        lines.append('  },')
    
    lines.append("};")
    lines.append("")
    lines.append("// 获取所有可用年份")
    lines.append("export const availableYears = Object.keys(dataByYear).sort();")
    lines.append("")

    # 写入文件
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    
    print(f"\n✅ 已生成: {OUTPUT_FILE}")
    print(f"   共 {len(data_by_year)} 个年份: {sorted(data_by_year.keys())}")


def main():
    print("=" * 60)
    print("  生成前端数据文件")
    print("=" * 60)
    print()
    
    all_data = load_data()
    data_by_year = organize_data_by_year(all_data)
    generate_js_file(data_by_year)
    
    print("\n" + "=" * 60)
    print("  ✅ 完成!")
    print("=" * 60)


if __name__ == "__main__":
    main()
