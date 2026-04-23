# 市场 RSI 热力图 v1.0.1

加密货币与美股多周期 RSI 监控桌面工具，基于 Electron + React 构建。

## 功能特性

### 主界面
- **RSI 热力图**：以气泡图展示所有品种在当前时间框下的 RSI 分布，支持按交易所分类、RSI 区间筛选
- **统计表格**：多周期（15m / 1h / 4h / 1d）RSI 一览，含价格、24h 涨跌幅、综合评分、小火花图
- 列排序（RSI、涨跌幅、综合评分）、品种搜索、置顶、分组筛选
- RSI 变化方向箭头、背离标记（↗ 看涨 / ↘ 看跌）

### 图表（双击行打开）
- K 线图 + RSI 副图
- RSI 均线（SMA / EMA / RMA / WMA）或布林带叠加
- 多周期快速切换

### 提醒系统
- 支持 RSI 阈值、价格突破/跌破、24h 涨跌幅超限、RSI 背离四类条件
- **共振**：勾选后所选周期同时满足时额外触发特殊提醒（★）
- 批量启用 / 禁用规则
- 右下角弹窗通知（含品种名、当前值、触发阈值、实时价格、涨跌幅）
- 提醒记录（按类型 / 品种过滤）
- 推送：Telegram Bot、Discord Webhook

### 品种管理
- 币安现货 / 永续合约 / TradFi 合约一键勾选
- 美股 Ticker 验证后加入观察列表（Yahoo Finance）
- 自定义分组，主界面按组筛选

### 设置
- 刷新间隔、提醒冷却、RSI 参数（周期、超买/超卖阈值）
- RSI 均线类型及参数、布林带倍数
- 静默时段、开机自启、弹窗 / 音效开关
- Telegram / Discord 通知配置与测试

## 技术栈

| 层         | 技术                                      |
|------------|-------------------------------------------|
| 桌面框架   | Electron 28                               |
| 前端       | React 18 + Vite + Zustand                 |
| 图表       | ECharts 5（热力图 + K线 + RSI）           |
| 数据源     | Binance REST API、Yahoo Finance（非官方） |
| 虚拟滚动   | @tanstack/react-virtual                   |
| 打包       | electron-builder（NSIS 安装包）           |

## 安装与使用

### 直接运行安装包

从 [Releases](https://github.com/waruiiko/RSI-inspection/releases) 下载最新 `.exe` 安装包，双击安装即可。

### 开发模式运行

```bash
# 安装依赖
npm install
cd renderer && npm install && cd ..

# 启动开发模式（热重载）
npm run dev
```

### 打包

```bash
npm run dist
# 输出到 dist/ 目录
```

## 数据说明

- **加密货币**：通过 Binance 公开 API 拉取 OHLCV 数据，无需 API Key
- **美股**：通过 Yahoo Finance 非官方接口，仅在美股交易时间内更新
- 所有数据本地计算 RSI，不上传任何数据到服务器

## 配置文件位置

设置、提醒规则、自选列表等均保存在 Electron `userData` 目录（Windows 下为 `%APPDATA%\market-rsi\`），不在项目目录中。

## License

MIT
