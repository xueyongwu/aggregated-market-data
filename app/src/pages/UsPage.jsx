// 美股纳指100：行情表(指数+七巨头) / 前10大权重股(含财报三列) / 行业权重(科技行可展开)。
// 三张表全是纯 HTML，无图表。
import { useMemo, useState } from "react";
import { useTheme } from "../theme";
import { Pct, fmt, useSort } from "../table";
import { US_PERF as U } from "../data/us_data";

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

const PERF_COLS = [
  ["name", "标的"], ["close", "收盘"], ["day", "涨跌幅"],
  ["wtd", "本周"], ["mtd", "本月"], ["ytd", "今年以来"],
];
const HOLD_COLS = [
  ["name", "标的"], ["weight", "权重"], ["day", "涨跌幅"], ["wtd", "本周"], ["mtd", "本月"], ["ytd", "今年以来"],
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
                <Pct v={r.day} />
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
                {["day", "wtd", "mtd", "ytd"].map((k) =>
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
              <td colSpan={7} />
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
  useTheme(); // 无图表, 换肤纯靠 CSS 变量, 但要跟着重渲染
  const H = U.holdings;
  // 不显示 U.updated: 那是脚本跑的时刻不是数据时刻(空跑也会刷新), 各卡片自己的「截至」才是
  // 真口径。payload 里的 updated 键留着 —— CryptoPage 还在用同一份 us_data.js。
  return (
    <div className="wrap">
      <PerfCard />
      {H?.items?.length ? <HoldCard H={H} /> : null}
      {H?.sectors?.length ? <SectorCard H={H} /> : null}
    </div>
  );
}
