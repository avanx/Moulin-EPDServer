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
