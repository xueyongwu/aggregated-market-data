// 定投记录：手工录入的场内定投流水（dca_data.js）+ 汇总瓦片 + 成交价/成本图 + 明细表。
//
// 成本口径是**摊薄成本** = 净投入(累计买入 − 累计卖出，都含费用) ÷ 持仓股数，与国泰海通
// App 的「成本」逐位一致(2026-08-25 实测 1.805 / 总盈亏 +10,429.16 / +11.941%)。
// 已实现盈亏不单列 —— 从没清过仓，落袋那部分被摊回成本里，总盈亏一个数就说完了。
// 曾经按移动加权平均算(均价 1.9539 + 已实现 7,229.02)，两个数都跟 App 对不上，撤了。
import { useEffect, useMemo, useRef, useState } from "react";
import { echarts } from "../echarts";
import { useTheme, vars } from "../theme";
import { aOpen, jsonp, poll } from "../jsonp";
import { COLORS, MOBILE, fmtP, tip, xDate, yPrice } from "../chartBase";
import { DCA } from "../data/dca_data";

const GL = MOBILE ? 42 : 52;
const sign = (v) => (v >= 0 ? "pos" : "neg");
const money = (v) => v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Safari 不认 "YYYY-MM-DD HH:MM:SS", 换成斜杠再解析(同 QdiiPage)
const week = (t) => "周" + "日一二三四五六"[new Date(t.slice(0, 10).replace(/-/g, "/")).getDay()];
const signed = (v) => (v >= 0 ? "+" : "−") + money(Math.abs(v));
// 持有时长: 首笔成交至今的自然日。没做「清仓后重新计时」—— 从没清过仓, 真清了这口径本身就得重定义。
const held = (t) => Math.floor((Date.now() - new Date(t.slice(0, 10).replace(/-/g, "/"))) / 864e5);

// 波段统计的起点(含当日)。**必须是周一** —— 下面按自然周认定「每周第一笔买入 = 周定投」，
// 从周中切会把那周已经打过的定投当成加仓。2026-06-29 之前是建仓期(6 月那波大额进出)，
// 混进来看不出加仓/减仓的成色。
const SINCE = "2026-06-29";

/** 自 SINCE 起：周定投(每周第一笔买入)、低点加仓(同周其余买入)、新高减仓(卖出)、加仓剩余。 */
function swing(trades) {
  const monday = (t) => {
    const d = new Date(t.slice(0, 10).replace(/-/g, "/"));
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return +d;
  };
  const weeks = new Set();
  let dca = 0, dcaN = 0, add = 0, addN = 0, cut = 0, cutN = 0;
  for (const [t, qty] of trades) {
    if (t < SINCE) continue;
    if (qty < 0) {
      cut += -qty;
      cutN++;
    } else if (weeks.has(monday(t))) {
      add += qty;
      addN++;
    } else {
      weeks.add(monday(t)); // 每周第一笔买入 = 周定投
      dca += qty;
      dcaN++;
    }
  }
  return { dca, dcaN, add, addN, cut, cutN, left: add - cut };
}

/** 逐笔滚出持仓与摊薄成本。费用计入买入成本、冲减卖出收入。 */
function calc(trades) {
  let shares = 0, bought = 0, sold = 0;
  const rows = trades.map(([t, qty, price, fee]) => {
    if (qty > 0) bought += qty * price + fee;
    else sold += -qty * price - fee;
    shares += qty;
    return { t, qty, price, fee, amount: Math.abs(qty) * price, shares, avg: shares ? (bought - sold) / shares : 0 };
  });
  return { rows, shares, bought, sold, net: bought - sold, avg: shares ? (bought - sold) / shares : 0 };
}

