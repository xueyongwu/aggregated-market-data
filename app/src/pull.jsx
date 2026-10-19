// 触屏下拉刷新。加到主屏的 Web App(index.html 里 apple-mobile-web-app-capable)没有浏览器
// 那层下拉刷新和刷新按钮, 挂着的页面只能干等轮询 —— 手势自己接。
//
// 只在页顶、竖直往下拉时接管: 横向滑表格(.tWrap)、在图表里拖(.chart 有 tooltip / dataZoom)
// 都不碰。onPull 只是「现在就取一次」, 转圈按固定时长收尾, 不等各路请求回来。
import { useEffect, useState } from "react";

const TH = 70, MAX = 110; // 松手触发的阈值 / 最多拉多远(都是阻尼后的像素)

export default function Pull({ onPull }) {
  const [st, setSt] = useState({ d: 0, drag: false, busy: false });

  useEffect(() => {
    // 关掉浏览器自带的那套(Android Chrome / iOS Safari 网页里), 免得两个一起转
    const html = document.documentElement, prev = html.style.overscrollBehaviorY;
    html.style.overscrollBehaviorY = "none";
    let s = null, lock = false, timer;
    const start = (e) => {
      s = !lock && scrollY <= 0 && e.touches.length === 1 && !e.target.closest?.(".chart")
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, on: false, d: 0 }
        : null;
    };
    const move = (e) => {
      if (!s) return;
      const dx = e.touches[0].clientX - s.x, dy = e.touches[0].clientY - s.y;
      if (!s.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // 方向还没定
        if (dy <= 0 || Math.abs(dx) > dy || scrollY > 0) { s = null; return; } // 横滑 / 上滑: 放手
        s.on = true;
      }
      e.preventDefault(); // 接管后不让页面跟着动; 所以 touchmove 不能是 passive
      s.d = Math.min(MAX, dy * 0.5);
      setSt({ d: s.d, drag: true, busy: false });
    };
    const end = () => {
      const go = s?.on && s.d >= TH, was = s?.on;
      s = null;
      if (!was) return;
      if (!go) return setSt({ d: 0, drag: false, busy: false });
      lock = true;
      setSt({ d: TH, drag: false, busy: true });
      onPull();
      timer = setTimeout(() => {
        lock = false;
        setSt({ d: 0, drag: false, busy: false });
      }, 800);
    };
    addEventListener("touchstart", start, { passive: true });
    addEventListener("touchmove", move, { passive: false });
    addEventListener("touchend", end);
    addEventListener("touchcancel", end);
    return () => {
      removeEventListener("touchstart", start);
      removeEventListener("touchmove", move);
      removeEventListener("touchend", end);
      removeEventListener("touchcancel", end);
      clearTimeout(timer);
      html.style.overscrollBehaviorY = prev;
    };
  }, [onPull]);

  const { d, drag, busy } = st;
  return (
    <div
      className={"pull" + (busy ? " spin" : "") + (d >= TH ? " ok" : "")}
      style={{
        transform: `translate(-50%, ${d - 40}px)`,
        opacity: busy ? 1 : Math.min(1, d / TH),
        transition: drag ? "none" : "transform .2s, opacity .2s",
      }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" style={busy ? undefined : { transform: `rotate(${d * 4}deg)` }}
      >
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
    </div>
  );
}
