// 加密货币：BTC/ETH 美元现货，与美股表同口径（crypto_perf.py 产出 crypto_data.js）。
// 7x24 无收盘，最新那根 bar 的 close 就是实时价。
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme";
import { poll } from "../jsonp";
import { fmt } from "../table";
import { CRYPTO } from "../data/crypto_data";

// 四个基准的 UTC 日期 —— 从此刻的时钟推, 不信 CI 那根 bar 的日期。
// 这是「跨 UTC 日/周/月/年切要等下一次 CI 才换基准」那个窗口的解法(周切曾长达 23 小时):
// 基准收盘由 crypto_perf.bases() 一起导出, 前端查表即可, CI 什么时候跑都不影响正确性。
function baseDates(t = new Date()) {
  const [y, m, d, w] = [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCDay()];
  const iso = (x) => x.toISOString().slice(0, 10);
  return {
    day: iso(new Date(Date.UTC(y, m, d - 1))),
    // getUTCDay() 周日=0, 换算成「离本周一几天」是 (w+6)%7; 再退一天就是上周日
    wtd: iso(new Date(Date.UTC(y, m, d - ((w + 6) % 7) - 1))),
    mtd: iso(new Date(Date.UTC(y, m, 0))), // 第 0 天 = 上月最后一天, 不用自己判闰年
    ytd: iso(new Date(Date.UTC(y, 0, 0))), // 同理 = 去年 12-31
  };
}

export default function CryptoPage() {
  useTheme(); // 无图表, 换肤纯靠 CSS 变量, 但要跟着重渲染
  const C = CRYPTO.items;
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
    // Kraken 开了 CORS(回显 Origin), 浏览器直接 fetch, 不用 QdiiPage 那套 <script> 注入绕。
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
  // 每次渲染现算(轮询 2s 一刷, 跨 UTC 边界最多 2s 就切过去), 4 个 Date 不值得 memo
  const B = baseDates();
  // 不显示页头的「更新于」: crypto_data.js 不带 updated(那是脚本跑的时刻不是数据的时刻),
  // 卡片副标题里的「截至」才是真口径 —— 拿到实时价后它本来就是此刻。
  return (
    <div className="wrap">
      <div className={"card" + (C[0].stale ? " stale" : "")}>
        <h2>
          BTC / ETH <span>{sub}</span>
        </h2>
        <div className="bond crypto">
          {C.map((c) => {
            const now = live[c.code];
            const k = now ? now / c.close : 1;
            // 有实时价时按此刻的 UTC 时钟自己查基准, 跨日/周/月/年切立即生效。
            // 没实时价就原样显示 CI 那份(k=1 -> p 返回 v): 那时 c.close 可能已是昨天那根,
            // 拿它算「今日」会得出昨天的日涨跌却标成今天, 不如照实显示快照 + 副标题的「截至」。
            // 查不到基准(CI 连挂 >7 天, bases 覆盖不到今天)才退回只换分子的老算法:
            //   新涨跌幅 = (1 + p) × 实时价 / 那根收盘 − 1。p 只有两位小数, 误差 ±0.005pp
            // 旧格式没带 day 且无基准 -> NaN -> 下面 cell() 给 — 而不是渲染成 NaN
            const p = (v, key) => {
              const b = now && c.bases?.[B[key]];
              return b ? (now / b - 1) * 100 : ((1 + v / 100) * k - 1) * 100;
            };
            const cell = (v) =>
              Number.isFinite(v) ? <b className={v >= 0 ? "pos" : "neg"}>{fmt(v)}</b> : <b>—</b>;
            const day = p(c.day, "day");
            return (
              <div className="b" key={c.code}>
                <span className="t">
                  {c.name} · {c.code}
                </span>
                <span className="y">
                  {(now || c.close).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  {Number.isFinite(day) ? (
                    <small className={day >= 0 ? "pos" : "neg"}>{fmt(day)}</small>
                  ) : (
                    <i>—</i>
                  )}
                </span>
                <span className="m">
                  {[
                    ["本周", "wtd"],
                    ["本月", "mtd"],
                    ["今年以来", "ytd"],
                  ].map(([label, key]) => (
                    <span key={key}>
                      <i>{label}</i>
                      {cell(p(c[key], key))}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
