// 房价页图表的共享视觉语言，色值现读 theme.css 的变量。
// 编辑型风格：无网格噪音、发丝线、衬线标题、灰阶 UI + 语义色。
import { vars } from "./theme";

/** 图表配色。在 effect / 事件里调用(要等 theme.css 已加载)。 */
export function chartColors() {
  const v = vars("ink", "ink-2", "ink-3", "ink-4", "rule", "surface",
                 "up", "flat", "down", "series-1", "series-2");
  return {
    ink: v.ink,
    ink2: v["ink-2"],
    ink3: v["ink-3"],
    ink4: v["ink-4"],
    rule: v.rule,
    paper: v.surface,
    up: v.up,
    flat: v.flat,
    down: v.down,
    series1: v["series-1"], // 新建商品住宅
    series2: v["series-2"], // 二手住宅
  };
}

export const titleStyle = (C, text, size = 17) => ({
  text,
  left: 0,
  textStyle: {
    fontSize: size,
    fontWeight: 600,
    color: C.ink,
    fontFamily: '"Songti SC", "Source Han Serif SC", Georgia, serif',
  },
});

export const axisCommon = (C) => ({
  axisLine: { lineStyle: { color: C.rule } },
  axisTick: { lineStyle: { color: C.rule } },
  axisLabel: { color: C.ink3, fontSize: 11 },
  splitLine: { lineStyle: { color: C.rule, type: "dashed" } },
});

export const tooltipCommon = (C) => ({
  backgroundColor: C.paper,
  borderColor: C.rule,
  borderWidth: 1,
  textStyle: { color: C.ink2, fontSize: 13 },
  extraCssText: "box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-radius: 2px;",
});
