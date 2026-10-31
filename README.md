# 智慧树 / 知到 学习脚本

针对 `hike.zhihuishu.com/aidedteaching/sourceLearning/sourceLearning`（智慧树新版学习页）。

---

## 脚本一：自动播放 + 播完切换（推荐）

文件：`zhihuishu-auto.user.js`

自动播放当前学习页视频，播完后自动切换到下一个未学完的视频。所有操作带随机延迟抖动。

### 安装

安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [ScriptCat](https://docs.scriptcat.org/)，新建脚本，粘贴 `zhihuishu-auto.user.js` 全文保存。刷新学习页，右上角出现面板。

### 功能

| 功能 | 说明 |
| --- | --- |
| 自动播放 | 页面加载后随机延迟 3–12 秒开始播放 |
| 自动切换 | 视频播完后随机等待 2–7 秒（留给平台上报），自动跳到下一个未完成视频 |
| 跳过已完成 | 检测 `.status-box` 里的完成图标，跳过已学完的 |
| 跳过非视频 | 只处理视频资源（`i.icon-video`），文档/作业等自动忽略 |
| 自动恢复 | 视频被暂停（弹窗、缓冲、网络）后自动恢复播放 |
| 随机停顿 | 每轮 5% 概率暂停 4–14 秒，模拟真人分心（可关闭） |

### 随机化设计

防止被检测的关键在于**所有时间间隔都不固定**：

- 进入页面后开始播放的延迟：3–12 秒随机
- 播完后切换的延迟：2–7 秒随机
- 恢复播放的延迟：1.2–4 秒随机
- 主循环间隔：1.8–3.6 秒随机
- 所有区间额外叠加 ±22%–35% 抖动
- 偶发随机停顿（可关闭）
- 点击模拟带坐标偏移（0.32–0.68 比例），用完整指针事件序列

### 控制台 API

```js
__ZS_AUTO__.start()   // 开始
__ZS_AUTO__.stop()    // 暂停
__ZS_AUTO__.next()    // 查看下一个目标视频
__ZS_AUTO__.getState() // 当前状态和文件列表
__ZS_AUTO__.cfg.wander = false  // 关闭随机停顿
```

配置存 `localStorage`（键名 `zs-auto-cfg`），刷新后保留。

### 测试

```powershell
# 需要先生成 3 秒测试视频
node tests\run-real.js auto.html 12000          # 主场景：自动播放 + 切换
node tests\run-real.js auto-resume.html 13000   # 打断恢复 + 切换
node tests\run-real.js random.html 3000         # 随机性分布
```

已验证：自动播放、自动切换、跳过已完成/非视频、连续打断后快速恢复、随机延迟均匀。

---

## 脚本二：视频倍速（已归档，无法提升进度）

> ⚠️ **实测结论：倍速无法提升学习进度。**
>
> 脚本能正常修改播放速度，但平台的进度记账**不按倍速加权**，倍速越高进度涨得越慢：
> 2 倍速看完 11:33 的视频只记 39%～50%。详见 [实测结论.md](实测结论.md)。

文件：`zhihuishu-speed.user.js`

通过在 media 元素实例上重定义 `playbackRate` 属性把倍速锁死。倍速本身生效（实测 2.00x），但平台的 `studyTotalTime` 恒等于真实流逝时间，不乘倍速因子。

代码保留作为逆向分析记录。详见 [进度逻辑分析.md](进度逻辑分析.md)。

---

## 逆向分析工具

| 工具 | 用途 |
| --- | --- |
| `decode_full.js` | 反混淆 `newVideoPlay.js`，导出全部明文字符串 |
| `decode_region.js` | 按标记解码指定区域 |
| `analyze_records.js` | 核算上报记录的倍速加权，判断是否生效 |

```bash
node decode_full.js                      # 下载 + 反混淆
node decode_region.js "function _0x773bf3"   # 解码指定函数
node analyze_records.js records.json      # 核算自己的上报数据
```
