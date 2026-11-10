# Comike

空白全栈项目：TypeScript、Node.js、React、Vite、React Router、Express、
MUI、MySQL 和 Drizzle ORM。

界面仅包含主导航栏以及两个空页面：Home (`/`) 和 Map (`/map`)。
未添加业务内容、示例数据或业务表。
另提供 Preview (`/preview`) 用于查看地图识别结果。

## 地图预览

运行 `npm run dev` 后打开 http://localhost:5173/preview。
选择页数查看原 PDF 提取图、识别图格和 Island 标记叠加，
支持背景、边框、编号、Island 标记独立开关，
以及适应宽度和 50%–200% 缩放；放大后使用滚动条查看细节。

预览读取 `tools/booth-recognition/output/official-map/result.json` 和对应的
`page-NNN.png` 原图，不使用预生成的标注图。首次使用或重新生成数据：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --pages all --output tools\booth-recognition\output\official-map
```

只列出识别输出实际包含的页码；当前示例 PDF 保留了前四页。
数据或图片缺失会显示错误，不会静默绘制空地图；生成后刷新预览页。
颜色表示识别状态，不代表人工核验过的准确率。

React 使用原生 Canvas 2D，无需额外绘图库：
[MapPreviewRenderer](./client/src/preview/MapPreviewRenderer.ts) 管理画布和坐标缩放，
[绘图层](./client/src/preview/layers.ts) 分别封装背景、方框、编号和 Island 标记绘制，
[MapCanvas](./client/src/preview/MapCanvas.tsx) 负责 React 生命周期、图片加载和尺寸变化。
Booth 编号按照原图方向绘制，Island 标签正向显示，所有层使用原图像素坐标，
适配高分屏。Island 已识别标记为紫色；不确定项保留橙色/红色状态。
旧版 Booth-only 结果仍可预览，并明确提示尚无 Island 数据。
步骤 2 的结果会显示页面编号类型、修正/确认数量；标签后的 `*` 表示上下文校正或确认。
仍有边缘截断、方向问题的标记保持待复核，不会因为文字推断成功而清除其他问题。
后端仅通过 `/api/preview/result.json` 和 `/api/preview/page-NNN.png`
提供白名单文件，不暴露工具目录。

## 地图识别工具

独立的 [地图识别模块](./tools/booth-recognition/README.md)
支持 PDF/图片输入，通过 OpenCV 定位方格、PaddleOCR 识别两位数字，
并通过单独的 Island 模块定位彩色编号、识别大小写英文字母及平/片假名。
主脚本通过两个独立阶段流水执行：

1. `OcrRecognitionStep`：调用 Booth 和 Island 模块，保留原始 OCR。
2. `IslandContextRefiner`：统计页面字符，推断大写/小写/平假名/片假名类型，
   根据局部排列和可靠邻居校正疑难项；证据不足时不强行改号。

输出 `step-1.json`（原始结果）和 `result.json`（最终结果），同时保存原图/标注图。
使用 `--ocr-only` 可跳过步骤 2。全程不依赖启动网页或数据库。
当前只识别和校正 Island 标记的位置和文字，
保留重复出现的标记，不自动分配 Booth 所属 Island。

## 开发

需要 Node.js 22.12+ 和 npm。当前使用 tsx 运行后端 TypeScript，以兼容
Node.js 22.12–22.17。
TypeScript 固定在 6.0 系列，以满足当前 typescript-eslint 的兼容范围；
不使用强制安装或忽略 peer dependency 冲突。

```powershell
npm install
npm run dev
```

- 前端：http://localhost:5173
- 后端：http://localhost:3001
- Vite 将 `/api` 代理到后端，无需额外配置 CORS。
- 两个页面共享 MUI Header；当前导航项高亮，支持直接访问及刷新 `/map`。

### VS Code 运行

打开 `comike.code-workspace` 或项目目录，首次使用先执行 `npm install`。
在“运行和调试”中选择 `Comike: Development`，按 F5 启动前后端，
或按 Ctrl+F5 不调试运行。启动配置位于
[.vscode/launch.json](./.vscode/launch.json)，复用根目录的 `npm run dev`。
启动后访问 http://localhost:5173；在启动终端按 Ctrl+C 停止前后端。

## MySQL

空白网页无需数据库即可启动。使用数据库前，先在 MySQL 中创建 `comike`
数据库及具有适当权限的应用用户，然后复制环境变量示例：

```powershell
Copy-Item server\.env.example server\.env
```

编辑 `server/.env` 的 `DATABASE_URL`，替换用户名、密码、主机和数据库名。
用户名和密码中的特殊字符需要 URL 编码。不要提交 `.env`。

Drizzle 连接位于 [server/src/db/index.ts](./server/src/db/index.ts)，
表定义放在 [server/src/db/schema.ts](./server/src/db/schema.ts)。
目前 schema 为空，不会创建任何表。添加表定义后运行：

```powershell
npm run db:generate
npm run db:migrate
npm run db:studio
```

生成的 `server/drizzle` 迁移文件应纳入版本控制。

- `GET /api/health`：应用存活检查。
- `GET /api/health/db`：通过 Drizzle 执行 `SELECT 1`；
  未配置或连接失败返回 HTTP 503，详细错误记录在后端日志中。

## 构建与生产运行

```powershell
npm run build
npm start
```

Express 同时提供构建后的前端静态文件和 API，访问 http://localhost:3001。
生产环境保留 `client/dist`、`server/dist` 和运行依赖；通过环境变量或
`server/.env` 配置端口和数据库。未包含部署或 gateway 配置。
使用地图预览还需保留 `tools/booth-recognition/output/official-map` 下的识别
JSON 和原图；这些生成文件被 Git 忽略，应单独生成或部署。

## 检查

```powershell
npm run typecheck
npm run lint
npm test
```

测试覆盖健康检查、数据库成功/失败、未知 API、SPA 深链接、非法 JSON，
以及预览数据的新旧版本兼容、Island 字符区分与非法坐标/数据拒绝。

当前运行依赖的 `npm audit --omit=dev` 检查无漏洞；开发工具的传递依赖
仍有中等风险提示（Drizzle Kit 的旧 esbuild 和工具链中的 minimatch）。
不要将开发服务器或 Drizzle Studio 暴露到公网，也不要使用
`npm audit fix --force` 强制降级工具链。
