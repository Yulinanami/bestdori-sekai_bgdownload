# Bestdori & Sekai背景图下载器🎸

从 [Bestdori](https://bestdori.com) 和 [Sekai Viewer](https://sekai.best/asset_viewer/scenario/background) 批量下载背景图（PNG 格式）。

## 运行环境
- Node.js 18+

## 使用方法

### 安装依赖

```bash
npm install
```

### 启动下载

```bash
node download.js
```

图片分别保存在 `bg/bestdori/` 和 `bg/sekai/` 目录下。

## 配置

编辑对应模块文件即可修改参数：

| 参数                  | 默认值 | 文件              | 说明                       |
| --------------------- | ------ | ----------------- | -------------------------- |
| `CONCURRENCY`         | 8      | `src/common.js`   | 下载并发数                 |
| `MAX_RETRIES`         | 5      | `src/common.js`   | 单文件最大重试次数         |
| `RETRY_FAILED_ROUNDS` | 5      | `src/common.js`   | 失败文件补重试轮数         |
| `DEFAULT_START`       | 0      | `src/bestdori.js` | Bestdori 默认起始 scenario |
| `DEFAULT_END`         | 391    | `src/bestdori.js` | Bestdori 默认结束 scenario |

## 项目结构

```
├── download.js          # 主入口（选择下载源）
├── src/
│   ├── common.js        # 共用工具（下载引擎、进度条、重试）
│   ├── bestdori.js      # Bestdori 下载逻辑
│   └── sekai.js         # Sekai 下载逻辑
└── bg/
    ├── bestdori/        # Bestdori 背景图输出
    └── sekai/           # Sekai 背景图输出
```

## 技术栈

- [axios](https://github.com/axios/axios) — HTTP 请求
- [cli-progress](https://github.com/npkgz/cli-progress) — 终端进度条
- [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) — S3 XML 响应解析（Sekai）

## 📄 许可证

MIT License
