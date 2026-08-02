// 纳指QDII 场内看板（原 etf.html）。两个 pane：
//   0 纳指 · QDII —— NQ 隔夜卡片(hero + 分时) + 12 只场内 QDII 溢价对照
//   1 159696 走势 —— 日K(点击看当日分时) + 分时
//
// 这一页几乎全是命令式的：三个数据源都没有 CORS 头，只能 <script> 注入，回调里直接改
// 模块级的 ETF_DATA / NQ_OVERNIGHT 再重画图。硬搬进 React state 得把每根 bar 都变成不可变
// 更新，8s 一轮的轮询下毫无收益 —— 图表本来就是 setOption 增量合并的。
import { useEffect, useRef, useState } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { jsonp, poll } from "../jsonp";
import { ETF_DATA as D } from "../data/etf_data";
import { NQ_OVERNIGHT as NQ } from "../data/nq_data";

const MOBILE = matchMedia("(max-width:680px)").matches;
const GL = MOBILE ? 46 : 56; // 图表左边距, 窄屏收紧
const COLORS = ["up", "down", "blue", "avg", "ink", "ink2", "muted", "grid", "baseline", "surface", "tip", "tiplabel"];

const fmtVol = (v) => (v >= 1e8 ? (v / 1e8).toFixed(2) + "亿" : (v / 1e4).toFixed(1) + "万");
const px = (v) => v.toFixed(3);
const pctOf = (a, b) => ((a / b - 1) * 100).toFixed(2) + "%";
const fmtP = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

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
  scale: true,
  axisLabel: { color: C.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: C.grid } },
  axisLine: { show: false },
  axisTick: { show: false },
});