export default function DcaPage() {
  const { theme } = useTheme();
  const box = useRef(null);
  const V = useMemo(() => calc(DCA.trades), []);
  const S = useMemo(() => swing(DCA.trades), []);
  const lastTrade = V.rows[V.rows.length - 1];
  // 现价：腾讯快照(<script> 注入绕 CORS, 同 QdiiPage)。拉不到就退回最后一笔成交价 ——
  // 页面主体是历史记录, 为一个数字整页留白不值。
  const [live, setLive] = useState(null);
  useEffect(() => {
    let first = true;
    return poll(() => {
      if (!first && !aOpen()) return;
      first = false;
      jsonp("https://qt.gtimg.cn/q=" + DCA.code, () => {
        const f = (window["v_" + DCA.code] || "").split("~"); // [3]现价 [4]昨收
        const p = +f[3];
        if (p > 0) setLive({ p, prev: +f[4] });
      });
    }, 3000); // 3s: 同 BondPage 的日内轮询, 单只快照回 ~200B
  }, []);

  const now = live?.p ?? lastTrade.price;
  const value = V.shares * now;
  const total = value - V.net; // 总盈亏 = 市值 − 净投入
  // 当日盈亏: 昨收拿不到(降级/停牌)时留空, 别拿成交价当昨收凑一个假数
  const today = live?.prev > 0 ? V.shares * (now - live.prev) : null;

  useEffect(() => {
    const C = vars(...COLORS);
    const R = V.rows;
    const m = echarts.init(box.current, null, { renderer: "canvas" });
    m.setOption({
      grid: { left: GL, right: MOBILE ? 12 : 20, top: 24, bottom: 30 },
      tooltip: {
        ...tip(C),
        formatter: (ps) => {
          const r = R[ps[0].dataIndex];
          return (
            `${r.t}<br>${r.qty > 0 ? "买入" : "卖出"} <b>${Math.abs(r.qty)}</b> 股 @ ${r.price.toFixed(3)}` +
            `<br>金额 ${money(r.amount)}<br>成交后持仓 ${r.shares} 股 · 成本 ${r.avg.toFixed(3)}`
          );
        },
      },
      xAxis: { ...xDate(C), data: R.map((r) => r.t.slice(0, 10)) },
      yAxis: yPrice(C),
      // 只用 inside(滚轮/双指捏合缩放 + 拖动平移), 不上 slider —— slider 要多注册一个
      // DataZoomSliderComponent 进包, 还要在窄屏再让出一条 ~30px 的横条。
      dataZoom: [{ type: "inside" }],
      series: [
        {
          name: "成交价",
          type: "line",
          data: R.map((r) => ({
            value: +r.price.toFixed(3),
            itemStyle: { color: r.qty > 0 ? C.up : C.down },
          })),
          symbolSize: MOBILE ? 3.5 : 5, // 窄屏点密, 小一号才不糊成一条
          // 默认 'auto' 会在点挤到一起时自动省略符号 —— 窄屏下 79 笔成交只剩几个点。
          // 这些点就是这张图的主体(红买绿卖), 宁可挤也不能少。
          showAllSymbol: true,
          lineStyle: { width: 1, color: C.muted, opacity: 0.5 },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: C.blue, type: "dashed" },
            // 标签贴左端(y 轴那侧)画在线上方: 默认的 end 落在 grid 外, 会被卡片右边缘裁掉半截
            label: {
              position: "insideStartTop",
              color: C.muted,
              fontSize: 11,
              formatter: "现价 " + now.toFixed(3),
            },
            data: [{ yAxis: now }],
          },
        },
        {
          name: "摊薄成本",
          type: "line",
          showSymbol: false,
          data: R.map((r) => +r.avg.toFixed(3)),
          lineStyle: { width: 2, color: C.avg },
        },
      ],
    });
    const onResize = () => m.resize();
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      m.dispose();
    };
  }, [V, theme, now]);

  return (
    <div className="wrap dca">
      <header>
        <div className="sub">
          {DCA.name} · {DCA.code.slice(2)} · 最后一笔 {lastTrade.t.slice(0, 10)}
        </div>
      </header>

      <div className="tiles">
        <div className="tile">
          <span className="k">持仓市值</span>
          <span className="v">{money(value)}<small>元</small></span>
          <span className="u">{V.shares.toLocaleString()} 股 · 持有 {held(DCA.trades[0][0])} 天</span>
        </div>
        <div className="tile">
          <span className="k">摊薄成本</span>
          <span className="v">{V.avg.toFixed(3)}</span>
          <span className="u">
            现价 {now.toFixed(3)}
            {live ? "" : "（收盘/最后成交）"}
          </span>
        </div>
        <div className="tile">
          <span className="k">总盈亏</span>
          <span className={`v ${sign(total)}`}>{signed(total)}</span>
          <span className={`u ${sign(total)}`}>
            {fmtP((total / V.net) * 100, 3)}
            <i>净投入 {money(V.net)}</i>
          </span>
        </div>
        <div className="tile">
          <span className="k">当日盈亏</span>
          {today == null ? (
            <span className="v">—</span>
          ) : (
            <>
              <span className={`v ${sign(today)}`}>{signed(today)}</span>
              <span className={`u ${sign(today)}`}>{fmtP((now / live.prev - 1) * 100, 3)}</span>
            </>
          )}
        </div>
      </div>

      <div className="tiles-h">自 {SINCE} 起</div>
      <div className="tiles">
        <div className="tile">
          <span className="k">周定投</span>
          <span className="v">{S.dca.toLocaleString()}<small>股</small></span>
          <span className="u">{S.dcaN} 笔 · 每周第一笔</span>
        </div>
        <div className="tile">
          <span className="k">低点加仓</span>
          <span className="v">{S.add.toLocaleString()}<small>股</small></span>
          <span className="u">{S.addN} 笔 · 每周第二笔起</span>
        </div>
        <div className="tile">
          <span className="k">新高减仓</span>
          <span className="v">{S.cut.toLocaleString()}<small>股</small></span>
          <span className="u">{S.cutN} 笔</span>
        </div>
        <div className="tile derived">
          <span className="k">低点加仓剩余</span>
          <span className="v">{S.left.toLocaleString()}<small>股</small></span>
          <span className="u">低点加仓 − 新高减仓</span>
        </div>
      </div>

      <div className="card">
        <h2>
          成交价与摊薄成本 <span className="dot">红点买入 · 绿点卖出 · 黄线为摊薄成本</span>
        </h2>
        <div ref={box} className="chart main" />
      </div>

      <div className="card">
        <h2>
          交易明细 <span className="dot">{V.rows.length} 笔</span>
        </h2>
        <div className="tWrap">
          <table className="dt">
            <thead>
              <tr>
                <th>时间</th>
                <th>方向</th>
                <th>成交价</th>
                <th>数量</th>
                <th className="mHide">金额</th>
                <th className="mHide">费用</th>
                <th>持仓</th>
                <th>摊薄成本</th>
              </tr>
            </thead>
            <tbody>
              {[...V.rows].reverse().map((r) => (
                <tr key={r.t}>
                  <td className="nm">
                    <span className="mHide">{r.t.slice(0, 5)}</span>
                    {r.t.slice(5, 16)}
                    <span className="cd">{week(r.t)}</span>
                  </td>
                  <td className={sign(r.qty)}>{r.qty > 0 ? "买入" : "卖出"}</td>
                  <td>{r.price.toFixed(3)}</td>
                  <td>{r.qty.toLocaleString()}</td>
                  <td className="mHide">{money(r.amount)}</td>
                  <td className="mHide">{r.fee.toFixed(2)}</td>
                  <td>{r.shares.toLocaleString()}</td>
                  <td>{r.avg.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>合计</td>
                <td />
                <td />
                <td>{V.shares.toLocaleString()}</td>
                <td className="mHide">{money(V.net)}</td>
                <td className="mHide" />
                <td>{V.shares.toLocaleString()}</td>
                <td>{V.avg.toFixed(3)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

    </div>
  );
}
