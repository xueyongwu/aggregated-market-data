// A股：指数今年以来涨跌幅排名 + 全市场成交额 + 两融余额(后两张各带一排区间筛选)。
import { useEffect, useMemo, useRef, useState } from "react";
import { echarts } from "../echarts";
import { vars } from "../theme";
import { COLORS, MOBILE, fade, fmtP, since, tip, xDate } from "../chartBase";
import { INDEX_YTD as IX } from "../data/idx_data";
import { TURNOVER } from "../data/turnover_data";
import { MARGIN } from "../data/margin_data";

const GL = MOBILE ? 42 : 52; // 图表左边距, 窄屏收紧
const RANGES = [["今年以来", "ytd"], ["近 1 年", "1"], ["近 3 年", "3"], ["近 5 年", "5"]];
// 两融多一档「全部」: 东财那份从 2010 年就有, 2015 年那轮杠杆牛是这张图最值钱的对照
const M_RANGES = [["全部", "all"], ...RANGES];
const MA_WIN = 20;
// 图例挂图下方: 成交额/两融都是双线, 颜色靠它认, 副标题里就不用再写「蓝线/黄线」
const legend = (C) => ({
  bottom: 0,
  itemWidth: 14,
  itemHeight: 2,
  itemGap: 16,
  textStyle: { color: C.muted, fontSize: 11 },
});

// 成交额 20 日均线: 在完整序列上算好再按区间切, 所以「今年以来」档 1 月 2 日就有均线值
const MA20 = (() => {
  let sum = 0;
  return TURNOVER.amt.map((v, i) => {
    sum += v - (i >= MA_WIN ? TURNOVER.amt[i - MA_WIN] : 0);
    return i >= MA_WIN - 1 ? +(sum / MA_WIN).toFixed(3) : null;
  });
})();

// 宽基/特色/港股 15 个指数今年以来涨跌幅排名条形图(数据 index_perf.py -> idx_data.js)。
// 原是独立的「宽基指数」页(IndexPage, 已删), 2026-11 挪到这页最上面。
function IdxCard() {
  const box = useRef(null);

  useEffect(() => {
    if (!IX?.items?.length) return;
    const C = vars(...COLORS);
    const items = [...IX.items].reverse(); // ECharts 类目轴自下而上, 反转让涨幅最大在顶
    // 轴按两侧绝对值最大的那根收紧(对称), 不让 echarts 自动圆到 ±30% 白留一大截
    const cap = Math.max(...items.map((i) => Math.abs(i.ytd)));
    // 柱长≥半轴40%(约一个标签宽)才放柱内 —— 轴收紧后最长那根顶到 grid 边,
    // 标签外置会被裁掉(负向的还会压到左边类目名上), 所以这条不再只对移动端生效
    const inside = (v) => Math.abs(v) >= 0.4 * cap;
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
        min: -cap,
        max: cap, // 设了 min/max 后 boundaryGap 失效, 两端一点不留
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
  }, []);

  if (!IX?.items?.length) return null;
  return (
    <div className="card">
      <h2>
        今年以来涨跌幅 <span className="dot">基准为上年最后交易日收盘 · 更新于 {IX.updated}</span>
      </h2>
      <div ref={box} className="chart idx" />
    </div>
  );
}