// 十字线不越过最新数据: 悬停在右侧空槽区时锁回最后一个有值的点(同花顺分时交互)。
// 每次 mousemove 都要 dispatch —— ECharts 原生 axisPointer 也在跟鼠标, 少一次就跟丢。
function clampTip(ch, lastIdx) {
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

// ── NQ 隔夜: 固定框 上一A股收盘(15:00) -> 下一交易日 15:00 的逐分钟类目槽 ──────────
// 静态 path (nq_data.js, 上一收盘→缓存末) + 进行中时叠加实时 minLine tail(今06:00→now, 按 base 换算 pct)。
// NQ 闭市时段不占位(避免空白); 节假日按工作日近似(CI 收盘后校正)。
const NQ_YR = +(NQ?.updated || "").slice(0, 4) || new Date().getFullYear();
// CME 闭市(北京时间): 每日 05:00-06:00 维护; 周末 周六06:00 - 周一06:00。
function nqClosed(t) {
  const d = t.getDay(), h = t.getHours();
  if (h === 5) return true; // 每日维护窗口
  if (d === 6) return h >= 6; // 周六: 05:00 收周五盘后整周末闭市
  if (d === 0) return true; // 周日
  if (d === 1) return h < 6; // 周一 06:00 开盘前
  return false;
}
const nqLblDate = (lbl) => new Date(NQ_YR, +lbl.slice(0, 2) - 1, +lbl.slice(3, 5), 15, 0);
function nqFrame(startLbl) {
  const s = nqLblDate(startLbl);
  const e = new Date(s);
  do { e.setDate(e.getDate() + 1); } while (e.getDay() % 6 === 0); // 下一工作日
  e.setHours(15, 0, 0, 0);
  const out = [], p2 = (n) => String(n).padStart(2, "0");
  for (let t = new Date(s); t <= e; t.setMinutes(t.getMinutes() + 1)) {
    if (nqClosed(t)) continue; // 闭市不占位
    out.push(`${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`);
  }
  return out;
}
// bar 字段: 首行比常规行多4个前缀, 统一从尾部取 [-1]=时间戳 "YYYY-MM-DD HH:MM:SS" [-5]=价
const nqTs = (b) => b[b.length - 1];
const nqPx = (b) => +b[b.length - 5];

// A股 15:00 一过就换隔夜窗口: 拿实时 bar 里的当日 15:00 价当新基准, 不等 CI(18:00)。
// 同 nq_overnight.py 的 crossed 逻辑; 节假日按工作日近似, CI 收盘后校正。
function nqRebase(item, live) {
  const s0 = nqLblDate(item.path[0][0]); // 当前窗口起点
  let hit = null;
  for (const b of live) {
    const ts = nqTs(b);
    if (ts.slice(11) !== "15:00:00") continue;
    const d = new Date(ts.replace(/-/g, "/")); // Safari 不认 "YYYY-MM-DD HH:MM:SS"
    if (d > s0 && d.getDay() % 6 !== 0) hit = b;
  }
  if (!hit || nqTs(live[live.length - 1]) <= nqTs(hit)) return; // 起点之后还得有 bar
  const ts = nqTs(hit);
  item.base = nqPx(hit);
  item.pct = 0;
  item.partial = true; // 新窗口必然进行中, 交给下游按最新 bar 重算
  item.d = ts.slice(0, 10);
  item.t = ts.slice(0, 16);
  item.path = [[ts.slice(5, 16), 0]];
}

// ── 纳指100 场内 QDII 溢价对照 ────────────────────────────────────────────
// 腾讯 qt 批量快照(逗号拼代码), <script> 注入绕 CORS。
// 响应是 GBK, 但只取数字字段(分隔符 ~ 是 ASCII), 名称走本地表, 免解码。
// 名单 = smartbox 搜「纳斯达克/纳指」里的 QDII-ETF, 剔除 513290(生物科技)、
// 159509(纳指科技 NDXT) —— 这两只跟踪的不是纳指100。只要 ETF, 不含场内 LOF。
// 字段: [3]现价 [30]时间戳 [32]涨跌幅% [37]成交额(万) [77]溢价率%
const QDII = [
  ["sz159941", "广发"], ["sh513100", "国泰"], ["sh513300", "华夏"], ["sz159632", "华安"],
  ["sz159659", "招商"], ["sh513110", "华泰柏瑞"], ["sh513390", "博时"], ["sz159513", "大成"],
  ["sz159660", "汇添富"], ["sz159501", "嘉实"], ["sh513870", "富国"], ["sz159696", "易方达"],
];
const qAmt = (w) => (w >= 1e4 ? (w / 1e4).toFixed(2) + "亿" : Math.round(w) + "万");
const QCOLS = [
  ["px", "现价"], ["chg", "涨跌幅"], ["prem", "溢价率"], ["amt", "成交额"],
  ["w", "本周"], ["m", "本月"], ["y", "今年以来"],
];

function QdiiCard() {
  const [rows, setRows] = useState([]);
  const [ts, setTs] = useState("");
  const [sort, setSort] = useState({ k: "chg", asc: false }); // 默认涨跌幅降序
  const [base, setBase] = useState({}); // code -> {w,m,y} 上周末/上月末/上年末收盘

  // 本周/本月/今年以来的基准收盘: 腾讯 fqkline 日线, _var= 让它吐 JS 赋值(裸 JSON 会被 CORS 拦)。
  // 基准盘中不变, 只在开页拉一次, 涨跌幅由 8s 快照的现价现算。
  // 用前复权序列: 今日现价就是复权基点, 区间内除权分红也不会把涨跌幅算歪。
  // (校验: 这样算出的今年以来 与腾讯快照 [62] 字段 12/12 完全一致)
  useEffect(() => {
    const now = new Date(), p2 = (n) => String(n).padStart(2, "0");
    const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // 本周一
    const bnd = {
      w: ymd(mon),
      m: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      y: now.getFullYear() + "-01-01",
    };
    const nb = Math.ceil(((now - new Date(now.getFullYear(), 0, 1)) / 864e5 / 7) * 5) + 12; // 够回到上年末的根数
    const kill = QDII.map(([sym]) => {
      const v = "k_" + sym;
      return jsonp(
        `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=${v}&param=${sym},day,,,${nb},qfq`,
        () => {
          const d = window[v].data[sym], bars = d.qfqday || d.day;
          const at = (b) => { let c; for (const r of bars) { if (r[0] >= b) break; c = +r[2]; } return c; };
          // 12 只各自异步回来, 函数式更新才不会互相覆盖
          setBase((b) => ({ ...b, [sym.slice(2)]: { w: at(bnd.w), m: at(bnd.m), y: at(bnd.y) } }));
        },
      );
    });
    return () => kill.forEach((f) => f());
  }, []);

  useEffect(
    () =>
      poll(() => {
        jsonp("https://qt.gtimg.cn/q=" + QDII.map((x) => x[0]).join(","), () => {
          const out = [];
          let stamp = "";
          for (const [sym, name] of QDII) {
            const f = (window["v_" + sym] || "").split("~");
            const p = +f[3];
            if (f.length < 80 || !p) continue; // 单只停牌/接口缺失: 跳过, 不拖垮整表
            out.push({ code: sym.slice(2), name, px: p, chg: +f[32], prem: +f[77], amt: +f[37] });
            stamp = f[30];
          }
          if (!out.length) return; // 全失败: 保留上一轮, 别闪成空表
          setRows(out);
          setTs(stamp);
        });
      }, 8000), // 同 snapTick 节奏
    [],
  );

  // 区间涨跌幅在这里算: 基准是异步到的, 现价每 8s 变。缺基准 -> NaN -> 渲染成 —
  const full = rows.map((r) => {
    const b = base[r.code] || {};
    return { ...r, w: (r.px / b.w - 1) * 100, m: (r.px / b.m - 1) * 100, y: (r.px / b.y - 1) * 100 };
  });
  // 基准未到 = NaN, 排最后, 别让比较返回 NaN 把顺序搅乱
  const num = (v) => (Number.isFinite(v) ? v : -Infinity);
  full.sort((a, b) => (num(a[sort.k]) - num(b[sort.k])) * (sort.asc ? 1 : -1));

  const cell = (v) =>
    Number.isFinite(v) ? <td className={v >= 0 ? "pos" : "neg"}>{fmtP(v)}</td> : <td>—</td>;

  return (
    <div className="card">
      <h2>
        纳指100 场内QDII
        <span>
          {ts &&
            ` · 共 ${rows.length} 只 · 更新于 ${ts.slice(4, 6)}-${ts.slice(6, 8)} ` +
              `${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`}
        </span>
      </h2>
      <div className="tWrap">
        <table className="dt">
          <thead>
            <tr>
              <th>基金</th>
              {QCOLS.map(([k, label]) => (
                <th
                  key={k}
                  data-k={k}
                  onClick={() =>
                    setSort((s) => (s.k === k ? { k, asc: !s.asc } : { k, asc: false }))
                  }
                >
                  {label}
                  {sort.k === k ? (sort.asc ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {full.length === 0 ? (
              <tr>
                <td colSpan={8} className="nm">加载中…</td>
              </tr>
            ) : (
              full.map((r) => (
                <tr key={r.code} className={r.code === "159696" ? "hl" : ""}>
                  <td className="nm">
                    {r.name}
                    <span className="cd">{r.code}</span>
                  </td>
                  <td>{r.px.toFixed(3)}</td>
                  {cell(r.chg)}
                  {cell(r.prem)}
                  <td>{qAmt(r.amt)}</td>
                  {cell(r.w)}
                  {cell(r.m)}
                  {cell(r.y)}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 拉 minLine_1d: 画当前盘分时(始终), 并在「进行中」时重算隔夜半程点 pct。
// <script> 注入绕 CORS(该接口无 CORS 头但可当 JSONP 加载, 顶层 var t 落全局 window.t)。
const NQ_URL =
  "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=NQ";

function NqCard({ theme }) {
  const box = useRef(null);
  const chart = useRef(null);
  // item 是 nq_data.js 里那条记录本身: nqRebase 原地改它的字段, 引用恒定, 不需要 ref/state
  const item = NQ?.items?.[NQ.items.length - 1];
  const [hero, setHero] = useState(() =>
    item ? { pct: item.pct, at: item.partial ? item.t : item.d } : null,
  );
  const [spin, setSpin] = useState(false);

  // 静态 path + 进行中的实时 tail 一起铺进固定框
  const render = (live) => {
    const it = item;
    if (!chart.current || !it?.path?.length) return;
    const m = new Map();
    for (const [l, v] of it.path) m.set(l, v);
    if (it.partial && live?.length)
      for (const b of live) m.set(nqTs(b).slice(5, 16), +((nqPx(b) / it.base - 1) * 100).toFixed(2) + 0);
    const t = nqFrame(it.path[0][0]);
    const c = t.map((l) => (m.has(l) ? m.get(l) : null)); // 空槽 null(右侧留空)
    // 同 ETF 分时: 围绕基准(0=上一A股收盘)对称定界, 3等分
    const dev = Math.max(...c.filter((v) => v != null).map(Math.abs)) || 1;
    const C = vars(...COLORS);
    chart.current.setOption(
      {
        yAxis: { min: -dev, max: dev, interval: dev / 3 },
        tooltip: {
          ...tip(C),
          formatter: (ps) => {
            const j = ps[0].dataIndex;
            return c[j] == null ? t[j] : `${t[j]}<br>涨跌 <b>${fmtP(c[j])}</b>`;
          },
        },
        xAxis: {
          data: t,
          // 首尾(上一收盘15:00 / 次收盘15:00)恒显; 中间窄屏每6小时标
          // (3小时在移动端会挤, 且闭市段被剔后 03:00/06:00 更近)
          axisLabel: {
            color: C.muted,
            fontSize: 11,
            formatter: (v) => v.slice(-5), // 只显 HH:MM
            interval: (i, v) =>
              i === 0 || i === t.length - 1 ||
              (/:00$/.test(v) && +v.slice(-5, -3) % (MOBILE ? 6 : 3) === 0),
          },
        },
        series: [{ data: c }],
      },
      { replaceMerge: [] },
    );
    clampTip(chart.current, c.findLastIndex((v) => v != null));
  };

  useEffect(() => {
    if (!item) return;
    const C = vars(...COLORS);
    const m = echarts.init(box.current, null, { renderer: "canvas" });
    m.setOption({
      grid: { left: GL, right: MOBILE ? 24 : 20, top: 20, bottom: 28 }, // right 留够末尾 15:00 标签半宽
      tooltip: tip(C),
      xAxis: {
        type: "category",
        boundaryGap: false,
        axisLine: { lineStyle: { color: C.baseline } },
        axisTick: { show: false },
      },
      yAxis: {
        ...yBase(C),
        axisLabel: {
          color: C.muted,
          fontSize: 11,
          formatter: (v) => { if (Math.abs(v) < 0.005) v = 0; return fmtP(v); },
        },
        axisPointer: { label: { formatter: (o) => fmtP(o.value) } },
      },
      series: [
        {
          name: "涨跌",
          type: "line",
          showSymbol: false,
          connectNulls: false,
          lineStyle: { width: 2, color: C.blue },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(57,135,229,.25)" },
              { offset: 1, color: "rgba(57,135,229,0)" },
            ]),
          },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: C.muted, type: "dashed", width: 1.5, opacity: 0.9 },
            data: [{ yAxis: 0 }],
            label: { show: false },
          },
        },
      ],
    });
    chart.current = m;
    render(window.t?.minLine_1d); // 先用手里的数据画一遍, 下一轮轮询再精修
    const onResize = () => m.resize();
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      m.dispose();
      chart.current = null;
    };
    // render 每次渲染都是新函数, 放进依赖会无限重建; 换肤才需要重建图表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  const refresh = (cb) =>
    jsonp(NQ_URL, () => {
      const r = window.t.minLine_1d;
      nqRebase(item, r); // 过了 15:00 先换窗口, 再画
      render(r);
      if (item.partial) {
        const b = r[r.length - 1]; // 半程点: base 固定, 只重算实时价
        item.pct = +((nqPx(b) / item.base - 1) * 100).toFixed(2) + 0;
        item.t = nqTs(b).slice(0, 16); // "2026-07-20 11:35:00" -> "2026-07-20 11:35"
      }
      setHero({ pct: item.pct, at: item.partial ? item.t : item.d });
      cb?.();
    });

  useEffect(() => {
    if (!item) return;
    // 数据源延迟约 1 分钟, 8s 只是更快显现新 bar; 同 ETF 逐笔快照节奏
    return poll(() => refresh(), 8000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!item || !hero) return null;
  return (
    <div className="card nq">
      <h2>
        <span className="t">
          纳指期货 · 隔夜涨跌
          {/* 手动刷新: 自动轮询之外的即时重取(spin 只跟手动点, 免得每 8s 自转) */}
          <button
            className={"nqReload" + (spin ? " spin" : "")}
            title="刷新"
            aria-label="刷新"
            disabled={spin}
            onClick={() => {
              setSpin(true);
              refresh(() => setTimeout(() => setSpin(false), 400)); // 凑够一圈动画, 免得秒回时闪一下
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </span>
      </h2>
      <div className="hero">
        <span className={"v " + (hero.pct >= 0 ? "pos" : "neg")}>{fmtP(hero.pct)}</span>
        <span className="u">更新于 {hero.at}</span>
      </div>
      <h2>分时</h2>
      <div ref={box} className="chart intraday" />
    </div>
  );
}

// 实时行情: 拉新浪今日 1min bar, 追加/更新今日日K + 分时。
// 同 NQ: <script> 注入绕 CORS, var e= 落 window.e (该接口无防盗链)。
const ETF_URL =
  "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20e=/CN_MarketDataService.getKLineData?symbol=sz159696&scale=1&ma=no&datalen=240";
// 逐笔快照: 腾讯 qt (无防盗链), 落全局 v_sz159696。1min bar 建线, 这里每几秒推当前价。
const SNAP_URL = "https://qt.gtimg.cn/q=sz159696";

function EtfPane({ theme }) {
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
      yAxis: yBase(C),
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
    // 最新K的分时: 标题"分时" + hero 行(大涨跌幅 + 更新于, 同纳指卡片); 历史K: 标题带日期, 隐藏 hero
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
        { ...yBase(C), axisPointer: { label: { formatter: (p) => p.value.toFixed(3) } } },
        { type: "value", position: "right", splitLine: { show: false }, axisPointer: { show: false },
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: {
            fontSize: 11,
            formatter: (v) => { if (Math.abs(v) < 0.005) v = 0; return (v > 0 ? "+" : "") + v.toFixed(2) + "%"; },
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
    <>
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
    </>
  );
}

export default function EtfPage() {
  const { theme } = useTheme();
  const [tab, setTab] = useState(0);

  // 图表在隐藏容器里 init 时量到 0 宽, 切出来必须 resize 一次才画得对。
  // 各图表自己挂了 window resize 监听, 这里发一次事件就够, 不用把实例往上提。
  useEffect(() => { dispatchEvent(new Event("resize")); }, [tab]);

  return (
    <div className="wrap">
      <header>
        <h1>纳指QDII · 场内看板</h1>
      </header>

      <nav className="tabs">
        {["纳指 · QDII", "159696 走势"].map((label, i) => (
          <button key={label} className={i === tab ? "on" : ""} onClick={() => setTab(i)}>
            {label}
          </button>
        ))}
      </nav>

      {/* 两个 pane 都保持挂载: 图表在隐藏容器里 init 会量到 0 宽, 用 hidden 而不是卸载,
          切回来时 ECharts 自己按容器尺寸重画(下面的 resize 由各 pane 的监听器负责) */}
      <div hidden={tab !== 0}>
        <NqCard theme={theme} />
        <QdiiCard />
      </div>
      <div hidden={tab !== 1}>
        <EtfPane theme={theme} />
      </div>
    </div>
  );
}
