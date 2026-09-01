// 七块看板合并成的单页应用。路由走 hash（#/qdii、#/us …）：
// GitHub Pages 是纯静态托管，history 路由刷新会 404，hash 不用服务端配合。
//
// 导航两种形态，同一份 PAGES 渲染两遍（见 theme.css）：宽屏顶部一条横向 pill，
// 窄屏收成汉堡 + 左侧抽屉 —— 7 项在 375px 上横排必然溢出成横向滚动条。
import { lazy, Suspense, useEffect, useState } from "react";
import { ThemeProvider, ThemeToggle } from "./theme";
import "./theme.css";

// 每页都把自己那份数据 import 进来（房价 70KB…），静态引入会让几份
// 全挤进首屏那个 chunk。lazy 让 Vite 按页切包，只下当前这页要的那份。
const PAGES = [
  { id: "qdii", nav: "纳指 · QDII", El: lazy(() => import("./pages/QdiiPage")) },
  { id: "dca", nav: "定投+", El: lazy(() => import("./pages/DcaPage")) },
  { id: "us", nav: "美股纳指100", El: lazy(() => import("./pages/UsPage")) },
  { id: "astock", nav: "A股趋势", El: lazy(() => import("./pages/AStockPage")) },
  { id: "index", nav: "宽基指数", El: lazy(() => import("./pages/IndexPage")) },
  { id: "bond", nav: "国债活跃券", El: lazy(() => import("./pages/BondPage")) },
  { id: "housing", nav: "70城房价", El: lazy(() => import("./pages/HousingPage")) },
];

const routeOf = () => location.hash.replace(/^#\/?/, "") || PAGES[0].id;

export default function App() {
  const [route, setRoute] = useState(routeOf);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    const on = () => setRoute(routeOf());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  const page = PAGES.find((p) => p.id === route) || PAGES[0];

  // 选完就收起 —— 抽屉盖住整屏，留着会挡住刚跳过去的页面。挂在 onClick 而不是
  // 跟着路由变化收：点已经选中的那一项不触发 hashchange，只靠路由收会卡住不动。
  const links = PAGES.map((p) => (
    <a
      key={p.id}
      href={`#/${p.id}`}
      className={p.id === page.id ? "on" : ""}
      onClick={() => setDrawer(false)}
    >
      {p.nav}
    </a>
  ));

  return (
    <ThemeProvider>
      <nav className="nav">
        <div className="nav-in">
          <button
            className="burger"
            aria-label="菜单"
            aria-expanded={drawer}
            onClick={() => setDrawer((d) => !d)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <span className="nav-now">{page.nav}</span>
          <div className="nav-bar">{links}</div>
          <span className="sp" />
          <ThemeToggle />
        </div>
      </nav>

      {/* 抽屉只在窄屏出现（宽屏 CSS 里 display:none），点遮罩或选项都关 */}
      <div className={"drawer" + (drawer ? " open" : "")}>
        <div className="drawer-mask" onClick={() => setDrawer(false)} />
        <div className="drawer-panel">{links}</div>
      </div>

      {/* key 让切页时整棵子树重建：各页图表是命令式 init 的，复用实例会画到错的容器上 */}
      <Suspense fallback={<div className="miss">加载中…</div>}>
        <page.El key={page.id} />
      </Suspense>
    </ThemeProvider>
  );
}