export default function AStockPage() {
  const amtRef = useRef(null);
  const mgnRef = useRef(null);
  const [range, setRange] = useState("ytd");
  const [mRange, setMRange] = useState("ytd");
  const A = useMemo(() => {
    const i = since(TURNOVER.dates, range);
    return { dates: TURNOVER.dates.slice(i), amt: TURNOVER.amt.slice(i), ma20: MA20.slice(i) };
  }, [range]);
  const M = useMemo(() => {
    const i = since(MARGIN.dates, mRange);
    return { dates: MARGIN.dates.slice(i), bal: MARGIN.bal.slice(i), ratio: MARGIN.ratio.slice(i) };
  }, [mRange]);

  // 成交额、两融各一个 effect: 换区间只重建那一张图。日频 1200 点, sampling lttb 抽稀;
  // 横轴跨 5 年, xDate 默认的 MM-DD 看不出年份, 改显年月。
  useEffect(() => {
    const C = vars(...COLORS);
    const m = echarts.init(amtRef.current, null, { renderer: "canvas" });
    m.setOption({
      grid: { left: GL, right: MOBILE ? 12 : 20, top: 20, bottom: 48 },
      legend: legend(C),
      tooltip: {
        ...tip(C),
        formatter: (p) => {
          const i = p[0].dataIndex;
          const ma = A.ma20[i];
          return `${A.dates[i]}<br>成交额 <b>${A.amt[i].toFixed(2)} 万亿</b>` +
            (ma == null ? "" : `<br>20 日均 ${ma.toFixed(2)} 万亿`);
        },
      },
      xAxis: {
        ...xDate(C),
        data: A.dates,
        axisLabel: { ...xDate(C).axisLabel, formatter: (d) => d.slice(0, 7) },
      },
      yAxis: {
        type: "value",
        min: 0,
        axisLabel: { color: C.muted, fontSize: 11, formatter: "{value}万亿" },
        splitLine: { lineStyle: { color: C.grid } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      dataZoom: [{ type: "inside" }],
      series: [
        {
          name: "成交额",
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          data: A.amt,
          lineStyle: { width: 1, color: C.blue },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: fade(C.blue, .28) },
              { offset: 1, color: fade(C.blue, 0) },
            ]),
          },
        },
        { name: "20 日均线", type: "line", showSymbol: false, sampling: "lttb", data: A.ma20,
          lineStyle: { width: 1.6, color: C.avg } },
      ],
    });
    const onResize = () => m.resize();
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      m.dispose();
    };
  }, [A]);

  // 两融: 左轴余额右轴占比都从 0 起: 两轴各自 scale 会把「余额创
  // 新高但占比没跟上」这唯一值钱的信息抹平; 右轴钉死 5%(2015 峰值 4.70%)让两条线错开,
  // 不然万亿和 % 两个数量级撞在一起, 线会叠成一根。
  useEffect(() => {
    const C = vars(...COLORS);
    const m = echarts.init(mgnRef.current, null, { renderer: "canvas" });
    m.setOption({
      grid: { left: GL, right: MOBILE ? 34 : 44, top: 20, bottom: 48 },
      legend: legend(C),
      tooltip: {
        ...tip(C),
        formatter: (p) => {
          const i = p[0].dataIndex;
          return `${M.dates[i]}<br>两融余额 <b>${M.bal[i].toFixed(2)} 万亿</b>` +
            `<br>融资占流通市值 ${M.ratio[i].toFixed(2)}%`;
        },
      },
      xAxis: {
        ...xDate(C),
        data: M.dates,
        axisLabel: { ...xDate(C).axisLabel, formatter: (d) => d.slice(0, 7) },
      },
      yAxis: [
        {
          type: "value",
          min: 0,
          axisLabel: { color: C.muted, fontSize: 11, formatter: "{value}万亿" },
          splitLine: { lineStyle: { color: C.grid } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        {
          type: "value",
          min: 0,
          max: (v) => Math.max(5, Math.ceil(v.max)),
          axisLabel: { color: C.muted, fontSize: 11, formatter: "{value}%" },
          splitLine: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
        },
      ],
      dataZoom: [{ type: "inside" }],
      series: [
        {
          name: "两融余额（左轴）",
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          data: M.bal,
          lineStyle: { width: 1, color: C.blue },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: fade(C.blue, .28) },
              { offset: 1, color: fade(C.blue, 0) },
            ]),
          },
        },
        { name: "融资占流通市值（右轴）", type: "line", yAxisIndex: 1, showSymbol: false, sampling: "lttb", data: M.ratio,
          lineStyle: { width: 1.6, color: C.avg } },
      ],
    });
    const onResize = () => m.resize();
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      m.dispose();
    };
  }, [M]);

  return (
    <div className="wrap">
      <IdxCard />
      <div className="card">
        <h2>
          全市场成交额 <span className="dot">
            沪深两市每日成交额（不含北交所，占比 &lt;1%）与 20 日均线
          </span>
        </h2>
        <select className="pick" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map(([label, r]) => <option key={r} value={r}>{label}</option>)}
        </select>
        <div ref={amtRef} className="chart amt" />
      </div>

      <div className="card">
        <h2>
          两融余额 <span className="dot">
            沪深两市融资 + 融券余额与融资余额占流通市值比
          </span>
        </h2>
        <select className="pick" value={mRange} onChange={(e) => setMRange(e.target.value)}>
          {M_RANGES.map(([label, r]) => <option key={r} value={r}>{label}</option>)}
        </select>
        <div ref={mgnRef} className="chart amt" />
      </div>
    </div>
  );
}
