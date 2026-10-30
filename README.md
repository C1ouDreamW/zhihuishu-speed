# 智慧树 / 知到 视频倍速脚本

> ⚠️ **实测结论：本脚本无法提升学习进度，按开发失败归档。**
>
> 脚本能正常修改播放速度，但平台侧的进度记账**不按倍速加权**，导致倍速越高进度涨得越慢：
> 2 倍速看完 11:33 的视频只记 39%～50%。详见 [实测结论.md](实测结论.md)。
>
> 代码保留作为逆向分析与调试过程的记录，不建议用于刷课。

针对 `hike.zhihuishu.com/aidedteaching/sourceLearning/sourceLearning`（智慧树新版学习页）以及同平台其它学习页的视频倍速控制脚本。

## 为什么需要它

智慧树播放器在播放过程中会把 `video.playbackRate` 写回自己允许的值，所以「在控制台执行一次 `document.querySelector('video').playbackRate = 2`」通常几秒后就失效了。本脚本通过**在 media 元素实例上重定义 `playbackRate` 属性**把倍速锁死，播放器的写回会被吞掉；同时用原生属性描述符把真实倍速写进底层，保证解码器确实加速。

这一点在实测中成立——倍速确实生效了（实测 2.00x）。失效的是另一端：平台的进度记账。

## 安装

**方式一：油猴 / ScriptCat（推荐）**

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [ScriptCat](https://docs.scriptcat.org/)
2. 新建脚本，把 `zhihuishu-speed.user.js` 全文粘贴进去保存
3. 打开智慧树学习页，页面右上角出现「视频倍速」面板

**方式二：控制台临时用**

打开学习页 → F12 → Console → 粘贴 `zhihuishu-speed.user.js` 全文 → 回车。刷新后失效，需要重新粘贴。

## 使用

| 操作 | 说明 |
| --- | --- |
| 拖动滑块 | 0.25x – 4x 精细调节 |
| 数字框 | 直接输入任意倍速（上限 16x），回车 / 失焦生效 |
| 预设按钮 | 1x / 1.25x / 1.5x / 2x / 3x / 4x / 8x / 16x |
| 「锁定」按钮 | 开：持续压制播放器的倍速回写；关：只写一次，由页面自行控制 |
| 拖动标题栏 | 移动面板位置 |
| `–` 按钮 | 收起为迷你条 |
| 快捷键 `[` / `]` | 减 / 加 0.1x |
| 快捷键 `\` | 复位 1x |

倍速、锁定状态、面板位置都存在 `localStorage`（键名 `zs-speed-config`），刷新后保留。

### 控制台 API

```js
__ZS_SPEED__.set(2)      // 设为 2x
__ZS_SPEED__.get()       // 读取当前设置
__ZS_SPEED__.lock(false) // 关闭锁定（播放器可自行改倍速）
__ZS_SPEED__.reset()     // 复位 1x
__ZS_SPEED__.hide()      // 隐藏面板（show() 恢复）
__ZS_SPEED__.scan()      // 打印页面里所有 video/audio 元素的详情表格
```

**倍速设了没反应？** 先执行 `__ZS_SPEED__.scan()`，看是否找到了视频元素。若表格为空，说明视频在跨域 iframe 里，脚本无法跨域访问 —— 此时把脚本在同一 iframe 的上下文里再跑一次（DevTools 的 frame 选择器切到该 iframe 后粘贴）。

## 实现要点

- **元素查找**：递归遍历同源 iframe 文档，收集所有 `video`/`audio`，按 id 特征 > 有 `currentSrc` > 正在播放 打分排序，对所有候选统一应用倍速，不依赖单一选择器。
  - ⚠️ **已知缺陷**：打分表里的 `'mediaPlayer'`（实际是容器 div）和 `'vjs_container_html5_api'`（旧版 id）都匹配不上当前平台的真实元素 `vjs_mediaPlayer_html5_api`。目前靠通用特征侥幸选中，元素变多时可能选错。
- **倍速锁定**：`Object.defineProperty(media, 'playbackRate', {...})` 遮蔽原型属性，setter 空实现；真实值通过 `HTMLMediaElement.prototype` 上的原生 setter 写入。定义失败时自动退化为每 600ms 轮询纠正。
- **动态元素**：切章节时播放器会重建 `<video>`，`setInterval(tick, 600)` 会接管新元素并重新加锁。
- **UI 隔离**：面板挂在 Shadow DOM 里，`z-index: 2147483647`，不会被学习页的 Element UI 样式污染，也不会遮挡点击（宿主容器 `width:0;height:0`）。

## 测试

`tests/` 下有两个本地验证页，用 headless Chrome 跑：

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu `
  --user-data-dir="$env:TEMP\zs" --virtual-time-budget=11000 --dump-dom `
  'file:///D:/C1ouD/Tool/zhihuishu-fast/tests/scenario.html'
```

- `tests/demo.html`：模拟播放器每 100ms 写回 1.5x，验证锁定生效 / 解锁后立即让行。
- `tests/scenario.html`：动态插入新 video 的接管、预设按钮、快捷键、配置持久化、Shadow DOM 隔离。

已验证结果：锁定状态下页面持续写回 1.5x 不影响 2x/8.1x 生效；解锁后页面写入立即恢复生效。

**注意这些测试只覆盖脚本自身的倍速控制逻辑**，不涉及平台的进度记账——后者正是本项目失败的地方。

## 注意

本项目**未能实现提升学习进度的目标**：平台的进度记账不按倍速加权，倍速越高进度越低（2 倍速约 50%，16 倍速约 6%）。详见 [实测结论.md](实测结论.md)。

高倍速还可能触发平台的反作弊检测（进度异常、任务点校验失败）。代码仅作为逆向分析与调试记录保留。
