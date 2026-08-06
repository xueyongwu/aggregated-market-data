// 纳指 · QDII：纳指期货隔夜卡片（hero + 分时）+ 12 只场内 QDII 溢价对照。
//
// 这一页几乎全是命令式的：两个数据源都没有 CORS 头，只能 <script> 注入，回调里直接改
// 模块级的 NQ_OVERNIGHT 再重画图。硬搬进 React state 得把每根 bar 都变成不可变更新，
// 8s 一轮的轮询下毫无收益 —— 图表本来就是 setOption 增量合并的。
import { useEffect, useRef, useState } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { aOpen, jsonp, poll } from "../jsonp";
import { COLORS, MOBILE, clampTip, fmtP, tip, yPrice } from "../chartBase";
import { Pct, fmt, useSort } from "../table";
import { NQ_OVERNIGHT as NQ } from "../data/nq_data";

const GL = MOBILE ? 46 : 56; // 图表左边距, 窄屏收紧

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
  const seen = useRef(""); // 上轮末根 bar 的原样, 用来跳过没变化的那几轮重绘

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
    // 围绕基准(0=上一A股收盘)对称定界, 3等分
    const dev = Math.max(...c.filter((v) => v != null).map(Math.abs)) || 1;
    const noon = t.find((l) => l.endsWith("11:30")); // A股上午收盘, 窗口内只有一个
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
              i === 0 || i === t.length - 1 || v === noon ||
              (/:00$/.test(v) && !v.endsWith("12:00") && // 12:00 离 11:30 太近, 让位
                +v.slice(-5, -3) % (MOBILE ? 6 : 3) === 0),
          },
        },
        series: [
          {
            data: c,
            markLine: { data: [{ yAxis: 0 }, ...(noon ? [{ xAxis: noon }] : [])] },
          },
        ],
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
        ...yPrice(C),
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
      // 接口没有增量, 每轮都是全量 1300+ 根 —— 省不掉流量, 但末根没动就没什么可画的:
      // 新点 60s 才来一个, 而 render 是 1300 点的整幅 setOption。数组直接转串比字段,
      // 时间戳和价一起认(盘中修订也算变)。只看末根: 上游改中段 bar 没见过, 也无所谓。
      const tail = String(r[r.length - 1]);
      if (tail !== seen.current) {
        seen.current = tail;
        nqRebase(item, r); // 过了 15:00 先换窗口, 再画
        render(r);
        if (item.partial) {
          const b = r[r.length - 1]; // 半程点: base 固定, 只重算实时价
          item.pct = +((nqPx(b) / item.base - 1) * 100).toFixed(2) + 0;
          item.t = nqTs(b).slice(0, 16); // "2026-07-20 11:35:00" -> "2026-07-20 11:35"
        }
        setHero({ pct: item.pct, at: item.partial ? item.t : item.d });
      }
      cb?.(); // 手动刷新的转圈不看有没有变化, 照样收尾
    });

  useEffect(() => {
    if (!item) return;
    // 30s: MinLine 只有 1min bar 且延迟约 1 分钟, 新点 60s 一个; 每次还是全量回 1300+ 根
    // (68KB 裸 / 14KB gzip, 无增量接口)。实测末根 bar 的盘中修订约 0.4 点 = 0.0013%,
    // 低于 hero 两位小数的分辨率, 再快也不会改变屏幕上的数字 —— 别照抄下面溢价快照那条
    // 3s(那是 Level-1 逐笔、6KB、上游 3s 一切片, 不可比)。
    // 闭市(CME 每日 5:00-6:00 维护 + 周末)不轮询, 页面挂着过夜/过周末不空转 —— 但开页
    // 必取一次: 静态 path 只到上次 CI, 闭市时那一次补的正是收盘前的尾巴。
    // 手动刷新按钮不受门禁管。nqClosed 按设备本地时间判, 同本页其余时间逻辑。
    let first = true;
    return poll(() => {
      if (first || !nqClosed(new Date())) refresh();
      first = false;
    }, 30000);
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

// ── 纳指100 场内 QDII 溢价对照 ────────────────────────────────────────────
// 腾讯 qt 批量快照(逗号拼代码), <script> 注入绕 CORS。
// 响应是 GBK, 但只取数字字段(分隔符 ~ 是 ASCII), 名称走本地表, 免解码。
// 名单 = smartbox 搜「纳斯达克/纳指」里的 QDII-ETF, 剔除 513290(生物科技)、
// 159509(纳指科技 NDXT) —— 这两只跟踪的不是纳指100。只要 ETF, 不含场内 LOF。
// 字段: [3]现价 [30]时间戳 [32]涨跌幅% [37]成交额(万) [44]流通市值(亿) [77]溢价率%
const QDII = [
  ["sz159941", "广发"], ["sh513100", "国泰"], ["sh513300", "华夏"], ["sz159632", "华安"],
  ["sz159659", "招商"], ["sh513110", "华泰柏瑞"], ["sh513390", "博时"], ["sz159513", "大成"],
  ["sz159660", "汇添富"], ["sz159501", "嘉实"], ["sh513870", "富国"], ["sz159696", "易方达"],
];
const qAmt = (w) => (w >= 1e4 ? (w / 1e4).toFixed(2) + "亿" : Math.round(w) + "万");
// 场内时段门禁 aOpen 在 jsonp.js。本页 NQ 那半边是按类目轴标签走本地时间, 两套不通用。
const QCOLS = [
  ["px", "现价"], ["chg", "涨跌幅"], ["prem", "溢价率"], ["amt", "成交额"], ["size", "规模"],
  ["w", "本周"], ["m", "本月"], ["y", "今年以来"],
];

function QdiiCard() {
  const [rows, setRows] = useState([]);
  const [ts, setTs] = useState("");
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

  // 开页必取一次(整张表全靠快照, 没有静态兜底), 之后闭市不轮询。
  // 节假日不判: 快照回上一交易日收盘, 值不变, 空转一天可接受。
  // 3s = 沪深 Level-1 快照切片的间隔, 上游本身就这个节奏, 再快只会拿回同一个 [30] 时间戳。
  // 代价 6.1KB/次 × 21000s 窗口 ≈ 7000 请求/天/标签页; 真被限流就调回 8000(只是现价/涨跌幅
  // 跳得慢些, 溢价率那列的 IOPV 本来就跟不上这个分辨率)。
  useEffect(() => {
    let first = true;
    return poll(() => {
      if (!first && !aOpen()) return;
      first = false;
      jsonp("https://qt.gtimg.cn/q=" + QDII.map((x) => x[0]).join(","), () => {
        const out = [];
        let stamp = "";
        for (const [sym, name] of QDII) {
          const f = (window["v_" + sym] || "").split("~");
          const p = +f[3];
          if (f.length < 80 || !p) continue; // 单只停牌/接口缺失: 跳过, 不拖垮整表
          // size = 流通市值 = 场内份额 × 现价。ETF 全流通, 即基金规模; 份额是上一交易日
          // 确认份额(腾讯不盘中更新申赎), 且按现价不按净值 —— 高溢价时含溢价那部分, 不扣。
          // 新上市当天可能为空 -> NaN -> 渲染成 —(useSort 里缺值恒排最后)。
          out.push({ code: sym.slice(2), name, px: p, chg: +f[32], prem: +f[77], amt: +f[37], size: +f[44] || NaN });
          stamp = f[30];
        }
        if (!out.length) return; // 全失败: 保留上一轮, 别闪成空表
        setRows(out);
        setTs(stamp);
      });
    }, 3000);
  }, []);

  // 区间涨跌幅在这里算: 基准是异步到的, 现价每 3s 变。缺基准 -> NaN -> 渲染成 —
  const full = rows.map((r) => {
    const b = base[r.code] || {};
    return { ...r, w: (r.px / b.w - 1) * 100, m: (r.px / b.m - 1) * 100, y: (r.px / b.y - 1) * 100 };
  });
  const { sorted, th } = useSort(full, "chg"); // 默认涨跌幅降序

  // 平均 / 极差(max − min)，只对百分比列(现价/成交额/规模各只之间没有可比性)。
  // 缺值(基准还没异步到 / 单只停牌)不计入。单位严格说是「个百分点」, 但表里其余都写 %,
  // 跟着写 %; 极差恒为正, 也就不套 Pct 的红绿(平均值可能为负, 带符号即可)。
  const nums = (k) => full.map((r) => r[k]).filter(Number.isFinite);
  const avg = (k) => {
    const v = nums(k);
    return v.length ? fmt(v.reduce((a, x) => a + x, 0) / v.length) : "—";
  };
  const spread = (k) => {
    const v = nums(k);
    return v.length < 2 ? "—" : (Math.max(...v) - Math.min(...v)).toFixed(2) + "%";
  };
  const med = (k) => {
    const v = nums(k).sort((a, b) => a - b);
    if (!v.length) return "—";
    const h = v.length >> 1;
    return fmt(v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2);
  };
  const skip = (k) => ["px", "amt", "size"].includes(k);

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
              {QCOLS.map(([k, label]) => th(k, label))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={9} className="nm">加载中…</td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.code} className={r.code === "159696" ? "hl" : ""}>
                  <td className="nm">
                    {r.name}
                    <span className="cd">{r.code}</span>
                  </td>
                  <td>{r.px.toFixed(3)}</td>
                  <Pct v={r.chg} />
                  <Pct v={r.prem} />
                  <td>{qAmt(r.amt)}</td>
                  <td>{Number.isFinite(r.size) ? r.size.toFixed(2) + "亿" : "—"}</td>
                  <Pct v={r.w} />
                  <Pct v={r.m} />
                  <Pct v={r.y} />
                </tr>
              ))
            )}
          </tbody>
          {/* 平均 / 极差放 tfoot: 不参与排序 */}
          {sorted.length > 0 && (
            <tfoot>
              <tr>
                <td className="nm">极差</td>
                {QCOLS.map(([k]) => (
                  <td key={k}>{skip(k) ? "" : spread(k)}</td>
                ))}
              </tr>
              <tr>
                <td className="nm">平均</td>
                {QCOLS.map(([k]) => (
                  <td key={k}>{skip(k) ? "" : avg(k)}</td>
                ))}
              </tr>
              <tr>
                <td className="nm">中位数</td>
                {QCOLS.map(([k]) => (
                  <td key={k}>{skip(k) ? "" : med(k)}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

export default function QdiiPage() {
  const { theme } = useTheme();
  return (
    <div className="wrap">
      <NqCard theme={theme} />
      <QdiiCard />
    </div>
  );
}
