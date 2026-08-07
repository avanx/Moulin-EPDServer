# ESP32 设备接口与数据格式约定

本文档描述 ESP32 设备从 Moulin-EPDServer 拉取电子墨水屏画面的协议。当前设备接口只提供读取能力，采用 HTTP(S) + JSON 清单 + 未压缩二进制帧文件。服务端不提供 WebSocket 推送，也没有设备状态、遥测或图像上传接口，设备必须主动轮询。

## 1. 基本约定

- API 根地址示例：`https://epd.example.com`
- 屏幕 ID：管理端创建屏幕后获得的 UUID，以下记为 `{screen_id}`
- API Key：管理端为对应屏幕生成，格式类似 `epd_...`
- 所有设备请求都必须携带请求头：

```http
X-API-Key: <该屏幕的 API Key>
```

- API Key 只能访问它绑定的屏幕，缺失、错误、已撤销或与屏幕不匹配均返回 `401 Unauthorized`
- 单个有效 API Key 最多允许每分钟 120 次设备请求，超出返回 `429 Too Many Requests`
- 建议生产环境只通过 HTTPS 访问，避免 API Key 和画面数据以明文传输
- ESP32 应将服务器地址、`screen_id`、API Key 和最后成功应用的 `snapshot_id` 持久化

## 2. 推荐拉取流程

1. 请求清单：

   ```http
   GET /api/v1/device/screens/{screen_id}/manifest
   X-API-Key: <api_key>
   ```

2. 首次启动或本地没有可靠基线时，不传 `base_snapshot_id`，按清单中的 `frame_url` 下载并应用全量帧。
3. 已成功显示过快照时，在后续请求中传入本地快照 ID：

   ```http
   GET /api/v1/device/screens/{screen_id}/manifest?base_snapshot_id={local_snapshot_id}
   X-API-Key: <api_key>
   ```

4. 根据返回结果处理：
   - `304`：画面没有变化，不下载数据。
   - `200` 且 `update_type` 为 `full`：下载 `frame_url` 并替换整个画面。
   - `200` 且 `update_type` 为 `partial`：按 `regions` 数组顺序下载并应用全部区域；每个区域文件为 `[old][new]` 双平面，分别写入控制器旧/新缓冲后再局部刷新。
5. 下载完成后校验字节数和 SHA-256。
6. 只有在完整下载、校验且成功刷新屏幕后，才把本地快照 ID 更新为清单中的 `snapshot_id`。
7. 任一步骤失败时保留原来的本地快照 ID。下次继续以旧 ID 请求，服务端会重新给出可用的局部更新，或自动回退到全量帧。
8. 等待 `refresh_after_seconds` 后再次轮询。发生网络错误或 `5xx` 时应采用退避重试，避免高频请求。

也可以使用清单响应的 `ETag` 进行条件请求：

```http
If-None-Match: "<snapshot_id>"
```

`If-None-Match` 与当前快照匹配时同样返回 `304`。设备只需选择 `base_snapshot_id` 或 `If-None-Match` 中的一种；需要局部更新时应优先使用 `base_snapshot_id`。

## 3. 获取更新清单

### 请求

```http
GET /api/v1/device/screens/{screen_id}/manifest
GET /api/v1/device/screens/{screen_id}/manifest?base_snapshot_id={snapshot_id}
```

请求头：

```http
X-API-Key: <api_key>
Accept: application/json
```

可选参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `base_snapshot_id` | string | ESP32 当前已经完整应用的快照 ID |

### `200 OK` 响应

