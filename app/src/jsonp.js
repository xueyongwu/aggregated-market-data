// <script> 注入取数：腾讯 qt / 新浪 MinLine / 腾讯 fqkline 都没有 CORS 头，
// 但都能当 JSONP 加载（顶层 var 落到 window 上，或接口本身就吐 `var x=` 赋值）。
// fetch 拿不到，注入 <script> 可以 —— 这是这三个源唯一的浏览器直连方式。
//
// 缓存必须绕开：src 带 _=时间戳，否则轮询会一直吃同一份。
export function jsonp(src, onload) {
  const s = document.createElement("script");
  s.src = src + (src.includes("?") ? "&" : "?") + "_=" + Date.now();
  const done = () => s.remove();
  s.onload = () => {
    done();
    try {
      onload();
    } catch {
      /* 取数是锦上添花，解析失败保持页面上已有的值 */
    }
  };
  s.onerror = done;
  document.head.appendChild(s);
  return () => s.remove();
}

// 北京时间的 Date(不信浏览器时区)。节假日一律不判 —— 快照回上一交易日收盘, 值不变,
// 空转一天可接受。
const bj = () => new Date(Date.now() + new Date().getTimezoneOffset() * 6e4 + 288e5);

// A股场内时段: 工作日 9:15(集合竞价) ~ 15:05(收盘后留点余量)。
export function aOpen() {
  const t = bj(), m = t.getHours() * 60 + t.getMinutes();
  return t.getDay() >= 1 && t.getDay() <= 5 && m >= 555 && m <= 905;
}

// 美股常规时段, 换算成北京时间: 夏令时 21:30~04:00, 冬令时 22:30~05:00 —— 直接取两者并集
// 21:25~05:05, 冬天多轮询一小时(拿回同一个时间戳)比为 DST 维护一张日期表便宜。
// 跨零点, 所以按「周一~周五的夜盘 + 周二~周六的凌晨」判: 周五那场落在北京周六凌晨。
export function usOpen() {
  const t = bj(), m = t.getHours() * 60 + t.getMinutes(), d = t.getDay();
  if (m >= 21 * 60 + 25) return d >= 1 && d <= 5;
  if (m <= 5 * 60 + 5) return d >= 2 && d <= 6;
  return false;
}

/** 挂一个轮询：立刻跑一次，之后每 ms 一次。返回 clearInterval 用的清理函数。
 *
 * 后台标签页跳过：浏览器本就把不可见标签的 setInterval 钳到 ≥1 分钟，但钳多少不确定
 * （放音频的标签、被遮挡但"可见"的窗口都不一样）。显式判一下，请求数才是确定的。
 * 所有调用方都是"刷新屏幕上的实时价"，看不见时不刷没有副作用，回到前台下一拍即恢复。 */
export function poll(fn, ms) {
  fn();
  const id = setInterval(() => document.hidden || fn(), ms);
  return () => clearInterval(id);
}
