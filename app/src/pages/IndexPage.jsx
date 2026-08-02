// A股宽基指数：13 个宽基/特色指数今年以来涨跌幅排名条形图。
import { useEffect, useRef } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { COLORS, MOBILE, fmtP } from "../chartBase";
import { INDEX_YTD as IX } from "../data/idx_data";

export default function IndexPage() {
  const { theme } = useTheme();
  const box = useRef(null);

  useEffect(() => {
    if (!IX?.items?.length) return;
    const C = vars(...COLORS);
    const items = [...IX.items].reverse(); // ECharts 类目轴自下而上, 反转让涨幅最大在顶
    // 移动端: 柱长≥数据跨度20%(约一个标签宽)才放柱内, 短柱外置
    const span = Math.max(0, ...items.map((i) => i.ytd)) - Math.min(0, ...items.map((i) => i.ytd));
    const inside = (v) => MOBILE && Math.abs(v) >= 0.2 * span;
    const m = echarts.init(box.current, null, { renderer: "canvas" });
    m.setOption({
      grid: { left: 8, right: 8, top: 6, bottom: 24, containLabel: true },
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: C.tip,
        borderColor: C.grid,
        borderWidth: 1,
        textStyle: { color: C.ink, fontSize: 12 },
        formatter: (p) => {
          const it = items[p.dataIndex];
          return (
            `${it.name}<br>今年以来 <b>${fmtP(it.ytd)}</b><br>收盘 ${it.close} · ${it.date}` +
            (it.stale ? `<br><span style="color:${C.muted}">数据源失败，沿用上次</span>` : "")
          );
        },
      },
      xAxis: {
        type: "value",
        boundaryGap: ["6%", "6%"], // 两端留白: 最长柱的外置标签否则会被 grid 裁掉
        axisLabel: { color: C.muted, fontSize: 11, formatter: "{value}%" },
        splitLine: { lineStyle: { color: C.grid } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: "category",
        data: items.map((i) => i.name),
        axisLabel: { color: C.ink2, fontSize: 12 },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 14,
          data: items.map((i) => ({
            value: i.ytd,
            label: {
              show: true,
              fontSize: 11,
              formatter: () => fmtP(i.ytd),
              position: inside(i.ytd)
                ? i.ytd >= 0 ? "insideRight" : "insideLeft"
                : i.ytd >= 0 ? "right" : "left",
              color: inside(i.ytd) ? "#fff" : C.ink2,
            },
            itemStyle: {
              color: i.ytd >= 0 ? C.up : C.down,
              opacity: i.stale ? 0.35 : 1, // stale = 该源今日失败, 沿用上次
              borderRadius: i.ytd >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4],
            },
          })),
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: C.baseline },
            data: [{ xAxis: 0 }],
            label: { show: false },
          },
        },
      ],
    });
    const onResize = () => m.resize();
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      m.dispose();
    };
  }, [theme]);

  if (!IX?.items?.length) return null;
  return (
    <div className="wrap">
      <header>
        <h1>A股宽基指数</h1>
        <div className="sub">更新于 {IX.updated}</div>
      </header>
      <div className="card">
        <h2>
          今年以来涨跌幅 <span className="dot">基准为上年最后交易日收盘</span>
        </h2>
        <div ref={box} className="chart idx" />
      </div>
    </div>
  );
}
