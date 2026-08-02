#!/usr/bin/env bash
# 本地更新数据：抓取 → 自检 → 生成前端数据。改动留在工作区，由你 review 后自行提交。
#
# 用法：
#   ./update.sh            全部（A股 + 纳指ETF + 指数 + 债 + 美股 + 房价）
#   ./update.sh housing    只跑房价（可带年份：./update.sh housing 2025）
#   ./update.sh stock      只跑 A股 / ETF / 指数 / 债 / NQ / 美股
#
# 线上有对应的 workflow 各自按自己的节奏跑，这个脚本只是本地手动补一趟。
set -euo pipefail
cd "$(dirname "$0")"

PY=.venv/bin/python
[ -x "$PY" ] || { echo "❌ 没有 .venv，先跑: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"; exit 1; }

what=${1:-all}

run_stock() {
  echo "▶ A股中位数..."   ; "$PY" median_trend.py --update
  echo "▶ 159696 分时..." ; "$PY" intraday_cache.py 159696 || echo "  (跳过)"
  echo "▶ 宽基指数..."     ; "$PY" index_perf.py            || echo "  (跳过)"
  echo "▶ 国债活跃券..."   ; "$PY" bond_rate.py             || echo "  (跳过)"
  echo "▶ NQ 隔夜..."      ; "$PY" nq_overnight.py          || echo "  (跳过)"
  echo "▶ 美股 + 加密..."  ; "$PY" us_perf.py               || echo "  (跳过)"
}

run_housing() {
  # 12 月数据标题写「上一年12月」，却在次年 1 月才发布，只抓当年会漏掉它
  if [ $# -gt 0 ]; then years=("$@")
  elif [ "$(date +%-m)" -le 2 ]; then years=("$(($(date +%Y) - 1))" "$(date +%Y)")
  else years=("$(date +%Y)")
  fi
  for y in "${years[@]}"; do
    echo "▶ 抓取 $y 年房价..." ; "$PY" scrape_housing_data.py --year "$y"
  done
  echo "▶ parser 自检..."     ; "$PY" test_parse.py
  echo "▶ 生成前端数据..."     ; "$PY" generate_js_data.py
}

case "$what" in
  housing) shift; run_housing "$@" ;;
  stock)   run_stock ;;
  all)     run_stock; run_housing ;;
  *)       echo "未知参数: $what（可选 all / stock / housing）"; exit 1 ;;
esac

echo
echo "▶ 改动："
git status --short
echo
echo "确认无误后提交推送，deploy.yml 会重新构建并部署："
echo "  git add -A && git commit -m 'data: 更新数据' && git push"
