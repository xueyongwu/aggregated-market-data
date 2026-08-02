// A股全市场每日涨跌幅中位数看板（原 index.html）。
// 四块：统计瓦片 / 国债活跃券 / 日中位数柱 / 累计中位数线 / 宽基指数 YTD 排名条。
import { useEffect, useMemo, useRef, useState } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { poll } from "../jsonp";
import { MEDIAN_DATA as D } from "../data/median_data";
import { INDEX_YTD as IX } from "../data/idx_data";
import { BOND_ACTIVE as BD } from "../data/bond_data";

const MOBILE = matchMedia("(max-width:680px)").matches;
const GL = MOBILE ? 42 : 52; // 图表左边距, 窄屏收紧

const sign = (v) => (v >= 0 ? "pos" : "neg");
const fmt = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

const tip = (C) => ({
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
const yBase = (C) => ({
  type: "value",
  axisLabel: { color: C.muted, fontSize: 11, formatter: "{value}%" },
  splitLine: { lineStyle: { color: C.grid } },
  axisLine: { show: false },
  axisTick: { show: false },
});
const xBase = (C) => ({
  type: "category",
  boundaryGap: false,
  axisLine: { lineStyle: { color: C.baseline } },
  axisTick: { show: false },
  axisLabel: { color: C.muted, fontSize: 11, formatter: (d) => d.slice(5) },
});

const COLORS = ["up", "down", "blue", "ink", "ink2", "muted", "grid", "baseline", "surface", "tip", "tiplabel"];

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

// 银行间 9:00-17:00 成交, 20:00 定版; 按北京时间判, 不信浏览器时区
function bondOpen() {
  const t = new Date(Date.now() + new Date().getTimezoneOffset() * 6e4 + 288e5);
  const m = t.getHours() * 60 + t.getMinutes();
  return t.getDay() >= 1 && t.getDay() <= 5 && m >= 540 && m <= 1230;
}

// 日内滚动: 按券代码单条拉(~850B, 不带 bondCode 是全市场 2998 行 1.8MB)。
// 中国货币网回 Access-Control-Allow-Origin:*, 浏览器直连即可 —— 但只能发 simple GET,
// 加任何自定义头会触发 preflight, 而该站 OPTIONS 一律 403。
// 换券只在 CI 那次全量里重挑, 页面开着不换 —— 换券是季度级事件, 隔夜刷新即可。
const CBT =
  "https://www.chinamoney.com.cn/ags/ms/cm-u-md-bond/CbtPri?lang=cn&flag=1&pageNum=1&pageSize=15&bondCode=";

function BondCard() {
  const [items, setItems] = useState(() => BD?.items ?? []);
  useEffect(() => {
    if (!items.length) return;
    return poll(async () => {
      if (!bondOpen()) return;
      const next = await Promise.all(
        items.map(async (b) => {
          try {
            const rec = (await (await fetch(CBT + b.code)).json()).records[0];
            if (!rec || !rec.dmiLatestContraRate) return b; // 当日尚无成交: 留着上次的值
            return {
              ...b,
              yield: +rec.dmiLatestContraRate,
              bp: rec.bpNum == null ? null : +rec.bpNum,
              vol: Math.round(+rec.dmiTtlTradedAmnt * 10) / 10,
              time: rec.showDate,
            };
          } catch {
            return b; // 拉不到就保持静态值, 时间戳自己会露馅
          }
        }),
      );
      setItems(next);
    }, 60000); // 债券报价比股票慢, 1 分钟够
    // items 只在 poll 里被整体替换, 依赖它会每次重挂定时器 —— 只在挂载时装一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!items.length) return null;
  return (
    <div className="card">
      <h2>
        国债活跃券收益率 <span className="dot">银行间当日成交量最大的券，收益率上行=债价下跌</span>
      </h2>
      <div className="bond">
        {items.map((b) => (
          <div className="b" key={b.code}>
            <span className="t">{b.term}期</span>
            <span className="y">
              {b.yield.toFixed(4)}%
              {b.bp == null ? (
                <i>—</i>
              ) : (
                <small className={sign(b.bp)}>{(b.bp >= 0 ? "+" : "") + b.bp.toFixed(2)}bp</small>
              )}
            </span>
            <span className="m">
              {b.name}
              <i>
                剩余 {b.maturity} · 成交 {b.vol} 亿
              </i>
            </span>
            <span className="t">{b.time.slice(5, 16)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AStockPage() {
  const { theme } = useTheme();
  const mainRef = useRef(null);
  const cumRef = useRef(null);
  const idxRef = useRef(null);
  const V = useMemo(() => slice(), []);

  // 日中位数 + 累计中位数
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
            `${V.dates[i]}<br>日中位数 <b>${fmt(V.median[i])}</b><br>` +
            `上涨占比 ${V.upRatio[i].toFixed(1)}%<br>样本 ${V.count[i]} 股`
          );
        },
      },
      xAxis: { ...xBase(C), boundaryGap: true, data: V.dates },
      yAxis: yBase(C),
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
        formatter: (p) => `${V.dates[p[0].dataIndex]}<br>累计 <b>${fmt(V.cum[p[0].dataIndex])}</b>`,
      },
      xAxis: { ...xBase(C), data: V.dates },
      yAxis: yBase(C),
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

    const onResize = () => {
      mMain.resize();
      mCum.resize();
    };
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      mMain.dispose();
      mCum.dispose();
    };
  }, [V, theme]);

  // 宽基指数 YTD 排名条形图(数据独立于中位数管道, 缺 idx_data.js 则不渲染卡片)
  useEffect(() => {
    if (!IX?.items?.length) return;
    const C = vars(...COLORS);
    const items = [...IX.items].reverse(); // ECharts 类目轴自下而上, 反转让涨幅最大在顶
    // 移动端: 柱长≥数据跨度20%(约一个标签宽)才放柱内, 短柱外置
    const span =
      Math.max(0, ...items.map((i) => i.ytd)) - Math.min(0, ...items.map((i) => i.ytd));
    const inside = (v) => MOBILE && Math.abs(v) >= 0.2 * span;
    const m = echarts.init(idxRef.current, null, { renderer: "canvas" });
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
            `${it.name}<br>今年以来 <b>${fmt(it.ytd)}</b><br>收盘 ${it.close} · ${it.date}` +
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
              formatter: () => fmt(i.ytd),
              position: inside(i.ytd)
                ? i.ytd >= 0
                  ? "insideRight"
                  : "insideLeft"
                : i.ytd >= 0
                  ? "right"
                  : "left",
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

  const last = V.dates.length - 1;
  const L = D.latest || {};

  return (
    <div className="wrap">
      <header>
        <h1>A股全市场 · 数据看板</h1>
        <div className="sub">更新于 {D.updated}</div>
      </header>

      <div className="tiles">
        <div className="tile">
          <span className="k">最新日中位数</span>
          <span className={`v ${sign(V.median[last])}`}>{fmt(V.median[last])}</span>
          <span className="u">{V.dates[last]}</span>
        </div>
        <div className="tile">
          <span className="k">累计中位数</span>
          <span className={`v ${sign(V.cum[last])}`}>{fmt(V.cum[last])}</span>
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

      <BondCard />

      <div className="card">
        <h2>
          日中位数 <span className="dot">全市场当日涨跌幅的中位数(剔停牌)，红涨绿跌</span>
        </h2>
        <div ref={mainRef} className="chart main" />
      </div>

      <div className="card">
        <h2>
          累计中位数 <span className="dot">日中位数逐日累加，反映长期资金冷暖</span>
        </h2>
        <div ref={cumRef} className="chart cum" />
      </div>

      {IX?.items?.length ? (
        <div className="card">
          <h2>
            宽基指数 · 今年以来涨跌幅 <span className="dot">基准为上年最后交易日收盘</span>
          </h2>
          <div ref={idxRef} className="chart idx" />
        </div>
      ) : null}
    </div>
  );
}