```json
{
  "screen_id": "2f8fce90-35ce-4b9e-a24d-cc47769b2fe8",
  "snapshot_id": "9bdcb530-46c4-4bbf-b75e-41b23d19208e",
  "base_snapshot_id": "74c151be-ed26-46b9-9152-ccf1552f5793",
  "update_type": "partial",
  "width": 800,
  "height": 480,
  "color_mode": "bw",
  "panel_layout": "dual-panel-left-right",
  "encoding": "epd-bw-msb-v1",
  "refresh_after_seconds": 900,
  "byte_size": 48000,
  "sha256": "64位小写十六进制字符串",
  "frame_url": "https://epd.example.com/api/v1/device/screens/2f8fce90-35ce-4b9e-a24d-cc47769b2fe8/snapshots/9bdcb530-46c4-4bbf-b75e-41b23d19208e/frame",
  "regions": [
    {
      "id": "a23c2e31-eb9d-480d-9806-b00e13e24164",
      "x": 120,
      "y": 64,
      "width": 256,
      "height": 80,
      "stride": 32,
      "plane_byte_size": 2560,
      "byte_size": 5120,
      "sha256": "64位小写十六进制字符串",
      "url": "https://epd.example.com/api/v1/device/screens/2f8fce90-35ce-4b9e-a24d-cc47769b2fe8/snapshots/9bdcb530-46c4-4bbf-b75e-41b23d19208e/regions/a23c2e31-eb9d-480d-9806-b00e13e24164"
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `screen_id` | string | 当前屏幕 ID |
| `snapshot_id` | string | 目标快照 ID；成功应用更新后持久化此值 |
| `base_snapshot_id` | string/null | 该局部快照依赖的基线；全量更新时通常为 `null` |
| `update_type` | `"full"`/`"partial"` | 本次应执行全量更新还是局部更新 |
| `width`、`height` | integer | 完整画面的像素尺寸 |
| `color_mode` | `"bw"`/`"bwry"` | 黑白或黑白红黄模式 |
| `panel_layout` | `"linear"`/`"dual-panel-left-right"` | 像素流的面板排列方式；对 `bw` 编码不产生影响 |
| `encoding` | string | 二进制编码，见“像素数据格式” |
| `refresh_after_seconds` | integer | 建议的下一次轮询间隔 |
| `byte_size` | integer | 完整帧的字节数，即使本次为局部更新也仍描述完整帧 |
| `sha256` | string | 完整帧的 SHA-256，即使本次为局部更新也仍描述完整帧 |
| `frame_url` | string | 完整帧绝对 URL，可用于局部更新失败后的全量回退 |
| `regions` | array | 局部区域列表；全量更新时为空数组 |

局部区域字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 区域 ID |
| `x`、`y` | integer | 区域左上角在完整画面中的像素坐标 |
| `width`、`height` | integer | 区域像素尺寸 |
| `stride` | integer | 每行字节数，等于 `ceil(width / 8)` |
| `plane_byte_size` | integer | 单平面（old 或 new）字节数，等于 `stride * height` |
| `byte_size` | integer | 区域二进制文件总字节数，等于 `2 * plane_byte_size`（先 old 后 new） |
| `sha256` | string | 区域文件（含 old+new 整包）的 SHA-256 |
| `url` | string | 区域文件绝对 URL |

当前服务端只对 `bw` 黑白屏生成局部更新。只有设备提交的 `base_snapshot_id` 与目标快照要求的基线完全一致时，服务端才返回 `partial`；其余情况自动返回 `full`。服务端按组件矩形拆分脏区（外加组件外残留），仅在画面尺寸一致、确有像素变化且各局部区域合计面积不超过整屏 35% 时生成一个或多个局部区域，否则生成全量更新。

客户端应按 `regions` 数组顺序下载并应用全部区域；不要假设每个快照只有一个局部区域。

### `304 Not Modified` 响应

无响应体。以下任一条件满足时返回：

- `base_snapshot_id` 等于服务器当前 `snapshot_id`
- `If-None-Match` 等于服务器当前 `snapshot_id`

响应包含：

```http
ETag: "<snapshot_id>"
Cache-Control: private, no-cache
```

### 清单错误响应

| 状态码 | 含义 |
| --- | --- |
| `401` | API Key 缺失、无效、已撤销或不属于该屏幕 |
| `404` | 屏幕不存在、已禁用或尚无可用快照 |
| `429` | 超过每分钟 120 次的设备请求限制 |

屏幕已禁用或尚无快照时，当前响应示例为：

```json
{
  "detail": "No snapshot available"
}
```

设备逻辑不应依赖错误响应一定包含 `detail` 字段。

## 4. 下载完整帧

### 请求

通常直接使用清单中的 `frame_url`：

```http
GET /api/v1/device/screens/{screen_id}/snapshots/{snapshot_id}/frame
X-API-Key: <api_key>
```

### 成功响应

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: <完整帧字节数>
Content-Disposition: attachment; filename="<snapshot_id>.bin"
ETag: "<完整帧 SHA-256>"
X-Content-SHA256: <完整帧 SHA-256>
Cache-Control: private, immutable, max-age=31536000
Accept-Ranges: bytes
```

