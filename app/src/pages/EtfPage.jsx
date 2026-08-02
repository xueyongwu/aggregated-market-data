// 159696 走势：分时（点日K可切历史日）+ 日K。
//
// 命令式：两个实时源都没有 CORS 头，只能 <script> 注入，回调里直接改模块级的 ETF_DATA
// 再重画图。硬搬进 React state 得把每根 bar 都变成不可变更新，8s 一轮的轮询下毫无收益。
import { useEffect, useRef, useState } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { jsonp, poll } from "../jsonp";
import { COLORS, MOBILE, clampTip, fmtP, tip, yPrice } from "../chartBase";
import { ETF_DATA as D } from "../data/etf_data";

const GL = MOBILE ? 46 : 56; // 图表左边距, 窄屏收紧

const fmtVol = (v) => (v >= 1e8 ? (v / 1e8).toFixed(2) + "亿" : (v / 1e4).toFixed(1) + "万");
const px = (v) => v.toFixed(3);
const pctOf = (a, b) => ((a / b - 1) * 100).toFixed(2) + "%";

// A股全日分时时间轴 09:31–11:30 / 13:01–15:00 (240格), 半日数据右侧留空到 15:00
const FULLT = (() => {
  const a = [];
  let [h, m] = [9, 31];
  for (let k = 0; k < 240; k++) {
    a.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    m++;
    if (m === 60) { m = 0; h++; }
    if (h === 11 && m === 31) { h = 13; m = 1; } // 跳午休
  }
  return a;
})();

// 实时行情: 拉新浪今日 1min bar, 追加/更新今日日K + 分时。
// <script> 注入绕 CORS, var e= 落 window.e (该接口无防盗链)。
const ETF_URL =
  "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20e=/CN_MarketDataService.getKLineData?symbol=sz159696&scale=1&ma=no&datalen=240";
// 逐笔快照: 腾讯 qt (无防盗链), 落全局 v_sz159696。1min bar 建线, 这里每几秒推当前价。
const SNAP_URL = "https://qt.gtimg.cn/q=sz159696";

