// 美股纳指100 行情看板（原 us.html）。四张纯表格，无图表。
//   行情表(指数+七巨头) / 加密货币 / 前10大权重股(含财报三列) / 行业权重(科技行可展开)
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../theme";
import { poll } from "../jsonp";
import { US_PERF as U } from "../data/us_data";

const fmt = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
// 沿用上次的权重表可能是没有涨跌幅的旧格式, 缺值给 — 而不是崩掉整张表
const Pct = ({ v }) =>
  Number.isFinite(v) ? <td className={v >= 0 ? "pos" : "neg"}>{fmt(v)}</td> : <td>—</td>;
// 金额一行、同比另起一行塞进同一格。财报是另一个源, 可能整块缺(旧格式也没有) -> 给 —
const Yi = ({ v, y }) => (
  <td>
    {Number.isFinite(v) ? (v / 1e8).toFixed(2) + "亿" : "—"}
    {Number.isFinite(y) && <span className={"yo " + (y >= 0 ? "pos" : "neg")}>{fmt(y)}</span>}
  </td>
);
// 谷歌 A/C 是同一家公司的两个份额: 权重表里合成一行, 涨跌幅分 A/C 两行塞同一格
const PctAC = ({ v, w }) =>
  Number.isFinite(v) && Number.isFinite(w) ? (
    <td>
      <span className="ac">
        <span className={v >= 0 ? "pos" : "neg"}>A {fmt(v)}</span>
        <span className={w >= 0 ? "pos" : "neg"}>C {fmt(w)}</span>
      </span>
    </td>
  ) : (
    <Pct v={v} />
  );

/** 表头点击排序。同列再点切升降; 换列时数字降序、文字升序。每张表各持一份状态。 */
function useSort(rows, key) {
  const [st, setSt] = useState({ k: key, asc: false });
  const sorted = useMemo(() => {
    const cmp = (a, b) => {
      const x = a[st.k], y = b[st.k];
      if (typeof x === "string") return x.localeCompare(y, "zh");
      // 缺值(旧格式的权重表)恒排最后, 别让 NaN 比较把整个顺序搅乱
      return (Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity);
    };
    return [...rows].sort((a, b) => cmp(a, b) * (st.asc ? 1 : -1));
  }, [rows, st]);
  const th = (k, label) => (
    <th
      key={k}
      data-k={k}
      onClick={() =>
        setSt((s) =>
          s.k === k ? { k, asc: !s.asc } : { k, asc: typeof rows[0]?.[k] === "string" },
        )
      }
    >
      {label}
      {st.k === k ? (st.asc ? " ↑" : " ↓") : ""}
    </th>
  );
  return { sorted, th };
}

const PERF_COLS = [["name", "标的"], ["close", "收盘"], ["wtd", "本周"], ["mtd", "本月"], ["ytd", "今年以来"]];
const HOLD_COLS = [
  ["name", "标的"], ["weight", "权重"], ["wtd", "本周"], ["mtd", "本月"], ["ytd", "今年以来"],
  // 财报三列与权重同源, 这里按代码逐行取(GOOG 与 GOOGL 共用同一份)
  ["rpt", "财报公布日"], ["rev", "营收 / 同比"], ["ni", "净利润 / 同比"],
];