响应体是不带文件头、宽高、调色板或压缩层的原始像素数据，必须结合清单中的尺寸、颜色模式和编码解释。

## 5. 下载局部区域

### 请求

通常直接使用 `regions[].url`：

```http
GET /api/v1/device/screens/{screen_id}/snapshots/{snapshot_id}/regions/{region_id}
X-API-Key: <api_key>
```

响应头与完整帧相同，`X-Content-SHA256` 和 `ETag` 对应当前区域文件。响应体采用 `epd-bw-msb-v1` 编码，按以下顺序连续拼接两个平面：

1. **old 平面**：基线快照在该区域的像素，长度 `plane_byte_size`
2. **new 平面**：目标快照在该区域的像素，长度 `plane_byte_size`

每个平面都是区域自身从 `(0, 0)` 开始、逐行排列的数据；总长度等于 `byte_size = 2 * plane_byte_size`。显示坐标使用清单中的 `(x, y, width, height)`。

该布局是为差分局部刷新准备的：设备可直接把 old 平面写入控制器的旧数据缓冲（如命令 `0x14`），把 new 平面写入新数据缓冲（如命令 `0x15`），再触发局部刷新，无需在设备端保存整帧基线再自行裁剪。

局部更新的横向边界会尽量对齐到 8 像素，便于逐字节写入。设备仍应以清单给出的 `width`、`stride` 和 `plane_byte_size` 为准，不要自行推导固定区域大小。

拆分示例：

```cpp
size_t plane = region.planeByteSize; // == stride * height
const uint8_t* oldPlane = regionBin;
const uint8_t* newPlane = regionBin + plane;
// write oldPlane via 0x14, newPlane via 0x15, then 0x16 refresh
```

## 6. HTTP Range 断点续传

完整帧和局部区域接口都支持单段字节范围：

```http
Range: bytes=<start>-<end>
Range: bytes=<start>-
Range: bytes=-<suffix_length>
```

