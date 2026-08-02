// 国债活跃券：银行间 10Y/30Y 当日成交量最大的券，60s 轮询日内刷新。
import { useEffect, useState } from "react";
import { poll } from "../jsonp";
import { BOND_ACTIVE as BD } from "../data/bond_data";

const sign = (v) => (v >= 0 ? "pos" : "neg");

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
    <div className="wrap">
      <header>
        <h1>国债活跃券</h1>
        <div className="sub">更新于 {BD.updated}</div>
      </header>
      <div className="card">
        <h2>
          收益率 <span className="dot">银行间当日成交量最大的券，收益率上行=债价下跌</span>
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
    </div>
  );
}