function PerfCard() {
  const { sorted, th } = useSort(U.items, "ytd");
  return (
    <div className="card">
      <h2>
        纳指100 · 美股七巨头 <span>· 截至 {U.items[0].date}</span>
      </h2>
      <div className="tWrap">
        <table className="dt">
          <thead>
            <tr>{PERF_COLS.map(([k, l]) => th(k, l))}</tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name} className={r.name === "纳斯达克100" ? "hl idx" : ""}>
                <td className="nm">{r.name}</td>
                <td>{r.close.toFixed(2)}</td>
                <Pct v={r.wtd} />
                <Pct v={r.mtd} />
                <Pct v={r.ytd} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 加密(Kraken, 另一个源 -> 可能整块缺失)。7x24 无收盘, 最新价就是实时价。
function CoinCard() {
  const C = U.crypto;
  const [live, setLive] = useState({}); // code -> 实时价
  const [sub, setSub] = useState(() =>
    C?.[0]?.stale
      ? `· 美元现货，截至 ${C[0].date}（UTC）（数据源失败，沿用上次）`
      : "· 美元现货，加载中…",
  );
  const busy = useRef(false);
  const gotLive = useRef(false);

  useEffect(() => {
    // 沿用上次的数据(stale)时不开实时: 那几个基准本身就是旧的, 配上实时价更没意义
    if (!C?.length || C[0].stale) return;
    const snapSub = `· 美元现货，截至 ${C[0].date}（UTC）`;
    // Kraken 开了 CORS(回显 Origin), 浏览器直接 fetch, 不用 EtfPage 那套 <script> 注入绕。
    // 超时兜底: 不设的话 fetch 可以挂很久, 副标题就一直卡在「加载中」。
    // 8s 超时 > 2s 轮询间隔, 慢网下会叠请求, 所以带个在途标志, 一次只飞一个。
    // 2s = 0.5 req/s, Kraken 公共接口约 1 req/s, 别再往下压了。
    return poll(() => {
      if (busy.current) return;
      busy.current = true;
      fetch("https://api.kraken.com/0/public/Ticker?pair=" + C.map((c) => c.code).join(","),
            { signal: AbortSignal.timeout(8000) })
        .then((r) => r.json())
        .then((j) => {
          const res = j.result || {};
          const next = {};
          C.forEach((c) => {
            // 响应键会被改名(XBTUSD -> XXBTZUSD), 按币种前三位反查, 别信对象键的顺序
            const hit = Object.entries(res).find(([k]) => k.includes(c.code.slice(0, 3)));
            if (hit) next[c.code] = parseFloat(hit[1].c[0]); // c = 最新成交 [价, 量]
          });
          if (Object.keys(next).length) {
            gotLive.current = true;
            setLive(next);
            // 拉到实时价后「截至」换成本机时区的刷新时刻(价格本身已是此刻的), 不再是 bar 的 UTC 日期。
            // sv-SE 的默认格式正好是 2026-08-02 09:43:12, 省得自己补零拼串
            setSub(`· 美元现货，截至 ${new Date().toLocaleString("sv-SE")}`);
          } else {
            // 200 了却一个价都没解析出来(键名改了 / j.error 非空): 同样落回快照口径,
            // 否则副标题一直卡在「加载中」—— 这条不能只靠 catch, 它压根没抛
            setSub(snapSub);
          }
        })
        // 实时只是锦上添花, 拉不到就保持 CI 那份静态数据。已经拿到过实时价的不改副标题:
        // 那时表里是上一次的实时价, 退回去写快照的 UTC 日期反而是错的
        .catch(() => { if (!gotLive.current) setSub(snapSub); })
        .finally(() => { busy.current = false; });
    }, 2000);
  }, [C]);

  if (!C?.length) return null;
  return (
    <div className={"card" + (C[0].stale ? " stale" : "")}>
      <h2>
        加密货币 <span>{sub}</span>
      </h2>
      <div className="tWrap">
        <table className="dt">
          <thead>
            <tr>
              <th>标的</th><th>最新价</th><th>今日</th><th>本周</th><th>本月</th><th>今年以来</th>
            </tr>
          </thead>
          <tbody>
            {C.map((c) => {
              // 实时价只换掉「最新」这一端, 三个基准仍是 us_data.js 里那根 bar 的:
              //   新涨跌幅 = (1 + p) × 实时价 / 那根收盘 − 1。p 只有两位小数, 误差 ±0.005pp
              const now = live[c.code];
              const k = now ? now / c.close : 1;
              const p = (v) => (1 + v / 100) * k - 1;
              return (
                <tr key={c.code}>
                  <td className="nm">
                    {c.name}
                    <span className="cd">{c.code}</span>
                  </td>
                  <td>{(now || c.close).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                  {/* 「今日」与另外三列同一套代数: 基准都是 us_data.js 那根 bar 之前的某根收盘,
                      只有分子换成实时价。旧格式没带 day -> NaN -> Pct 给 — */}
                  {["day", "wtd", "mtd", "ytd"].map((key) => (
                    <Pct key={key} v={p(c[key]) * 100} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HoldCard({ H }) {
  // 谷歌 A/C 并成一行: 权重相加, 名次取靠前那个, 财报两行本来就是同一份(直接沿用 A 的)。
  // alt 挂 C 那行, 只给涨跌幅三列用; 排序仍按 A 的数, 两个份额差不到 0.5pt, 排位一样
  const rows = useMemo(() => {
    const a = H.items.find((i) => i.code === "GOOGL"), c = H.items.find((i) => i.code === "GOOG");
    const out = a && c
      ? H.items.flatMap((i) =>
          i === c ? [] : i === a ? [{ ...a, name: "谷歌", code: "GOOGL / GOOG", weight: a.weight + c.weight, alt: c }] : [i],
        )
      : H.items;
    // 合并后上游名次断号(谷歌两份额并成一格), 按合并后的权重重排 1..10。
    // 名次固定按权重, 换列排序时不跟着变
    [...out].sort((x, y) => y.weight - x.weight).forEach((r, n) => { r.rank = n + 1; });
    return out;
  }, [H]);
  const { sorted, th } = useSort(rows, "weight");

  return (
    <div className={"card" + (H.stale ? " stale" : "")}>
      <h2>
        纳指100 前 10 大权重股{" "}
        <span>
          {/* 两列口径不同步: 权重来自 QQQ 持仓(上游周级更新), 行情来自腾讯日线(T-1 收盘) */}
          · 权重为 QQQ 持仓占比，截至 {H.asof}
          {H.stale && "（数据源失败，沿用上次）"}
          ；行情截至 {H.items[0].date || U.items[0].date /* 旧格式没带 date, 退回行情表的 */}
        </span>
      </h2>
      <div className="tWrap">
        <table className="dt">
          <thead>
            <tr>{HOLD_COLS.map(([k, l]) => th(k, l))}</tr>
          </thead>
          <tbody>
            {sorted.map((i) => (
              <tr key={i.code}>
                <td className="nm">
                  <span className="rk">{i.rank}</span>
                  {i.name}
                  <span className="cd">{i.code}</span>
                </td>
                <td>{i.weight.toFixed(2)}%</td>
                {["wtd", "mtd", "ytd"].map((k) =>
                  i.alt ? <PctAC key={k} v={i[k]} w={i.alt[k]} /> : <Pct key={k} v={i[k]} />,
                )}
                <td>{i.rpt || "—"}</td>
                <Yi v={i.rev} y={i.revYoy} />
                <Yi v={i.ni} y={i.niYoy} />
              </tr>
            ))}
          </tbody>
          {/* 合计放 tfoot: 不参与排序 */}
          <tfoot>
            <tr>
              <td>前 10 大合计</td>
              <td>{H.items.reduce((a, i) => a + i.weight, 0).toFixed(2)}%</td>
              <td colSpan={6} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// 行业权重表(与权重股同一份 payload, 老数据可能没这块 -> 隐藏卡片)。
// 科技那行可展开出子行业, 子行业条与父行共用同一把标尺, 长度可直接横向比。
function SectorCard({ H }) {
  const S = H.sectors;
  const [open, setOpen] = useState(false);
  const max = Math.max(...S.map((s) => s.weight));
  // 权重条: 纯 CSS, 宽度按最大权重归一, 不值得为它上图表库
  const Bar = ({ w }) => (
    <td className="bar">
      <i style={{ width: ((w / max) * 100).toFixed(1) + "%" }} />
    </td>
  );
  return (
    <div className={"card" + (H.stale ? " stale" : "")}>
      <h2>
        纳指100 行业权重 <span>· 截至 {H.asof}</span>
      </h2>
      <div className="tWrap">
        <table className="dt sec">
          <thead>
            <tr><th>行业</th><th>权重</th><th>占比</th></tr>
          </thead>
          {/* ponytail: 展开态是一个布尔, 只有科技一行可展开。真要多行各自展开再改成按行分组 */}
          <tbody className={open ? "open" : ""}>
            {S.map((s) => {
              const kid = s.name === "科技" ? H.tech || [] : [];
              return [
                <tr key={s.name} className={kid.length ? "exp" : ""} onClick={kid.length ? () => setOpen((o) => !o) : undefined}>
                  <td className="nm">
                    {kid.length > 0 && <span className="ar" />}
                    {s.name}
                  </td>
                  <td>{s.weight.toFixed(2)}%</td>
                  <Bar w={s.weight} />
                </tr>,
                ...kid.map((k) => (
                  <tr className="sub" key={s.name + k.name}>
                    <td className="nm">{k.name}</td>
                    <td>{k.weight.toFixed(2)}%</td>
                    <Bar w={k.weight} />
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function UsPage() {
  useTheme(); // 这一页没有图表, 换肤纯靠 CSS 变量, 但要跟着重渲染 tooltip 之外的语义色
  const H = U.holdings;
  return (
    <div className="wrap narrow">
      <header>
        <h1>美股纳指100 · 行情看板</h1>
        <div className="sub">更新于 {U.updated}</div>
      </header>
      <PerfCard />
      <CoinCard />
      {H?.items?.length ? <HoldCard H={H} /> : null}
      {H?.sectors?.length ? <SectorCard H={H} /> : null}
    </div>
  );
}
