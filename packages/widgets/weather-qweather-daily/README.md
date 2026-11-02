# 四日天气-和风天气组件配置

此组件通过 [和风天气](https://dev.qweather.com/) Web API（JWT / Ed25519）获取 [每日天气预报](https://dev.qweather.com/docs/api/weather/weather-daily-forecast/)，显示**今天及未来三天，共 4 天**的天气图标、天气描述与最高/最低温度。

凭据与 [`weather-qweather`](../weather-qweather/README.md)（实时天气）完全相同，两个组件可以共用同一个私钥密钥、项目 ID 与凭据 ID。尚未配置凭据时，请先按该文档的「准备工作」「生成并保存 Ed25519 密钥」「在和风控制台添加 JWT 凭据」三节完成配置。

## 组件配置

| 配置项 | 说明 |
| --- | --- |
| API Host | 控制台设置中的 Host，如 `xxxx.qweatherapi.com` |
| 项目 ID (sub) | 控制台项目 ID |
| 凭据 ID (kid) | JWT 凭据创建后显示的 ID |
| 私钥密钥 ID 或名称 | 密钥管理中用途为「和风天气」的条目，不要粘贴私钥明文 |
| 地点名称 | 卡片标题显示用（如 `上海`），不会自动根据经纬度改写 |
| 纬度 / 经度 | 查询坐标；和风要求最多两位小数 |
| 温度单位 | 摄氏 / 华氏（本地换算，不影响缓存） |
| 显示语言 | 中文 / English，影响天气描述（如「多云」/ `Cloudy`）与日期标签 |
| 隐藏天气描述 | 开启后只显示图标与温度，不显示「多云」「小雨」等文字；`default` 样式会相应放大图标 |
| 显示外框 | 是否绘制外边框 |
| 更新间隔 | 服务端缓存分钟数，默认 60；每日预报更新频率较低，无需设置太短 |

样式：

- `default`（四日横排，默认 480×220）：每天一列，依次为星期、日期、图标、天气描述、最高温 / 最低温。
- `list`（四日列表，默认 300×280）：每天一行，适合窄长区域。

日期标签统一显示星期：中文为「周X」，英文为 `Mon` 等缩写。

## 实现说明

- 使用 `/v7/weather/7d` 接口：`/v7/weather/3d` 只包含今天起 3 天，不足 4 天。
- 根据响应 `updateTime` 中的时区偏移推算当地「今天」。若缓存数据是前一天获取的（如接口暂时失败而使用过期缓存），会自动跳过已过去的日期，确保第一列始终是今天。
- 使用白天图标 `iconDay`。图标为 [和风天气图标](https://icons.qweather.com/) 官方线稿 SVG，以精简编码内嵌在两个样式的 `style.css`（`BEGIN/END QWEATHER ICONS` 标记段），只包含白天图标，保持在样式编辑器 100 KB 的保存上限以内。更新图标时在本目录执行：

```bash
npm pack qweather-icons@1.8.0
tar -xzf qweather-icons-1.8.0.tgz
node scripts/generate-icons-css.mjs
```

若本目录没有 `package/icons`，脚本会直接从 `../weather-qweather/styles/default/style.css` 中提取已内嵌的图标。布局样式直接改标记段之前的部分即可；脚本只会替换图标段。

## 使用注意

- 修改地点名称、经纬度或语言后，请先 **保存布局**，再 **立即渲染**。
- 私钥等同于 API 身份，勿提交到版本库或分享给他人。
