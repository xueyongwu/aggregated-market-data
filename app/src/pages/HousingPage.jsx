import { useRef, useEffect, useMemo, useState } from "react";
import { echarts } from "../echarts";
import {
  dataByYear,
  availableYears,
  cityTiers,
  getCitiesAbove100,
  getFullTimeline,
  getMultiYearChangeCounts,
} from "../data/housingData";
import { chartColors, axisCommon, tooltipCommon } from "../chartTheme";
import "../housing.css";

const HOUSE_TYPES = [
  { key: "secondHand", label: "二手住宅" },
  { key: "newHouse", label: "新建商品住宅" },
];
// 分级口径跟着数据走（国家统计局：一线 4 / 二线 31 / 三线 35）
const tierOrder = Object.keys(cityTiers);
// ponytail: 挂载时判一次，旋转屏幕不重算；有人抱怨再监听 resize
const isMobile = () => window.innerWidth < 768;

// 分段按钮: 二手/新房、仅上涨/全部 两处共用
function Seg({ items, value, onChange }) {
  return (
    <div className="seg">
      {items.map(([k, label]) => (
        <button key={k} className={k === value ? "on" : ""} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

function CountTile({ label, now, prev }) {
  const d = now - prev;
  return (
    <div className="tile">
      <span className="k">{label}</span>
      <span className="v">{now}<small>城</small></span>
      <span className={"u " + (d > 0 ? "pos" : d < 0 ? "neg" : "")}>较上月 {d > 0 ? "+" : ""}{d}</span>
    </div>
  );
}

function CityListKpi({ label, cities, weak }) {
  return (
    <div className="tile">
      <span className="k">{label}</span>
      <ol className={"rk" + (weak ? " weak" : "")}>
        {cities.map((s) => (
          <li key={s.city}><b>{s.city}</b><span>{s.val}</span></li>
        ))}
      </ol>
    </div>
  );
}

function HousingPage() {
  const multiYearChartRef = useRef(null);
  const multiYearChartInstance = useRef(null);
  const yearChartRef = useRef(null);
  const yearChartInstance = useRef(null);

  const [houseType, setHouseType] = useState("secondHand");
  const [selectedYear, setSelectedYear] = useState(availableYears[availableYears.length - 1]);
  const [highlightedMonth, setHighlightedMonth] = useState(null);
  const [showAllCities, setShowAllCities] = useState(false);

  const { months, newHouse, secondHand } = dataByYear[selectedYear];

  const multiYearData = useMemo(() => {
    const timeline = getFullTimeline();
    const counts = getMultiYearChangeCounts();
    return { timeline, counts };
  }, []);

  const yearChartData = useMemo(() => ({
    newCounts: months.map((_, i) => getCitiesAbove100(newHouse, i).length),
    secondCounts: months.map((_, i) => getCitiesAbove100(secondHand, i).length),
  }), [months, newHouse, secondHand]);

  const kpiData = useMemo(() => {
    const lastIdx = months.length - 1;
    const prevIdx = lastIdx > 0 ? lastIdx - 1 : 0;
    const cities = Object.keys(newHouse);
    const newUpCount = cities.filter((c) => newHouse[c][lastIdx] > 100).length;
    const newUpPrev = cities.filter((c) => newHouse[c][prevIdx] > 100).length;
    const secondUpCount = cities.filter((c) => secondHand[c][lastIdx] > 100).length;
    const secondUpPrev = cities.filter((c) => secondHand[c][prevIdx] > 100).length;
    // 当月指数排序，取头尾各 3 城
    const rank = (dataObj) =>
      cities
        .map((c) => ({ city: c, val: dataObj[c][lastIdx] }))
        .filter((x) => x.val != null)
        .sort((a, b) => b.val - a.val);
    const newRanked = rank(newHouse);
    const secondRanked = rank(secondHand);
    return {
      month: months[lastIdx],
      newUpCount,
      newUpPrev,
      secondUpCount,
      secondUpPrev,
      strongest: newRanked.slice(0, 3),
      weakest: newRanked.slice(-3).reverse(),
      secondStrongest: secondRanked.slice(0, 3),
      secondWeakest: secondRanked.slice(-3).reverse(),
    };
  }, [months, newHouse, secondHand]);

  // 全时段堆叠柱状图：每月 70 城拆成上涨 / 持平 / 下跌
  useEffect(() => {
    if (!multiYearChartRef.current) return;
    if (multiYearChartInstance.current) multiYearChartInstance.current.dispose();
    multiYearChartInstance.current = echarts.init(multiYearChartRef.current);
    const C = chartColors();

    const markLines = [];
    let cumIdx = 0;
    availableYears.forEach((year) => {
      cumIdx += dataByYear[year].months.length;
      markLines.push({ xAxis: cumIdx - 1 });
    });

    const counts = multiYearData.counts[houseType];
    const mobile = isMobile();
    const total = multiYearData.timeline.length;
    // 手机默认只看最近 12 个月，历史靠拖拽/双指缩放；全量标签在小屏挤成一团
    const zoomStart = mobile ? Math.max(0, (1 - 12 / total) * 100) : 0;

    const mkSeries = (name, key, color, extra = {}) => ({
      name,
      type: "bar",
      stack: "total",
      data: counts[key],
      barMaxWidth: 12,
      barCategoryGap: "30%",
      itemStyle: { color },
      emphasis: { focus: "series" },
      ...extra,
    });

    const option = {
      tooltip: {
        ...tooltipCommon(C),
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: C.rule, opacity: 0.5 } },
        formatter: (params) => {
          let s = `<b style="color:${C.ink}">${params[0].axisValue}</b><br/>`;
          params.forEach((p) => {
            s += `${p.marker} ${p.seriesName}&nbsp;&nbsp;<b style="color:${C.ink}">${p.value}</b> 城<br/>`;
          });
          return s;
        },
      },
      legend: {
        data: ["上涨", "持平", "下跌"],
        bottom: 0,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { fontSize: 12, color: C.ink2 },
      },
      grid: mobile
        ? { left: 30, right: 8, top: 14, bottom: 72 }
        : { left: 36, right: 12, top: 16, bottom: 76 },
      xAxis: {
        ...axisCommon(C),
        type: "category",
        data: multiYearData.timeline,
        axisTick: { ...axisCommon(C).axisTick, alignWithLabel: true },
        axisLabel: {
          interval: 0,
          margin: 10,
          // 每年首个月（含 2021 从 7 月开始）的标签带年份，其余只显示月份数字
          formatter: (v, i) => {
            const [year, month] = v.split("-");
            const m = month.replace("月", "");
            return m === "1" || i === 0 ? `{m|${m}}\n{y|${year}}` : `{m|${m}}`;
          },
          rich: {
            m: { fontSize: 11, color: C.ink4, lineHeight: 16 },
            y: { fontSize: 12, fontWeight: "bold", color: C.ink2, lineHeight: 18 },
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        ...axisCommon(C),
        type: "value",
        max: 70,
        minInterval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
      },
      dataZoom: [{ type: "inside", start: zoomStart, end: 100 }],
      series: [
        mkSeries("上涨", "up", C.up, {
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: C.ink4, type: "solid", width: 1, opacity: 0.4 },
            data: markLines,
            label: { show: false },
          },
        }),
        mkSeries("持平", "flat", C.flat),
        mkSeries("下跌", "down", C.down),
      ],
    };

    multiYearChartInstance.current.setOption(option);

    const handleResize = () => multiYearChartInstance.current?.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      multiYearChartInstance.current?.dispose();
    };
  }, [multiYearData, houseType]);

  // 选中年份的月度折线图，点击数据点高亮下方表格对应月份
  useEffect(() => {
    if (!yearChartRef.current) return;
    if (yearChartInstance.current) yearChartInstance.current.dispose();
    yearChartInstance.current = echarts.init(yearChartRef.current);
    const C = chartColors();
    const mobile = isMobile();

    const mkLine = (name, data, color) => ({
      name,
      type: "line",
      data,
      smooth: true,
      symbol: "circle",
      symbolSize: mobile ? 6 : 8,
      lineStyle: { width: 2.5 },
      itemStyle: { color },
      // 小屏上两条线的数值标签互相压字，靠 tooltip 看数
      label: { show: !mobile, fontSize: 12, fontWeight: "bold", color: C.ink2 },
    });

    yearChartInstance.current.setOption({
      tooltip: {
        ...tooltipCommon(C),
        trigger: "axis",
        formatter: (params) => {
          let s = `<b style="color:${C.ink}">${params[0].axisValue}</b><br/>`;
          params.forEach((p) => {
            s += `${p.marker} ${p.seriesName}&nbsp;&nbsp;<b style="color:${C.ink}">${p.value}</b> 城<br/>`;
          });
          return s;
        },
      },
      legend: {
        data: ["新建商品住宅", "二手住宅"],
        bottom: 0,
        itemWidth: 14,
        textStyle: { fontSize: 12, color: C.ink2 },
      },
      grid: mobile
        ? { left: 30, right: 8, top: 24, bottom: 46 }
        : { left: 36, right: 12, top: 28, bottom: 50 },
      xAxis: { ...axisCommon(C), type: "category", data: months },
      yAxis: {
        ...axisCommon(C),
        type: "value",
        minInterval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [
        mkLine("新建商品住宅", yearChartData.newCounts, C.series1),
        mkLine("二手住宅", yearChartData.secondCounts, C.series2),
      ],
    });

    yearChartInstance.current.on("click", (params) => {
      if (params.componentType !== "series") return;
      setHighlightedMonth(params.dataIndex);
      setTimeout(() => {
        document.getElementById(`table-row-${params.dataIndex}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    });

    const handleResize = () => yearChartInstance.current?.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      yearChartInstance.current?.dispose();
    };
  }, [yearChartData, months]);

  const typeLabel = HOUSE_TYPES.find((t) => t.key === houseType).label;
  // 时间跨度跟着数据走, 别写死(早前副标题写死「— 2026年5月」, 数据更新后就对不上)
  const span = (v) => v.replace("-", "年");
  const tl = multiYearData.timeline;

  return (
    <div className="wrap housing">
      <header>
        <div className="sub">{span(tl[0])} — {span(tl[tl.length - 1])} · 国家统计局</div>
      </header>

      <div className="card">
        <div className="hd">
          <h2>
            70城{typeLabel}环比涨跌城市数量<span className="dot">单位：城市个数 · 环比指数上月=100</span>
          </h2>
          <Seg items={HOUSE_TYPES.map((t) => [t.key, t.label])} value={houseType} onChange={setHouseType} />
        </div>
        <div ref={multiYearChartRef} className="chart hm" />
      </div>

      <div className="yearbar">
        <span className="tiles-h">{kpiData.month}（{selectedYear}年最新一期）</span>
        <select className="pick" value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)}>
          {availableYears.map((year) => (<option key={year} value={year}>{year}年</option>))}
        </select>
      </div>
      <div className="tiles c3">
        <CountTile label="新房上涨" now={kpiData.newUpCount} prev={kpiData.newUpPrev} />
        <CityListKpi label="新房最强" cities={kpiData.strongest} />
        <CityListKpi label="新房最弱" cities={kpiData.weakest} weak />
        <CountTile label="二手房上涨" now={kpiData.secondUpCount} prev={kpiData.secondUpPrev} />
        <CityListKpi label="二手房最强" cities={kpiData.secondStrongest} />
        <CityListKpi label="二手房最弱" cities={kpiData.secondWeakest} weak />
      </div>

      <div className="card">
        <h2>
          {selectedYear}年70城环比上涨城市数量<span className="dot">点击折线上的点定位到下方明细</span>
        </h2>
        <div ref={yearChartRef} className="chart hy" />
      </div>

      <div className="card">
        <div className="hd">
          <h2>
            {selectedYear}年各月环比城市明细<span className="dot">按统计局城市级别划分</span>
          </h2>
          <Seg items={[[false, "仅上涨"], [true, "全部城市"]]} value={showAllCities} onChange={setShowAllCities} />
        </div>
        <div className="tWrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="th-month">月份</th>
                <th className="th-type">类型</th>
                {tierOrder.map((tier) => (
                  <th key={tier} className="th-tier">{tier}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((month) => {
                const mi = months.indexOf(month);
                const isHighlighted = highlightedMonth === mi;
                const getCities = (dataObj, tier) => {
                  const tierCities = cityTiers[tier] || [];
                  const cities = tierCities.filter((c) => dataObj[c]).map((c) => ({ name: c, val: dataObj[c][mi] })).filter((x) => x.val != null);
                  if (!showAllCities) return cities.filter((x) => x.val > 100).sort((a, b) => b.val - a.val);
                  return cities.sort((a, b) => b.val - a.val);
                };
                // 指数 100 = 持平，标签只走涨/平/跌三色
                const renderTags = (cities) => (
                  cities.length > 0 ? (
                    <div className="city-tags">
                      {cities.map(({ name, val }) => (
                        <span key={name} className={`city-tag ${val > 100 ? "tag-up" : val < 100 ? "tag-down" : "tag-flat"}`}>
                          {name}<span className="city-value">{val}</span>
                        </span>
                      ))}
                    </div>
                  ) : <span className="no-city">—</span>
                );
                return [
                  <tr key={`${month}-new`} id={`table-row-${mi}`} className={isHighlighted ? "row-highlighted" : ""}>
                    <td className="td-month" rowSpan={2}>{month}</td>
                    <td className="td-type td-type-new">新房</td>
                    {tierOrder.map((tier) => (<td key={tier} className="td-cities">{renderTags(getCities(newHouse, tier))}</td>))}
                  </tr>,
                  <tr key={`${month}-second`} className={isHighlighted ? "row-highlighted" : ""}>
                    <td className="td-type td-type-second">二手房</td>
                    {tierOrder.map((tier) => (<td key={tier} className="td-cities">{renderTags(getCities(secondHand, tier))}</td>))}
                  </tr>,
                ];
              }).flat()}
            </tbody>
          </table>
        </div>
      </div>
      <p className="note">
        数据来源：国家统计局 · 环比指数以上月=100为基准，&gt;100表示价格上涨 ·
        城市分级采用统计局口径：一线4城、二线31城（省会及计划单列市）、三线35城
      </p>
    </div>
  );
}

export default HousingPage;
