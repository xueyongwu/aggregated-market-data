// 纳指 · QDII：纳指期货隔夜卡片（hero + 分时）+ 12 只场内 QDII 溢价对照（末尾两行是
// QQQ/QQQM 两只美股 ETF 作对照）。
//
// 这一页几乎全是命令式的：两个数据源都没有 CORS 头，只能 <script> 注入，回调里直接改
// 模块级的 NQ_OVERNIGHT 再重画图。硬搬进 React state 得把每根 bar 都变成不可变更新，
// 8s 一轮的轮询下毫无收益 —— 图表本来就是 setOption 增量合并的。
import { useEffect, useRef, useState } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { aOpen, jsonp, poll, usOpen } from "../jsonp";
import { COLORS, MOBILE, clampTip, fmtP, tip, yPrice } from "../chartBase";
import { Pct, useSort } from "../table";
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
// 第三项 fee = 年化综合费率 = 管理费 + 托管费（东财 FundMNRateInfo 的 MGREXP + TRUSTEXP，
// 2026-08-12 核对）。写死不抓：费率只在基金公司公告降费时变（年级别），为一列静态数字
// 挂个源不值 —— 而且该接口回裸 JSON，本页绕 CORS 的 <script> 注入用不上它。
// ponytail: 手工维护，哪只降费了改这里；真变成月级事件再考虑进抓取管道。
//
// USETF 是美股 ETF(QQQ/QQQM), 第四项 us 标记 —— 做对照用, 同一个指数看「不隔 QDII 这层
// 要多少钱、拿到多少收益」。**两张表从名单到轮询都是分开的**:
//   · 计价币种不同 —— QDII 是 CNY、这两只是 USD, 现价/成交额并排就是在骗人, 收益列的差额
//     里也含 USD/CNY 变动(同 IndexPage 里恒指与 A股指数同图的口径妥协);
//   · 溢价率和规模这两列美股压根没有(见下), 摆一起就是两整列 —— ;
//   · 极差是「12 只 QDII 之间的离散度」, 混进美元行会虚高;
//   · 交易时段不重叠 —— 各自只在自己开市时轮询(见 useSnap), 合成一个请求就得按并集刷,
//     一半的请求都在拿另一边的收盘价。
// 腾讯美股那套与 A股差三处: 快照代码是 usQQQ(带 .OQ 会 none_match), 日线代码反过来要
// usQQQ.OQ 且走 usfqkline 端点; 快照只有 71 个字段, 没有 [77]溢价率(美股没有申赎受限那
// 回事)、[44]流通市值 是空串; [37]成交额 单位是美元「元」而不是 A股的「万元」, 解析时先
// 除 1e4 对齐。费率是官方费率(QQQ 0.20% / QQQM 0.15%, 同样手工维护)。
const QDII = [
  ["sz159941", "广发", 1.0], ["sh513100", "国泰", 0.8], ["sh513300", "华夏", 0.8], ["sz159632", "华安", 0.8],
  ["sz159659", "招商", 0.65], ["sh513110", "华泰柏瑞", 1.0], ["sh513390", "博时", 0.65], ["sz159513", "大成", 1.0],
  ["sz159660", "汇添富", 0.65], ["sz159501", "嘉实", 0.6], ["sh513870", "富国", 0.6], ["sz159696", "易方达", 0.6],
];
const USETF = [["usQQQ", "QQQ", 0.2, 1], ["usQQQM", "QQQM", 0.15, 1]];
const qAmt = (w) => (w >= 1e4 ? (w / 1e4).toFixed(2) + "亿" : Math.round(w) + "万");

