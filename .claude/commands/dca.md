---
description: 把新的定投成交（截图或文本）追加进 app/src/data/dca_data.js
---

把用户提供的成交记录追加到 `app/src/data/dca_data.js` 的 `trades` 里。
用户会贴同花顺 App 的「交易记录 / 交割单」截图，或直接打字给几笔。

$ARGUMENTS

## 录入规则

- 每行格式 `["YYYY-MM-DD HH:MM:SS", 数量, 成交价, 费用]`，**卖出数量为负**。
- **按成交时间戳去重**：文件里已有同一时间戳的行就跳过，不要重复追加（用户可能把同一张截图贴两次）。
- **保持时间升序**：正常追加到末尾即可；补录的旧成交要插到正确位置，别只往后堆。
- **费用不用从截图抄**：`费用 = round(|数量| × 成交价 × 0.00005, 2)`（万分之 0.5，四舍五入到分）。
  已对全部历史成交验证过零偏差。抄到的费用若与公式对不上，**先停下来问用户**，别默默改公式——
  说明费率变了（换券商/调佣金），那是要改口径的事。
- 只改 `trades` 数组，别动文件头的注释和 `code`/`name`/`full`。

## 追加完必须核对

跑一遍，把结果念给用户，让他对着 App 页头的数字确认：

```bash
cd app && node -e "
import('./src/data/dca_data.js').then(({DCA})=>{
  const px = Number(process.argv[1]);           // 现价，从截图里读；没有就传最后一笔成交价
  let bought=0, sold=0, shares=0;
  for(const [,q,p,f] of DCA.trades){
    if(q>0) bought += q*p+f; else sold += -q*p-f;
    shares += q;
  }
  const net = bought-sold, val = shares*px;
  console.log('笔数', DCA.trades.length, '持仓', shares);
  console.log('净投入', net.toFixed(2), '摊薄成本', (net/shares).toFixed(4));
  console.log('市值', val.toFixed(2), '总盈亏', (val-net).toFixed(2), ((val/net-1)*100).toFixed(3)+'%');
});
" <现价>
```

口径必须跟 App 一致：**摊薄成本 = 净投入 ÷ 持仓，总盈亏 = 市值 − 净投入，净投入 = 累计买入 − 累计卖出（都含费用）**。
对不上就是抄错了数字，回去核截图；**不要为了对上而改算法**（详见 `CLAUDE.md` 定投记录那段）。

改完不用重跑任何抓取脚本，`update.sh` / CI 都不碰这个文件。
