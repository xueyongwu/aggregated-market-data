// 四块看板合并成的单页应用。路由走 hash（#/a、#/etf、#/us、#/housing）：
// GitHub Pages 是纯静态托管，history 路由刷新会 404，hash 不用服务端配合。
import { lazy, Suspense, useEffect, useState } from "react";
import { ThemeProvider, ThemeToggle } from "./theme";
import "./theme.css";

// 每页都把自己那份数据 import 进来（etf_data.js 88KB、房价 70KB…），静态引入会让四份
// 全挤进首屏那个 chunk。lazy 让 Vite 按页切包，只下当前这页要的那份。
const PAGES = [
  { id: "a", nav: "A股中位数", title: "A股全市场 · 数据看板", El: lazy(() => import("./pages/AStockPage")) },
  { id: "etf", nav: "纳指QDII", title: "纳指QDII · 场内看板", El: lazy(() => import("./pages/EtfPage")) },
  { id: "us", nav: "美股", title: "美股纳指100 · 行情看板", El: lazy(() => import("./pages/UsPage")) },
  { id: "housing", nav: "70城房价", title: "70城房价趋势 · 2021-2026", El: lazy(() => import("./pages/HousingPage")) },
];

const routeOf = () => location.hash.replace(/^#\/?/, "") || PAGES[0].id;

export default function App() {
  const [route, setRoute] = useState(routeOf);
  useEffect(() => {
    const on = () => setRoute(routeOf());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  const page = PAGES.find((p) => p.id === route) || PAGES[0];
  useEffect(() => {
    document.title = page.title;
  }, [page]);

  return (
    <ThemeProvider>
      <nav className="nav">
        <div className="nav-in">
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={p.id === page.id ? "on" : ""}>
              {p.nav}
            </a>
          ))}
          <span className="sp" />
          <ThemeToggle />
        </div>
      </nav>
      {/* key 让切页时整棵子树重建：各页图表是命令式 init 的，复用实例会画到错的容器上 */}
      <Suspense fallback={<div className="miss">加载中…</div>}>
        <page.El key={page.id} />
      </Suspense>
    </ThemeProvider>
  );
}
