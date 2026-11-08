// 读 theme.css 里的设计 token, 供 ECharts option 用。
//
// ECharts 的颜色是 setOption 时烤进 canvas 的, 读不到 CSS 变量, 所以建图的 effect 里先 vars() 现读一遍再传进去。
// 色值只在 theme.css 定义一份, 别在图表代码里写死。

/** 读一组 CSS 变量的当前值。vars("up","down") -> {up:"#e03c3c",...} */
export function vars(...names) {
  const s = getComputedStyle(document.documentElement);
  return Object.fromEntries(names.map((n) => [n, s.getPropertyValue("--" + n).trim()]));
}
