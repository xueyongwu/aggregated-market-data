// A股趋势：4 张统计瓦片 + 日中位数柱 + 累计中位数线 + 全市场成交额 + 两融余额。
import { useEffect, useMemo, useRef, useState } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { COLORS, MOBILE, fmtP, tip, xDate, yPct } from "../chartBase";
import { MEDIAN_DATA as D } from "../data/median_data";
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

// 区间 -> 起始下标。近 N 年按「N 年前的今天」切, 不是按自然年;
// 成交额那份本来就只有 5 年, 「近 5 年」档切不动, 等于全部
function since(dates, range) {
  if (range === "all") return 0;
  const last = dates[dates.length - 1];
  const from = range === "ytd"
    ? last.slice(0, 4) + "-01-01"
    : (+last.slice(0, 4) - range) + last.slice(4);
  const i = dates.findIndex((d) => d >= from);
  return i < 0 ? 0 : i;
}
const sign = (v) => (v >= 0 ? "pos" : "neg");

// 今年以来切片; 累计从 0 起重算
function slice() {
  const cut = D.dates[D.dates.length - 1].slice(0, 4) + "-01-01";
  const i0 = D.dates.findIndex((d) => d >= cut);
  const s = i0 < 0 ? D.dates.length : i0;
  const median = D.median.slice(s);
  let run = 0;
  const cum = median.map((v) => +(run += v).toFixed(3));
  return {
    dates: D.dates.slice(s),
    median,
    cum,
    count: D.count.slice(s),
    upRatio: D.upRatio.slice(s),
  };
}

export default function AStockPage() {
  const { theme } = useTheme();
  const mainRef = useRef(null);
  const cumRef = useRef(null);
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
  const V = useMemo(() => slice(), []);

  useEffect(() => {
    const C = vars(...COLORS);
    const mMain = echarts.init(mainRef.current, null, { renderer: "canvas" });
    mMain.setOption({
      grid: { left: GL, right: MOBILE ? 12 : 20, top: 24, bottom: 36 },
      tooltip: {
        ...tip(C),
        formatter: (p) => {
          const i = p[0].dataIndex;
          return (
            `${V.dates[i]}<br>日中位数 <b>${fmtP(V.median[i])}</b><br>` +
            `上涨占比 ${V.upRatio[i].toFixed(1)}%<br>样本 ${V.count[i]} 股`
          );
        },
      },
      xAxis: { ...xDate(C), boundaryGap: true, data: V.dates },
      yAxis: yPct(C),
      series: [
        {
          type: "bar",
          barMaxWidth: 6,
          data: V.median,
          itemStyle: { color: (p) => (p.value >= 0 ? C.up : C.down), borderRadius: 1 },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: C.baseline },
            data: [{ yAxis: 0 }],
            label: { show: false },
          },
        },
      ],
    });

    const mCum = echarts.init(cumRef.current, null, { renderer: "canvas" });
    mCum.setOption({
      grid: { left: GL, right: MOBILE ? 12 : 20, top: 20, bottom: 28 },
      tooltip: {
        ...tip(C),
        formatter: (p) => `${V.dates[p[0].dataIndex]}<br>累计 <b>${fmtP(V.cum[p[0].dataIndex])}</b>`,
      },
      xAxis: { ...xDate(C), data: V.dates },
      yAxis: yPct(C),
      series: [
        {
          type: "line",
          showSymbol: false,
          data: V.cum,
          lineStyle: { width: 2, color: C.blue },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(57,135,229,.28)" },
              { offset: 1, color: "rgba(57,135,229,0)" },
            ]),
          },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: C.baseline },
            data: [{ yAxis: 0 }],
            label: { show: false },
          },
        },
      ],
    });

    const onResize = () => { mMain.resize(); mCum.resize(); };
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      mMain.dispose();
      mCum.dispose();
    };
  }, [V, theme]);

  // 成交额单独一个 effect: 换区间只重建这张图。日频 1200 点, sampling lttb 抽稀;
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
              { offset: 0, color: "rgba(57,135,229,.28)" },
              { offset: 1, color: "rgba(57,135,229,0)" },
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
  }, [A, theme]);

  // 两融同理单独一个 effect。左轴余额右轴占比都从 0 起: 两轴各自 scale 会把「余额创
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
              { offset: 0, color: "rgba(57,135,229,.28)" },
              { offset: 1, color: "rgba(57,135,229,0)" },
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
  }, [M, theme]);

  const last = V.dates.length - 1;
  const L = D.latest || {};
  const t = TURNOVER.dates.length - 1;

  return (
    <div className="wrap">
      <header>
        <div className="sub">更新于 {D.updated}</div>
      </header>

      <div className="tiles">
        <div className="tile">
          <span className="k">最新日中位数</span>
          <span className={`v ${sign(V.median[last])}`}>{fmtP(V.median[last])}</span>
          <span className="u">{V.dates[last]}</span>
        </div>
        <div className="tile">
          <span className="k">累计中位数</span>
          <span className={`v ${sign(V.cum[last])}`}>{fmtP(V.cum[last])}</span>
          <span className="u">今年累加</span>
        </div>
        <div className="tile">
          <span className="k">今日涨跌分布</span>
          <span className="v">
            <span className="pos">{L.up ?? "–"}</span>
            <span className="sep">/</span>
            {L.flat ?? "–"}
            <span className="sep">/</span>
            <span className="neg">{L.down ?? "–"}</span>
          </span>
          <span className="u">上涨 / 平 / 下跌</span>
        </div>
        <div className="tile">
          <span className="k">今日涨跌停</span>
          <span className="v">
            <span className="pos">{L.limitUp ?? "–"}</span>
            <span className="sep">/</span>
            <span className="neg">{L.limitDown ?? "–"}</span>
          </span>
          <span className="u">涨停 / 跌停 (剔ST)</span>
        </div>
        <div className="tile">
          <span className="k">今日成交额</span>
          <span className="v">{TURNOVER.amt[t].toFixed(2)}<small>万亿</small></span>
          <span className="u">20 日均 {MA20[t].toFixed(2)} 万亿</span>
        </div>
      </div>

      <div className="card">
        <h2>
          日中位数 <span className="dot">全 A 股(沪深 + 北交所)当日涨跌幅的中位数，剔停牌，红涨绿跌</span>
        </h2>
        <div ref={mainRef} className="chart main" />
      </div>

      <div className="card">
        <h2>
          累计中位数 <span className="dot">日中位数逐日累加，反映长期资金冷暖</span>
        </h2>
        <div ref={cumRef} className="chart cum" />
      </div>

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