有效范围返回：

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes <start>-<end>/<total_size>
Content-Length: <本段字节数>
X-Content-SHA256: <完整文件 SHA-256>
```

无效范围返回 `416 Range Not Satisfiable`，并包含：

```http
Content-Range: bytes */<total_size>
```

`X-Content-SHA256` 始终是整个帧文件或整个区域文件的摘要，不是当前 Range 分段的摘要。ESP32 必须先按偏移拼接完整文件，再计算 SHA-256。

服务端快照文件内容不可变，但历史快照会按保留策略清理（默认保留 3 份），因此缓存中的旧 URL 不保证永久可下载。遇到 `404` 时应重新请求清单。

## 7. 像素数据格式

### 7.1 `epd-bw-msb-v1`

适用于 `color_mode = "bw"`，每像素 1 bit：

- `0`：白色
- `1`：黑色
- 行优先，从上到下排列
- 每行从左到右
- 每字节最高位对应最左侧像素，即 MSB-first
- 每行步长为 `ceil(width / 8)` 字节
- 一行末尾不足 8 像素时，低位补 `0`，即补白色
- 总字节数为 `ceil(width / 8) * height`

一个字节 `0b10110000` 表示从左到右的前 8 个像素为：

```text
黑 白 黑 黑 白 白 白 白
```

像素 `(x, y)` 的读取方式：

```cpp
size_t stride = (width + 7) / 8;
uint8_t value = data[y * stride + x / 8];
bool isBlack = (value & (0x80 >> (x % 8))) != 0;
```

### 7.2 `edp-bwry-v1`

适用于 `color_mode = "bwry"`，每像素 2 bit：

| 二进制值 | 颜色 |
| --- | --- |
| `00` | 白 |
| `01` | 黄 |
| `10` | 红 |
| `11` | 黑 |

每个字节存放 4 个像素，最高 2 bit 对应第一个像素：

```text
bit 7..6 = 像素 0
bit 5..4 = 像素 1
bit 3..2 = 像素 2
bit 1..0 = 像素 3
```

当 `panel_layout = "linear"` 时，按整幅图像行优先的像素序列连续打包，总字节数为 `ceil(width * height / 4)`。当一行宽度不是 4 的倍数时，下一行可能接续在同一字节中，客户端不应假定每行独立字节对齐。

#### 左右双面板顺序

当 `panel_layout = "dual-panel-left-right"` 时，屏幕宽度必须是偶数。服务端将画面等分为左右两个面板，每个面板独立进行 2bpp 打包，再按以下顺序拼接：

1. 左半屏的全部行
2. 右半屏的全部行

令 `panel_width = width / 2`，每块面板占用：

```text
panel_byte_size = ceil(panel_width * height / 4)
```

完整帧占用 `2 * panel_byte_size` 字节。每块面板末尾不足 4 像素时独立补 `00`（白色），所以右面板总是从新的字节边界开始。

对于 1360 × 480 屏幕，单块面板为 680 × 480、占 81600 字节，完整帧为 163200 字节。已有 1360 × 480 屏幕会在数据库升级时一次性迁移为 `dual-panel-left-right`，其他已有屏幕迁移为 `linear`；新建屏幕时必须显式选择布局。

## 8. 完整性与状态提交

SHA-256 以原始二进制响应体为输入，结果表示为 64 个小写十六进制字符。推荐校验顺序：

1. HTTP 状态必须是预期的 `200` 或 `206`
2. 收齐的数据长度必须等于清单中的 `byte_size`
3. 计算 SHA-256，并与清单字段及 `X-Content-SHA256` 比较
4. 将数据成功写入显示控制器
5. 持久化新的 `snapshot_id`

局部更新时，应分别使用每个 `regions[].byte_size` 和 `regions[].sha256` 校验**整包**区域文件（含 old+new）。校验通过后再按 `plane_byte_size` 拆成两个平面分别写入控制器。清单顶层的 `byte_size` 和 `sha256` 只用于完整帧，不能用于校验区域文件。

为防止断电造成“快照 ID 已更新但屏幕内容未更新”，建议把待提交的 `snapshot_id` 与当前有效 `snapshot_id` 分开保存，仅在刷新调用成功后原子替换当前值。

## 9. ESP32 端处理伪代码

```cpp
void pollDisplay() {
  Manifest manifest;
  int status = getManifest(savedSnapshotId, manifest);

  if (status == 304) {
    sleepSeconds(configuredRefreshInterval);
    return;
  }
  if (status != 200) {
    retryWithBackoff();
    return;
  }

  bool applied = false;
  if (manifest.updateType == "partial" &&
      manifest.baseSnapshotId == savedSnapshotId) {
    applied = downloadVerifyAndApplyAllRegions(manifest.regions);
  } else {
    applied = downloadVerifyAndApplyFullFrame(
      manifest.frameUrl,
      manifest.byteSize,
      manifest.sha256,
      manifest.encoding,
      manifest.width,
      manifest.height
    );
  }

  if (applied) {
    saveSnapshotIdAtomically(manifest.snapshotId);
  }
  sleepSeconds(manifest.refreshAfterSeconds);
}
```

如果局部下载或应用失败，可以立即尝试清单中同一快照的 `frame_url` 做全量回退；全量刷新仍失败时，不得保存新的 `snapshot_id`。
