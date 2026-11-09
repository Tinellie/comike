# Comike

空白全栈项目：TypeScript、Node.js、React、Vite、React Router、Express、
MUI、MySQL 和 Drizzle ORM。

界面仅包含主导航栏以及两个空页面：Home (`/`) 和 Map (`/map`)。
未添加业务内容、示例数据或业务表。

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

## 检查

```powershell
npm run typecheck
npm run lint
npm test
```

后端测试覆盖健康检查、数据库成功/失败、未知 API、SPA 深链接和非法 JSON。

当前运行依赖的 `npm audit --omit=dev` 检查无漏洞；开发工具的传递依赖
仍有中等风险提示（Drizzle Kit 的旧 esbuild 和工具链中的 minimatch）。
不要将开发服务器或 Drizzle Studio 暴露到公网，也不要使用
`npm audit fix --force` 强制降级工具链。
