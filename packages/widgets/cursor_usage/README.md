# Cursor 用量组件配置

此组件通过 Cursor 登录会话中的 `WorkosCursorSessionToken` 获取当前周期用量。该 Token 等同于登录凭据，请勿分享或提交到版本库。

## 获取并保存 Token

1. 使用浏览器登录 [Cursor Dashboard](https://cursor.com/dashboard)。
2. 按 `F12` 打开开发者工具，切换到 **Network（网络）** 面板。
3. 刷新页面，或进入用量页面以触发请求。
4. 在请求列表中选择一个发往 `cursor.com` 且携带 Cookie 的请求。可优先查找 `get-current-period-usage`。
5. 右键该请求，选择 **Copy（复制） → Copy as cURL (bash)（复制为 cURL (bash)）**。
6. 打开 Moulin-EPDServer 的 **密钥管理** 页面，Purpose 选择 `Cursor Session`。
7. 将完整的 cURL 命令粘贴到“从 cURL (bash) 自动导入”框。页面会自动提取 `WorkosCursorSessionToken` 并填入 **Secret value**。
8. 保存密钥，并记下密钥的名称或 ID。
9. 在 Cursor 用量组件设置中，将该名称或 ID 填入“密钥 ID 或名称”。

如果自动提取失败，请确认复制的请求包含 `WorkosCursorSessionToken` Cookie。cURL 命令通常还包含其他登录信息，使用后请勿保留或转发。
