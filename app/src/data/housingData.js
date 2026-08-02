// 房价数据的辅助函数（手写，勿删）
//
// 数据本体由 generate_js_data.py 生成到 housingData.generated.js。
// 这两者必须分开：早前函数和数据混在一个文件里，重跑 generator 会把函数全冲掉。
import { cityTiers, dataByYear, availableYears } from "./housingData.generated";

export { cityTiers, dataByYear, availableYears };

// 获取某月环比>100的城市列表
export function getCitiesAbove100(dataObj, monthIndex) {
  const allCities = Object.keys(dataObj);
  return allCities.filter((city) => dataObj[city][monthIndex] > 100);
}

// ========== 首页多年柱状图辅助函数 ==========

// 获取完整时间轴标签 (如 "2021-7月", "2021-8月", ..., "2026-5月")
export function getFullTimeline() {
  const labels = [];
  for (const year of availableYears) {
    const months = dataByYear[year].months;
    months.forEach((m) => {
      labels.push(`${year}-${m}`);
    });
  }
  return labels;
}

// 统计某月环比上涨/持平/下跌的城市数量（指数 100 = 持平）
function countChange(dataObj, monthIndex) {
  let up = 0, flat = 0, down = 0;
  for (const city of Object.keys(dataObj)) {
    const v = dataObj[city][monthIndex];
    if (v == null) continue;
    if (v > 100) up++;
    else if (v < 100) down++;
    else flat++;
  }
  return { up, flat, down };
}

// 获取多年连续的上涨/持平/下跌城市数量序列
export function getMultiYearChangeCounts() {
  const result = {
    newHouse: { up: [], flat: [], down: [] },
    secondHand: { up: [], flat: [], down: [] },
  };
  for (const year of availableYears) {
    const { months, newHouse, secondHand } = dataByYear[year];
    months.forEach((_, i) => {
      const n = countChange(newHouse, i);
      const s = countChange(secondHand, i);
      result.newHouse.up.push(n.up);
      result.newHouse.flat.push(n.flat);
      result.newHouse.down.push(n.down);
      result.secondHand.up.push(s.up);
      result.secondHand.flat.push(s.flat);
      result.secondHand.down.push(s.down);
    });
  }
  return result;
}
