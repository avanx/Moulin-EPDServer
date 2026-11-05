# 示例组件开发规范

`exmaple` 用于演示 Moulin-EPDServer 组件的目录结构、配置、数据适配和样式实现。

## Mock 数据规范

所有组件都必须支持 Mock 预览，并在 `manifest.json` 中同时提供：

- `"supportsMock": true`
- `mockConfig`：符合组件 `schema.json` 的完整默认配置
- `mockData`：符合 `data.ts` 中 `adaptData` 输入结构的模拟数据对象

即时沙箱会将 `mockData` 交给组件的 `adaptData`，再把适配结果作为 `data` 注入模板。因此，模板中通过 `data.*` 使用的字段必须能由 `adaptData(mockData, mockConfig)` 生成。

```json
{
  "supportsMock": true,
  "mockConfig": {
    "style_id": "default",
    "title": "Daily note",
    "text": "Build small things well.",
    "font_size": 24,
    "inverted": false
  },
  "mockData": {
    "text": "Build small things well."
  }
}
```

Mock 内容应具有代表性，能够清楚展示组件的主要字段、状态和视觉效果。存在多个状态的组件应尽量覆盖不同状态；纯配置驱动且没有数据字段的组件可以使用空对象 `{}` 作为 `mockData`，但仍必须显式声明。

新增或修改组件时，应确认 Mock 数据无需访问外部服务或密钥即可完成即时沙箱和墨水屏测试渲染。

## 外部数据与共享数据源

`exmaple` 本身不请求外部服务，下面以 `weather` 等官方组件为例，说明需要外部数据的组件应当如何编写。

### `fetchData` 与 `adaptData` 的分工

`data.ts` 可以导出两个函数：

- `fetchData(context, config)`：通过 `context.services` 获取**原始数据**并返回。返回值必须可以 JSON 序列化；不要在这里做和显示有关的处理（拼单位、格式化时间、翻译状态等）。
- `adaptData(source, config)`：把原始数据转换成模板使用的 `data.*` 字段。它必须是纯函数，只依赖 `source` 和 `config`，不能发起请求。

`manifest.json` 中的 `mockData` 应该与 `fetchData` 的返回结构保持一致：Mock 预览、共享数据源都会把这种结构的数据直接交给 `adaptData`。

### `externalData` 字段

```json
{
  "externalData": {
    "provider": "open-meteo",
    "cacheSeconds": 900,
    "staleSeconds": 21600,
    "allowedHosts": ["api.open-meteo.com", "air-quality-api.open-meteo.com"],
    "sharedFields": ["latitude", "longitude", "temperature_unit", "cache_minutes"],
    "description": { "zh-CN": "请求 Open-Meteo 天气与空气质量", "en": "Fetches Open-Meteo weather" }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `provider` | 数据提供方标识；部分内置服务（如 `bambuPrinterStatus`、`claudeCodeUsage`）会按它判断是否允许调用 |
| `cacheSeconds` | 默认缓存时长；配置里没有 `cache_minutes` 时作为共享数据源的刷新间隔 |
| `staleSeconds` | 请求失败时，旧数据还能作为兜底显示的时长（数据会带上 `_stale: true`） |
| `secretConfigField` | 哪个配置字段存放密钥 ID / 名称；数据脚本只能读取这一个密钥 |
| `allowedHosts` | `services.request` 允许访问的 HTTPS 域名，支持 `*.example.com` |
| `sharedFields` | 属于“数据源”的配置字段；声明后组件才能绑定共享数据源 |

### `sharedFields` 规则

- 必须包含 `fetchData` 读取的**全部**配置字段，包括 `cache_minutes` 和密钥字段（如 `secret_id`）。漏掉一个字段，绑定后该字段会取组件自己的值，不同屏幕共用的数据就可能不一致。
- 不能包含 `style_id`，也不应包含只影响显示的字段（标题、边框、是否显示某一项等），这些字段仍由每个组件自己配置。
- 列出的字段必须在 `schema.json` 的 `properties` 中存在，否则组件会加载失败。
- 共享数据源的刷新间隔取 `cache_minutes * 60` 秒；没有 `cache_minutes` 时使用 `cacheSeconds`。
- 没有声明 `sharedFields` 的组件只能直接获取数据。

可以这样检查：在 `fetchData` 中搜索 `config.`，把用到的字段都列进去。

### 两种获取方式

| | 直接获取（默认） | 共享数据源 |
| --- | --- | --- |
| 配置 | 全部字段都写在组件里 | `sharedFields` 的值由数据源提供，其余字段写在组件里 |
| 执行 | 每次渲染运行 `fetchData` + `adaptData` | 服务器按需运行一次 `fetchData` 并保存结果，每个组件只运行 `adaptData` |
| 缓存 | 组件内部的 `services.cachedProvider` | 由共享数据源层统一管理；拉取时 `cachedProvider` 只是透传，不读写缓存 |
| 并发 | 多块屏同时刷新且缓存过期时，各自请求 | 同一个数据源同一时刻只发一次请求，其他屏幕等待这次请求的结果 |

所以 `fetchData` 里仍然可以照常调用 `cachedProvider`：直接获取时它负责缓存，共享时它不起作用，组件代码不需要区分这两种情况。
