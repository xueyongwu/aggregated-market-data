// 深浅色主题：偏好写 localStorage，data-theme 挂在 <html> 上（首帧前由 index.html 的内联脚本先定一次）。
//
// ECharts 的颜色是 setOption 时烤进去的，换肤只能 dispose 重建 —— 所以每个建图的 effect
// 都要把 theme 放进依赖数组，用 vars() 现读 CSS 变量。
//
// 组件与 useTheme/vars 同文件会退化 fast refresh（编辑本文件时整棵树重挂）。这文件四十来行、
// 改动极少，为它拆成 theme.js + ThemeUI.jsx 再让每个页面多一行 import 不划算。
/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState } from "react";

const Ctx = createContext({ theme: "light", toggle: () => {} });

export const useTheme = () => useContext(Ctx);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(
    () => (localStorage.theme === "dark" ? "dark" : "light"),
  );
  useEffect(() => {
    if (theme === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    localStorage.theme = theme;
  }, [theme]);
  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

/** 读一组 CSS 变量的当前值，供 ECharts option 用。vars("up","down") -> {up:"#d63b31",...} */
export function vars(...names) {
  const s = getComputedStyle(document.documentElement);
  return Object.fromEntries(names.map((n) => [n, s.getPropertyValue("--" + n).trim()]));
}

export function ThemeToggle() {
  const { toggle } = useTheme();
  return (
    <button className="tgl" onClick={toggle} title="切换深浅色" aria-label="切换深浅色">
      <svg className="moon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
      </svg>
      <svg className="sun" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 1.8v2.4M12 19.8v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M1.8 12h2.4M19.8 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
      </svg>
    </button>
  );
}