export default function EtfPage() {
  const { theme } = useTheme();
  const kBox = useRef(null), iBox = useRef(null);
  const mK = useRef(null), mI = useRef(null);
  const pinned = useRef(false); // 用户点历史K后固定, 实时轮询不再抢回最新日
  const curDay = useRef(D.kline[D.kline.length - 1]?.[0]);
  const [head, setHead] = useState({ title: "分时", chg: null, at: D.updated });

  const buildKline = () => {
    const C = vars(...COLORS);
    if (!mK.current) {
      // 只 init 一次, 后续 setOption 合并更新, 不 dispose (消闪)
      mK.current = echarts.init(kBox.current, null, { renderer: "canvas" });
      mK.current.on("click", (p) => {
        if (p.componentType !== "series") return;
        const cd = D.kline[p.dataIndex][0];
        pinned.current = cd !== D.kline[D.kline.length - 1][0]; // 点非最新日=固定看历史; 点最新日=跟随实时
        showDay(cd);
      });
    }
    mK.current.setOption({
      grid: { left: GL, right: MOBILE ? 12 : 20, top: 24, bottom: 36 },
      tooltip: {
        ...tip(C),
        formatter: (ps) => {
          const i = ps[0].dataIndex, r = D.kline[i];
          const prev = i > 0 ? D.kline[i - 1][2] : r[1];
          return (
            `${r[0]}<br>开 ${px(r[1])}  收 <b>${px(r[2])}</b> (${pctOf(r[2], prev)})<br>` +
            `低 ${px(r[3])}  高 ${px(r[4])}<br>量 ${fmtVol(r[5])}  额 ${fmtVol(r[6])}`
          );
        },
      },
      dataZoom: [{ type: "inside", start: 0, end: 100 }],
      xAxis: {
        type: "category",
        data: D.kline.map((r) => r[0]),
        axisLine: { lineStyle: { color: C.baseline } },
        axisTick: { show: false },
        axisLabel: { color: C.muted, fontSize: 11, formatter: (d) => d.slice(5) },
      },
      yAxis: yPrice(C),
      series: [
        {
          type: "candlestick",
          data: D.kline.map((r) => [r[1], r[2], r[3], r[4]]),
          // 阳线空心红 / 阴线实心绿: 形状+颜色双编码
          itemStyle: { color: "transparent", color0: C.down, borderColor: C.up, borderColor0: C.down },
        },
      ],
    });
  };

  const showDay = (date) => {
    const d = D.intraday[date];
    if (!d || !mI.current) return;
    curDay.current = date;
    const C = vars(...COLORS);
    const i = D.kline.findIndex((r) => r[0] === date);
    const prevClose = i > 0 ? D.kline[i - 1][2] : D.kline[i][1];
    let cv = 0, cvv = 0;
    const avg = d.c.map((c, j) => { cv += c * d.v[j]; cvv += d.v[j]; return +(cv / (cvv || 1)).toFixed(3); });
    // 最新K的分时: 标题"分时" + hero 行(大涨跌幅 + 更新于); 历史K: 标题带日期, 隐藏 hero
    const isLatest = date === D.kline[D.kline.length - 1][0];
    const last = d.c[d.c.length - 1];
    setHead((h) => ({
      title: isLatest ? "分时" : `分时 · ${date}`,
      chg: isLatest ? (last / prevClose - 1) * 100 : null,
      at: h.at,
    }));
    // 围绕昨收对称定界, 右轴 = 左轴同刻度换算涨跌幅%, 零位即昨收
    const dev = Math.max(...d.c.concat(avg).map((v) => Math.abs(v - prevClose))) || prevClose * 0.01;
    const p = (dev / prevClose) * 100;
    // 新浪无成交的分钟不出 bar, 按下标铺 FULLT 会整体左移(尾点提前几分钟) -> 按时间落槽, 空槽 null
    const sc = FULLT.map(() => null), sa = FULLT.map(() => null), sj = FULLT.map(() => -1);
    d.t.forEach((tt, j) => {
      const k = FULLT.indexOf(tt);
      if (k < 0) return;
      sc[k] = d.c[j]; sa[k] = avg[j]; sj[k] = j;
    });
    mI.current.setOption(
      {
        yAxis: [
          { min: prevClose - dev, max: prevClose + dev, interval: dev / 3,
            axisLabel: { color: C.muted, fontSize: 11, formatter: (v) => v.toFixed(3) } },
          { min: -p, max: p, interval: p / 3 },
        ],
        tooltip: {
          ...tip(C),
          formatter: (ps) => {
            const j = sj[ps[0].dataIndex];
            if (j < 0) return ""; // 空槽(该分钟无成交)
            return (
              `${date} ${d.t[j]}<br>现价 <b>${px(d.c[j])}</b> (${pctOf(d.c[j], prevClose)})<br>` +
              `均价 ${px(avg[j])}<br>量 ${fmtVol(d.v[j])}`
            );
          },
        },
        xAxis: { data: FULLT },
        series: [
          { data: sc,
            // 午间分隔线
            markLine: { silent: true, symbol: "none", lineStyle: { color: C.baseline, width: 1 },
                        data: [{ xAxis: "11:30" }], label: { show: false } } },
          { data: sa },
          { markLine: { silent: true, symbol: "none",
                        lineStyle: { color: C.muted, type: "dashed", width: 1.5, opacity: 0.9 },
                        data: [{ yAxis: prevClose }], label: { show: false } } },
        ],
      },
      { replaceMerge: [] },
    );
    clampTip(mI.current, sc.findLastIndex((v) => v != null));
  };

  useEffect(() => {
    const C = vars(...COLORS);
    mI.current = echarts.init(iBox.current, null, { renderer: "canvas" });
    mI.current.setOption({
      grid: { left: GL, right: MOBILE ? 46 : 56, top: 20, bottom: 28 },
      tooltip: tip(C),
      xAxis: {
        type: "category",
        boundaryGap: false,
        axisLine: { lineStyle: { color: C.baseline } },
        axisTick: { show: false },
        // 只标 09:30 / 11:30 / 15:00 (首根 bar 是 09:31, 显示为 09:30)
        axisLabel: {
          color: C.muted,
          fontSize: 11,
          interval: (i, v) => ["09:31", "11:30", "15:00"].includes(v),
          formatter: (v) => (v === "09:31" ? "09:30" : v),
        },
      },
      yAxis: [
        { ...yPrice(C), axisPointer: { label: { formatter: (p) => p.value.toFixed(3) } } },
        { type: "value", position: "right", splitLine: { show: false }, axisPointer: { show: false },
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: {
            fontSize: 11,
            formatter: (v) => { if (Math.abs(v) < 0.005) v = 0; return fmtP(v); },
            color: (v) => (v > 0.005 ? C.up : v < -0.005 ? C.down : C.muted),
          } },
      ],
      series: [
        { name: "现价", type: "line", showSymbol: false, connectNulls: true,
          lineStyle: { width: 2, color: C.blue },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(57,135,229,.25)" },
            { offset: 1, color: "rgba(57,135,229,0)" },
          ]) } },
        { name: "均价", type: "line", showSymbol: false, connectNulls: true,
          lineStyle: { width: 1.5, color: C.avg } },
        { name: "昨收", type: "line", data: [] },
      ],
    });
    buildKline();
    showDay(curDay.current);
    const onResize = () => { mK.current?.resize(); mI.current?.resize(); };
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      mK.current?.dispose(); mK.current = null;
      mI.current?.dispose(); mI.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    const stopLive = poll(() => {
      jsonp(ETF_URL, () => {
        const raw = window.e;
        if (!raw?.length) return;
        const day = raw[raw.length - 1].day.slice(0, 10);
        const bars = raw.filter((b) => b.day.slice(0, 10) === day); // 取最新一日 (盘中为半日)
        const t = [], c = [], v = [];
        let amt = 0, lo = 1 / 0, hi = 0;
        for (const b of bars) {
          t.push(b.day.slice(11, 16));
          c.push(+(+b.close).toFixed(3));
          v.push(+b.volume);
          amt += +b.amount;
          lo = Math.min(lo, +b.low);
          hi = Math.max(hi, +b.high);
        }
        const row = [day, +(+bars[0].open).toFixed(3), c[c.length - 1],
                     +lo.toFixed(3), +hi.toFixed(3), v.reduce((a, x) => a + x, 0), Math.round(amt)];
        const i = D.kline.findIndex((r) => r[0] === day);
        if (i < 0) D.kline.push(row); else D.kline[i] = row; // 今日尚无(CI 未跑)则追加, 否则原地更新
        D.intraday[day] = { t, c, v };
        buildKline();
        if (!pinned.current) {
          showDay(day);
          setHead((h) => ({ ...h, at: raw[raw.length - 1].day.slice(0, 16) }));
        }
      });
    }, 60000); // 每分钟补线

    // 只更新今日 K 柱收/高/低 + 分时最后一点; 今日尚未由 1min 轮询建立则跳过
    const stopSnap = poll(() => {
      jsonp(SNAP_URL, () => {
        const f = (window.v_sz159696 || "").split("~");
        if (f.length < 35) return;
        const day = `${f[30].slice(0, 4)}-${f[30].slice(4, 6)}-${f[30].slice(6, 8)}`;
        const k = D.kline, r = k[k.length - 1];
        if (!r || r[0] !== day) return; // 等 1min 轮询先建今日柱
        const price = +(+f[3]).toFixed(3);
        r[2] = price; r[4] = +(+f[33]).toFixed(3); r[3] = +(+f[34]).toFixed(3); // 收/高/低 权威
        const d = D.intraday[day];
        if (d?.c.length) d.c[d.c.length - 1] = price;
        buildKline();
        if (!pinned.current) {
          showDay(day);
          setHead((h) => ({ ...h, at: `${day} ${f[30].slice(8, 10)}:${f[30].slice(10, 12)}:${f[30].slice(12, 14)}` }));
        }
      });
    }, 8000); // 逐笔快照, 每 8s 推当前价

    return () => { stopLive(); stopSnap(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="wrap">
      <div className="card">
        {head.chg != null && (
          <div className="hero">
            <span className="v" style={{ color: `var(--${head.chg >= 0 ? "up" : "down"})` }}>
              {fmtP(head.chg)}
            </span>
            <span className="u">更新于 {head.at}</span>
          </div>
        )}
        <h2>{head.title}</h2>
        <div ref={iBox} className="chart intraday" />
      </div>
      <div className="card">
        <h2>
          日K <span>· 点击K线看当日分时</span>
        </h2>
        <div ref={kBox} className="chart kline" />
      </div>
    </div>
  );
}
