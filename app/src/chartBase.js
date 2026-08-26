// 股票几页共用的 ECharts 零件。色值一律由调用方先 vars(...COLORS) 现读再传进来 ——
// 颜色在 setOption 时就烤进图里了，换肤只能 dispose 重建（见 theme.jsx）。
export const MOBILE = matchMedia("(max-width:680px)").matches;

export const COLORS = [
  "up", "down", "blue", "avg", "ink", "ink2", "muted",
  "grid", "baseline", "surface", "tip", "tiplabel",
];

export const fmtP = (v, d = 2) => (v >= 0 ? "+" : "") + v.toFixed(d) + "%";

export const tip = (C) => ({
  trigger: "axis",
  confine: true,
  backgroundColor: C.tip,
  borderColor: C.grid,
  borderWidth: 1,
  textStyle: { color: C.ink, fontSize: 12 },
  axisPointer: {
    type: "cross",
    lineStyle: { color: C.muted, type: "dashed" },
    crossStyle: { color: C.muted },
    label: { backgroundColor: C.tiplabel },
  },
});

/** 百分比纵轴（中位数、指数涨跌幅）。 */
export const yPct = (C) => ({
  type: "value",
  axisLabel: { color: C.muted, fontSize: 11, formatter: "{value}%" },
  splitLine: { lineStyle: { color: C.grid } },
  axisLine: { show: false },
  axisTick: { show: false },
});

/** 价格纵轴（日K、分时）。scale 让它按数据区间收紧，不从 0 起。 */
export const yPrice = (C) => ({
  type: "value",
  scale: true,
  axisLabel: { color: C.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: C.grid } },
  axisLine: { show: false },
  axisTick: { show: false },
});

/** 日期类目横轴，标签只显 MM-DD。 */
export const xDate = (C) => ({
  type: "category",
  boundaryGap: false,
  axisLine: { lineStyle: { color: C.baseline } },
  axisTick: { show: false },
  axisLabel: { color: C.muted, fontSize: 11, formatter: (d) => d.slice(5) },
});

// 十字线不越过最新数据: 悬停在右侧空槽区时锁回最后一个有值的点(同花顺分时交互)。
// 每次 mousemove 都要 dispatch —— ECharts 原生 axisPointer 也在跟鼠标, 少一次就跟丢。
export function clampTip(ch, lastIdx) {
  ch.__last = lastIdx; // 数据每次刷新都更新, 监听器只挂一次
  if (ch.__clamped) return;
  ch.__clamped = true;
  ch.getZr().on("mousemove", (e) => {
    const i = ch.__last;
    if (!(i >= 0)) return;
    const x = ch.convertToPixel({ xAxisIndex: 0 }, i);
    if (e.offsetX > x) ch.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: i });
  });
}
