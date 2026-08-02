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

/** 挂一个轮询：立刻跑一次，之后每 ms 一次。返回 clearInterval 用的清理函数。 */
export function poll(fn, ms) {
  fn();
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}
