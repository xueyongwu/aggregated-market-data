// echarts 按需引入 —— 只注册本项目真正用到的图表和组件，避免全量打包（全量约 1MB）。
//
// 加新图表时，如果 option 里出现这里没注册的功能，echarts 不会报错，而是静默不渲染
// 那部分（比如 markLine 不画线、dataZoom 不出现）。遇到"配置写了但没效果"，先回来看这里有没有漏注册。
import * as echarts from "echarts/core";
import { BarChart, LineChart, CandlestickChart } from "echarts/charts";
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomInsideComponent, // 房价全时段柱状图 / 纳指日K 的 dataZoom: [{ type: "inside" }]
  MarkLineComponent, // 零轴、昨收线、年份分隔线、午间分隔线
  AxisPointerComponent, // 分时图的十字线 axisPointer: { type: "cross" }
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  CandlestickChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomInsideComponent,
  MarkLineComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

export { echarts };
