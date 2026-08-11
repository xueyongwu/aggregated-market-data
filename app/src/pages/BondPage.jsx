// 国债活跃券：银行间 1Y~30Y 各期限当日成交量最大的券，3s 轮询日内刷新。
import { useEffect, useState } from "react";
import { poll } from "../jsonp";
import { BOND_ACTIVE as BD } from "../data/bond_data";

const sign = (v) => (v >= 0 ? "pos" : "neg");
const bp = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "bp";
// 顶部大数字只放这两条: 全市场最活跃、也是所有人报盘时说的那两个数
const HERO = ["10年", "30年"];

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

/** 期限利差, 两端缺一即不显示(短端有时整天没有国债成交, 表里就少一行)。 */
function spread(by, a, b) {
  const x = by[a], y = by[b];
  if (!x || !y) return null;
  return `${a}-${b} ${((x.yield - y.yield) * 100).toFixed(0)}bp`;
}

export default function BondPage() {
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
            // 单券查询不给累计成交量(回 "---"), 只有全市场那份列表有 —— 拿不到就留空
            const vol = Math.round(+rec.dmiTtlTradedAmnt * 10) / 10;
            return {
              ...b,
              yield: +rec.dmiLatestContraRate,
              bp: rec.bpNum == null ? null : +rec.bpNum,
              vol: Number.isFinite(vol) ? vol : null,
              maturity: rec.termToMaturity || b.maturity,
              time: rec.showDate,
            };
          } catch {
            return b; // 拉不到就保持静态值, 时间戳自己会露馅
          }
        }),
      );
      setItems(next);
    }, 3000); // 单券 845B, 7 只并发一轮 ≈6KB; 实测 6 req/s 不限速, 后台标签页由 poll() 跳过
    // items 只在 poll 里被整体替换, 依赖它会每次重挂定时器 —— 只在挂载时装一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!items.length) return null;
  const by = Object.fromEntries(items.map((b) => [b.term, b]));
  const spreads = [spread(by, "30年", "10年"), spread(by, "10年", "2年")].filter(Boolean);
  return (
    <div className="wrap">
      <header>
        <div className="sub">更新于 {BD.updated}</div>
      </header>

      <div className="card">
        <h2>
          收益率 <span className="dot">银行间当日成交量最大的券，收益率上行=债价下跌</span>
        </h2>
        <div className="bond">
          {items
            .filter((b) => HERO.includes(b.term))
            .map((b) => (
              <div className="b" key={b.code}>
                <span className="t">{b.term}期</span>
                <span className="y">
                  {b.yield.toFixed(4)}%
                  {b.bp == null ? <i>—</i> : <small className={sign(b.bp)}>{bp(b.bp)}</small>}
                </span>
                <span className="m">
                  {b.name}
                  <i>
                    剩余 {b.maturity} · 成交 {b.vol == null ? "—" : `${b.vol} 亿`}
                  </i>
                </span>
                <span className="t">{b.time.slice(5, 16)}</span>
              </div>
            ))}
        </div>
      </div>

      <div className="card">
        <h2>
          各期限活跃券
          <span className="dot">
            同期限桶内当日成交量最大的国债，每季换券
            {spreads.length ? `；期限利差 ${spreads.join(" · ")}` : ""}
          </span>
        </h2>
        <div className="tWrap">
          <table className="dt">
            <thead>
              <tr>
                <th>期限</th>
                <th>活跃券</th>
                <th>剩余</th>
                <th>收益率</th>
                <th>涨跌</th>
                <th>成交</th>
                <th>最新成交</th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.code} className={HERO.includes(b.term) ? "hl" : ""}>
                  <td>{b.term}</td>
                  <td className="nm">
                    {b.name}
                    <span className="cd">{b.code}</span>
                  </td>
                  <td>{b.maturity}</td>
                  <td>{b.yield.toFixed(4)}%</td>
                  {b.bp == null ? <td>—</td> : <td className={sign(b.bp)}>{bp(b.bp)}</td>}
                  <td>{b.vol == null ? "—" : `${b.vol} 亿`}</td>
                  <td>{b.time.slice(5, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