// 腾讯美股快照的 [30] 是纽约时间的字面量("2026-08-12 11:03:00"), 换成北京时间的 "MM-DD HH:MM:SS"。
// 差 12 小时(夏令时)/13(冬令时), 但不自己写 DST 规则: 先把字面量当 UTC 读一遍, 再问 Intl
// 「这个瞬间在纽约是几点」, 差出来的就是那天纽约的真实偏移, 减掉即真实瞬间, 最后按上海格式化。
// sv-SE 出的就是 "YYYY-MM-DD HH:MM:SS"(不用自己拼)。带 T 和 Z 解析, Safari 也认。
// 校验过 5 个点: 夏令时 11:03->23:03、16:00 收盘->次日 04:00; 冬令时 09:30->22:30、
// 16:00->次日 05:00; 11-06(已切冬令时)16:00->11-07 05:00。
const nyToBj = (s) => {
  const naive = new Date(s.replace(" ", "T") + "Z");
  const off = new Date(naive.toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T") + "Z") - naive;
  return new Date(+naive - off).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(5);
};
// 两个时段门禁 aOpen(A股) / usOpen(美股) 都在 jsonp.js。本页 NQ 那半边是按类目轴标签走本地
// 时间, 与这两个不通用。
const QCOLS = [
  ["px", "现价"], ["chg", "涨跌幅"], ["prem", "溢价率"], ["amt", "成交额"],
  ["w", "本周"], ["m", "本月"], ["y", "今年以来"], ["y1", "近1年"], ["y2", "近2年"],
  ["size", "规模"], ["fee", "费率"],
];
// 美股表: 少了溢价率/规模(腾讯美股快照没这两个字段), 多了近3年/近5年(日线根数上限比 A股
// 高一倍多, 够精确取到 5 年前, 见 useBase)。两表差了四列, 不再从 QCOLS 减着算。
const UCOLS = [
  ["px", "现价"], ["chg", "涨跌幅"], ["amt", "成交额"],
  ["w", "本周"], ["m", "本月"], ["y", "今年以来"], ["y1", "近1年"], ["y2", "近2年"],
  ["y3", "近3年"], ["y5", "近5年"], ["fee", "费率"],
];
// 各表要哪几档「往前 N 年」, 一处定: 既是 useBase 要取的基准, 也对应上面的列。
// A股只到近2年 —— 腾讯 A股日线一次最多 641 根(约 2.6 年), 再往前只有周线, 基准会落到
// 「起点前最后一个周五」, 与精确日期差 ≤1 周; 宁可不出这两列, 不混两种口径。
const CN_YEARS = [1, 2], US_YEARS = [1, 2, 3, 5];
// 日线根数: A股 560 根 ≈ 2 年零 3 个月(一年约 243 个交易日); 美股 1300 根 ≈ 5.2 年
// (一年约 252 个交易日, 实测首根落在 5 年前再往前 44 个交易日, 1400 就回 limit error)。
const CN_BARS = 560, US_BARS = 1300;

// 把刚落到 window 上的一批 v_xxx 快照串解析成行。两个市场共用: 字段位置 [3]/[32] 一样,
// 差在字段总数、成交额单位、以及美股没有溢价率/流通市值(见上)。
function parseSnap(list) {
  const out = [];
  let stamp = "";
  for (const [sym, name, fee, us] of list) {
    const f = (window["v_" + sym] || "").split("~");
    const p = +f[3];
    if (f.length < (us ? 60 : 80) || !p) continue; // 单只停牌/接口缺失: 跳过, 不拖垮整表
    // size = 流通市值 = 场内份额 × 现价。ETF 全流通, 即基金规模; 份额是上一交易日
    // 确认份额(腾讯不盘中更新申赎), 且按现价不按净值 —— 高溢价时含溢价那部分, 不扣。
    // 新上市当天可能为空 -> NaN -> 渲染成 —(useSort 里缺值恒排最后)。
    // 美股行: prem/size 两个字段本就不存在 -> NaN -> —; amt 从美元「元」折成「万」对齐。
    out.push({
      code: sym.slice(2), name, fee, us, px: p, chg: +f[32],
      prem: +f[77], amt: us ? +f[37] / 1e4 : +f[37], size: +f[44] || NaN,
    });
    stamp = f[30]; // A股是紧凑串 20260812161442, 美股是纽约时间 "2026-08-12 11:01:41"
  }
  return { out, stamp };
}

/** 一张表的实时快照: 名单里的标的一个请求全拿, 只在 open() 为真的时段轮询。
 *
 * 开页必取一次(整张表全靠快照, 没有静态兜底), 之后闭市就停 —— 页面挂着过夜不空转。
 * 节假日不判: 快照回上一交易日收盘, 值不变, 空转一天可接受。
 * list/open/ms 都是模块常量, 进依赖数组只是让 lint 满意, effect 仍然只跑一次。 */
function useSnap(list, open, ms) {
  const [rows, setRows] = useState([]);
  const [ts, setTs] = useState("");
  useEffect(() => {
    let first = true;
    return poll(() => {
      if (!first && !open()) return;
      first = false;
      jsonp("https://qt.gtimg.cn/q=" + list.map((x) => x[0]).join(","), () => {
        const { out, stamp } = parseSnap(list);
        if (!out.length) return; // 全失败: 保留上一轮, 别闪成空表
        setRows(out);
        setTs(stamp);
      });
    }, ms);
  }, [list, open, ms]);
  return { rows, ts };
}

/** 各区间的基准收盘: code -> {w,m,y,y1,y2}。腾讯 fqkline 日线, _var= 让它吐 JS 赋值
 * (裸 JSON 会被 CORS 拦)。基准盘中不变, 只在开页拉一次, 涨跌幅由快照的现价现算。
 *
 * 用前复权序列: 今日现价就是复权基点, 区间内除权分红也不会把涨跌幅算歪。
 * (校验: 这样算出的今年以来 与腾讯快照 [62] 字段 12/12 完全一致)
 *
 * bars/years 见上方常量: 两个市场的日线根数上限不一样(A股 641 / 美股 1300), 能精确回溯的
 * 最远档位也就不一样。全部按精确日期取基准, 没有周线那种 ≤1 周的漂移。
 * 各档都是价格涨跌(不是净值): 与其余列同口径, 也是场内买卖真吃到的收益 —— 与东财的
 * 净值收益差的那几个点就是溢价率变动本身(实测 159941 近1年 +30% vs 净值 +18.5%)。 */
function useBase(list, bars, years) {
  const [base, setBase] = useState({});
  useEffect(() => {
    const now = new Date(), p2 = (n) => String(n).padStart(2, "0");
    const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const back = (n) => ymd(new Date(now.getFullYear() - n, now.getMonth(), now.getDate()));
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // 本周一
    const bnd = {
      w: ymd(mon),
      m: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      y: now.getFullYear() + "-01-01",
      ...Object.fromEntries(years.map((n) => ["y" + n, back(n)])),
    };
    const kill = list.map(([sym, , , us]) => {
      const v = "k_" + sym;
      const ep = us ? "usfqkline" : "fqkline", code = us ? sym + ".OQ" : sym; // 美股: 另一个端点, 代码带 .OQ
      return jsonp(
        `https://web.ifzq.gtimg.cn/appstock/app/${ep}/get?_var=${v}&param=${code},day,,,${bars},qfq`,
        () => {
          const d = window[v].data[code], bars = d.qfqday || d.day;
          // 起点之前最后一个收盘。上市晚于起点 -> undefined -> NaN -> 渲染成 —
          const at = (b) => { let c; for (const r of bars) { if (r[0] >= b) break; c = +r[2]; } return c; };
          // 每只各自异步回来, 函数式更新才不会互相覆盖
          setBase((s) => ({
            ...s,
            [sym.slice(2)]: Object.fromEntries(Object.entries(bnd).map(([k, day]) => [k, at(day)])),
          }));
        },
      );
    });
    return () => kill.forEach((f) => f());
  }, [list, bars, years]);
  return base;
}

// 区间涨跌幅在这里算: 基准是异步到的, 现价每轮快照都在变。有几档就算几档(哪几档由
// useBase 的 years 定)。基准还没回来 -> 该键根本不存在 -> Pct 渲染成 —, useSort 排最后。
const perf = (rows, base) =>
  rows.map((r) => ({
    ...r,
    ...Object.fromEntries(
      Object.entries(base[r.code] || {}).map(([k, v]) => [k, (r.px / v - 1) * 100]),
    ),
  }));

// 12 只场内 QDII。溢价率/规模/极差都只在这张。
// 3s = 沪深 Level-1 快照切片的间隔, 上游本身就这个节奏, 再快只会拿回同一个 [30] 时间戳。
// 代价 6.1KB/次 × 21000s 的 A股时段 ≈ 7000 请求/天/标签页; 真被限流就调到 8000(只是现价/
// 涨跌幅跳得慢些, 溢价率那列的 IOPV 本来就跟不上这个分辨率)。
function CnTable() {
  const { rows: snap, ts } = useSnap(QDII, aOpen, 3000);
  const rows = perf(snap, useBase(QDII, CN_BARS, CN_YEARS));
  const { sorted, th } = useSort(rows, "chg"); // 默认涨跌幅降序

  // 极差(max − min)，只对百分比列(现价/成交额/规模各只之间没有可比性)。
  // 缺值(基准还没异步到 / 单只停牌 / 上市晚于区间起点)不计入。单位严格说是「个百分点」,
  // 但表里其余都写 %, 跟着写 %; 极差恒为正, 也就不套 Pct 的红绿。
  const spread = (k) => {
    const v = rows.map((r) => r[k]).filter(Number.isFinite);
    return v.length < 2 ? "—" : (Math.max(...v) - Math.min(...v)).toFixed(2) + "%";
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
                <td colSpan={QCOLS.length + 1} className="nm">加载中…</td>
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
                  <Pct v={r.w} />
                  <Pct v={r.m} />
                  <Pct v={r.y} />
                  <Pct v={r.y1} />
                  <Pct v={r.y2} />
                  <td>{Number.isFinite(r.size) ? r.size.toFixed(2) + "亿" : "—"}</td>
                  {/* 成本不套 Pct 的红绿: 恒为正, 且「高」不是好事 */}
                  <td>{r.fee.toFixed(2) + "%"}</td>
                </tr>
              ))
            )}
          </tbody>
          {/* 极差放 tfoot: 不参与排序 */}
          {sorted.length > 0 && (
            <tfoot>
              <tr>
                <td className="nm">极差</td>
                {QCOLS.map(([k]) => (
                  <td key={k}>{skip(k) ? "" : spread(k)}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// QQQ/QQQM 美股ETF, 上表的参照。整张表都是美元, 所以不逐格加 $, 单位写在标题里。
// 与上表逐列对不上的地方: 涨跌幅是上一场美股(北京时间隔夜), 上表是当天 A股 —— 同一段行情,
// 但不是同一个时刻; 收益列的差额是「溢价率变动 + USD/CNY 变动 + 跟踪误差」三样混在一起。
// 时刻从接口给的纽约时间换成北京时间(nyToBj), 与站内其余时间同口径 —— 标出来是为了让美股
// 盘中的实时价和收盘后的隔夜价一眼能分开。
// 10s 而不是上表那个 3s: 腾讯美股快照实测 19 秒才换一次 [30](75 秒里量到 19/18/19/19,
// 夹着 ±1s 的抖动 —— 两台后端差一秒), 3s 会有五分之四的请求拿回同一份。取半个周期,
// 屏幕上的价最多陈旧 10 秒。响应也小得多(两只 623B, 上表 12 只 6.1KB)。
function UsTable() {
  const { rows: snap, ts } = useSnap(USETF, usOpen, 10000);
  const rows = perf(snap, useBase(USETF, US_BARS, US_YEARS));
  const { sorted, th } = useSort(rows, "chg");
  if (!rows.length) return null; // 拉不到就整块不出现, 不占一张空卡片

  return (
    <div className="card">
      <h2>
        纳指100 美股ETF
        <span>{` · 美元计价${ts ? ` · 更新于 ${nyToBj(ts)}` : ""}`}</span>
      </h2>
      <div className="tWrap">
        <table className="dt">
          <thead>
            <tr>
              <th>ETF</th>
              {UCOLS.map(([k, label]) => th(k, label))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.code}>
                {/* 不挂 cd 小字: 上表那里放的是基金代码, 这边代码就是名字本身 */}
                <td className="nm">{r.name}</td>
                <td>{r.px.toFixed(2)}</td>
                <Pct v={r.chg} />
                <td>{qAmt(r.amt)}</td>
                <Pct v={r.w} />
                <Pct v={r.m} />
                <Pct v={r.y} />
                <Pct v={r.y1} />
                <Pct v={r.y2} />
                <Pct v={r.y3} />
                <Pct v={r.y5} />
                <td>{r.fee.toFixed(2) + "%"}</td>
              </tr>
            ))}
          </tbody>
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
      <CnTable />
      <UsTable />
      {/* 页尾一句话: 两张表差额是哪几样东西凑出来的。具体数就在表里, 不展开也不写死数值 */}
      <p className="note">
        QDII 与美股 ETF 的收益率差异受<b>汇率</b>、<b>费率</b>、<b>溢价率</b>、
        <b>跟踪误差</b>等影响。
      </p>
    </div>
  );
}
