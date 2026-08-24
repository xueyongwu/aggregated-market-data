// A股中位数：4 张统计瓦片 + 日中位数柱 + 累计中位数线。
import { useEffect, useMemo, useRef } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { COLORS, MOBILE, fmtP, tip, xDate, yPct } from "../chartBase";
import { MEDIAN_DATA as D } from "../data/median_data";

const GL = MOBILE ? 42 : 52; // 图表左边距, 窄屏收紧
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

export default function MedianPage() {
  const { theme } = useTheme();
  const mainRef = useRef(null);
  const cumRef = useRef(null);
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

  const last = V.dates.length - 1;
  const L = D.latest || {};

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
          <span className="k">今日涨跌停</span>
          <span className="v">
            <span className="pos">{L.limitUp ?? "–"}</span>
            <span className="sep">/</span>
            <span className="neg">{L.limitDown ?? "–"}</span>
          </span>
          <span className="u">涨停 / 跌停 (剔ST)</span>
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
    </div>
  );
}
