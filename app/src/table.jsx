// 行情表共用零件（纳指QDII / 美股 / 加密三页）。
//
// Pct 是组件、fmt/useSort 不是，同文件会退化 fast refresh（编辑本文件时整树重挂）。
// 三十来行、改动极少，为它拆两个文件再让每页多一行 import 不划算。
/* eslint-disable react-refresh/only-export-components */
import { useMemo, useState } from "react";

export const fmt = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

/** 涨跌幅单元格。缺值（旧格式、基准还没异步到）给 — 而不是渲染成 NaN。 */
export const Pct = ({ v }) =>
  Number.isFinite(v) ? <td className={v >= 0 ? "pos" : "neg"}>{fmt(v)}</td> : <td>—</td>;

/**
 * 表头点击排序。同列再点切升降；换列时数字降序、文字升序。每张表各持一份状态。
 * 缺值恒排最后 —— NaN 参与比较会让 sort 的顺序整个乱掉，不只是那一行的位置错。
 */
export function useSort(rows, key) {
  const [st, setSt] = useState({ k: key, asc: false });
  const sorted = useMemo(() => {
    const cmp = (a, b) => {
      const x = a[st.k], y = b[st.k];
      if (typeof x === "string") return x.localeCompare(y, "zh");
      return (Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity);
    };
    return [...rows].sort((a, b) => cmp(a, b) * (st.asc ? 1 : -1));
  }, [rows, st]);
  const th = (k, label) => (
    <th
      key={k}
      data-k={k}
      onClick={() =>
        setSt((s) => (s.k === k ? { k, asc: !s.asc } : { k, asc: typeof rows[0]?.[k] === "string" }))
      }
    >
      {label}
      {st.k === k ? (st.asc ? " ↑" : " ↓") : ""}
    </th>
  );
  return { sorted, th };
}
