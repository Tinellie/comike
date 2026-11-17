# Comike

React + Express + MySQL。生产入口：**https://cm.suzutsuki.com**。

社团详情的 Memo 使用当前登录用户导入的备注；未登录或无备注显示短线，列表和地图入口一致。

## Pixiv 作品图片

当前详情页使用渐进加载（需登录）：先查询作品列表中的 `square_medium`，返回列表前显示加载状态。
列表返回后按作品顺序填充格子：数据库索引和磁盘文件均存在时直接使用本地图片，
缺失图片在格子中显示旋转动画，并通过服务器独立转发、逐张显示，不再等待所有图片或使用 Base64 JSON。
即时下载共用 3 并发上限，同一作品的并发请求合并；图片返回浏览器无需等待本地保存，
后台复用同一份下载内容写入原存储路径、补充 `images_pixiv` 索引，保存失败会记录服务端错误，下次仍会尝试修复。
临时转发链接由服务器签名且 15 分钟后过期，过期可重新打开详情；单张加载失败可以点击格子重试。
每次打开均重新查询列表，不受 1 小时批量采集间隔限制；后台缓存不会标记整个账号已经完成批量检查。
关闭详情取消列表请求，已经开始的图片下载与缓存可继续完成；批量采集菜单仍保留。
以下批量采集的检查时间及原子替换规则与即时的逐图缓存分开。

登录后，列表搜索栏右侧的「⋯」可刷新或补全自己收藏的 booth 图片（跨活动，按 Pixiv 账号去重）。
刷新仍遵守 **1 小时**的最小检查间隔；补全仅选择 `pixiv_images_updated_at` 为空的社团。
详情页显示最新 10 个插画/漫画作品的 `square_medium` 方形裁剪缩略图，以 5×2 网格显示，点击可放大，点击图片外或按 Escape 关闭（放大复用当前图片，不请求高清图）。

独立模块位于 `server/src/social/pixiv/`，接口前缀 `/api/social/pixiv`，与 Circle.ms 列表爬虫分开。
通过 **Pixiv App API**（`app-api.pixiv.net`）采集，不再访问首页或网页 AJAX 接口。
需要你合法取得的、对应自己账号的 OAuth 授权，不提供自动登录或提取第三方客户端密钥。
本地在 `server/.env`、Docker 在项目根 `.env` 中配置以下两种方案之一：

```dotenv
# 方案一：只有 access token。到期后需手动更新。
PIXIV_ACCESS_TOKEN=你的OAuth访问令牌

# 方案二：自动刷新，需要同一次授权对应的 refresh token 和客户端凭据。
PIXIV_REFRESH_TOKEN=你的OAuth刷新令牌
PIXIV_CLIENT_ID=对应OAuth客户端ID
PIXIV_CLIENT_SECRET=对应OAuth客户端密钥
```

已有 access token 会优先使用；配置完整刷新凭据时，到期或 HTTP 401 后自动刷新并最多重试一次。
刷新的 access/refresh token 仅保存在服务端内存，不打印到日志、不发送到浏览器；重启后重新读取环境变量。
如果平台撤销或轮换了原 refresh token，重启前需要更新环境变量中的授权数据。
本地修改后完整重启后端；Docker 修改项目根 `.env`（服务器通常是 `/opt/comike/.env`）后执行
`bash deploy/compose.sh up -d --no-deps --force-recreate app`，仅 `restart` 不会加载新的容器环境变量。

用户作品接口分别读取插画和漫画、合并后选择最新 10 个作品，分页时不启用 `for_ios` 内容过滤，
不因作品的 `x_restrict` 标记而在本地删去已获准访问的作品；只下载作品详情 `image_urls.square_medium` 提供的缩略图，不下载其他尺寸或原图。
账号的年龄与内容可见设置需要你自行在 Pixiv 完成，程序不修改或绕过这些限制。
App API 仍可能与网页存在差异，**不承诺永久完全一致**；列表缺项如果是平台静默过滤，只能通过网页对照发现。
明确不可见的作品、缺少 `square_medium`、权限错误或格式异常都会报错，不回退到其他尺寸，不跳过后冒充完整采集，也不退回匿名模式。
离线读取已有图片及 1 小时间隔内的跳过不需要访问 Pixiv；OAuth Token 不会发送到图片 CDN、前端或第三方地址。
所有用户触发的采集共用此服务器账号；已有图片仍可被未登录的网站访问者查看，请只使用愿意在本网站展示其可见内容的账号。
Token 与客户端密钥均为敏感凭据：不要提交 Git、粘贴到聊天或截图分享。
如果浏览器可以访问而 Node 报连接超时，可配置 `PIXIV_PROXY_URL=http://127.0.0.1:7890`
（替换成自己的 HTTP / HTTPS 代理地址），并完整重启后端。Node 不会自动沿用 Windows 系统代理；
此配置仅作用于 Pixiv API 和图片请求，不改变其他服务的网络行为。生产机器直连可达时留空；
Docker 内的 `127.0.0.1` 指容器本身，不能直接使用开发机的代理地址。
若返回 Cloudflare 人机验证页面（例如 HTTP 403、`cf-mitigated: challenge`），表示请求被访问保护拦截，
任务会立即停止，不再对剩余收藏重复请求；
认证失败、返回重定向或非 JSON、HTTP 403 也会停止整个任务。HTTP 429 会显示警告并暂停所有新请求，
每隔 1 分钟用一个请求重试，仍为 429 则继续等待，恢复后自动继续任务；关闭服务会中断等待。
警告中显示本轮限流已重试次数和每秒更新的下次重试倒计时；请求发出后显示正在重试，恢复后清除。
请先检查同一网络出口的访问状态，
遵守平台验证和访问要求，勿连续重试；程序不自动破解或绕过人机验证。
无访问权限、限流、网络或下载错误会明确显示，不能保证获得私密、已删除或受限作品。
请仅采集有权访问和保存的图片，遵守平台条款与作者授权。

### 与同账号网页对照

在网页用与 OAuth 相同的账号，确认内容设置后，记录目标作者最新 10 个作品的 ID（插画与漫画合并；不足 10 个则全部）。
保存为本地 JSON 字符串数组，例如 `["123456789", "123456788"]`，不要包含 Cookie、Token 或网页个人资料。
运行以下只读检查（文件路径相对 `server`，也可用绝对路径）：

```powershell
npm run pixiv:compare -w server -- 目标Pixiv用户ID 参考JSON文件的绝对路径
```

输出网页与 App 的作品 ID 差集；不一致或失败返回非零退出码，不写数据库、不下载图片、不改变 1 小时间隔。
请包含你有权查看的普通作品及限制作品样本，并在同一时间窗口比较；发布/删除作品也可能造成差异。
此检查只核对作品列表；要验证缩略图可下载，仍需成功运行采集并在详情页对照，不能以模拟测试代替真实账号验证。

运行 `npm run db:init` 应用迁移：`booths.pixiv_images_updated_at` 记录最后成功检查时间（包括无新图或空作品列表），
`images_pixiv` 以唯一作品 ID 关联 Pixiv 用户 ID。文件存入 `storage/pixiv/[pixiv_id]/[image_id].[ext]`（使用 `MEDIA_ROOT` 时跟随该根目录）。
首次遇到已有本地图片时，按文件修改时间恢复检查时间及索引；已过 1 小时则继续联网检查。
网络下载全部成功后才替换索引、删除超出最新 10 个作品的文件并更新时间，失败可重新运行菜单任务。
同一 Pixiv 账号的 booth 共用缓存和检查时间；数据库已有但磁盘缺失的图片会在下次允许检查时补下。
Circle.ms 重新采集若更换了 Pixiv 账号，会清空该 booth 的图片检查时间，避免沿用旧账号记录。
全站一次只执行一个后台图片任务，状态按登录用户隔离；重启不恢复任务，已保存图片和数据库记录保留。
每个账号最多同时下载 3 张作品缩略图，不再主动等待固定的 500ms 请求间隔；账号之间仍顺序处理。
保留 1 小时缓存间隔和网络请求超时；遇到 HTTP 429 时按上述规则等待并自动重试。
缩略图按原始响应内容保存，不做本地压缩或缩放；保留 20 MiB 下载安全上限及图片格式检查。
超出安全上限或格式异常会明确报错，不覆盖该账号的旧缓存。

## 本地

Node.js 22、MySQL 8.4。复制 `server/.env.example` 为 `server/.env` 并填写数据库：

```powershell
npm ci
npm run db:init
npm run dev
```

可选 PDF OCR：Python 3.10–3.12，创建 `tools\booth-recognition\.venv`，用该环境安装同目录 `requirements.txt`，
然后运行：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py ref\official-map.pdf --pages all --output tools\booth-recognition\output\official-map
```

测试：`npm test`；检查：`npm run typecheck`、`npm run lint`、`npm run build`。

## 1. GitHub 准备

仓库示例为 `Tinellie/comike`。先创建仓库并提交代码；若已配置 origin，跳过 `git remote add`：

```powershell
git remote add origin git@github.com:Tinellie/comike.git
git push -u origin HEAD
```

[Actions](.github/workflows/deploy.yml) 会测试、构建 amd64 镜像并发布到 `ghcr.io/tinellie/comike`。
初次不自动部署；服务器和数据就绪后再设置仓库变量 `DEPLOY_ENABLED=true`。

创建 `production` Environment；在仓库 Actions Secrets 设置：

| Secret | 内容 |
|---|---|
| `VULTR_SSH_KEY` | Actions 连接 deploy 用户的私钥，可用现有 `vultr_deploy`，建议单独授权一把部署密钥 |
| `VULTR_SSH_PASSPHRASE` | 上述私钥口令，无则不填 |
| `VULTR_HOST_FINGERPRINT` | 当前 SSH Action 使用 ECDSA；从可信 SSH 会话执行 `ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub`，填写 `SHA256:...` 字段 |

公开仓库可通过 HTTPS 克隆；公开 GHCR 镜像不需要服务器登录。
私有仓库须授予服务器 GitHub **读取权限**，私有镜像还需要 `read:packages` 权限。
服务器读取 GitHub 的密钥与 Actions 登录服务器的密钥是不同方向，不要混淆。

## 2. 服务器准备

Ubuntu 24.04 已安装 Docker/Compose，已有 `gateway` 网络和 `/opt/site-gateway`。SSH 登录：

```powershell
ssh -i "$env:USERPROFILE\.ssh\vultr_deploy" deploy@139.180.203.201
```

以下在服务器执行；不停止旧站，不修改现有数据库：

```bash
sudo install -d -o deploy -g deploy -m 750 /opt/comike
git clone https://github.com/Tinellie/comike.git /opt/comike
cd /opt/comike
umask 077
cp .env.example .env
nano .env
```

分别用 `openssl rand -hex 32` 生成两份密码填入 `.env`；UID/GID 填 `id -u` / `id -g`（当前均为 1001）。
私有镜像需先 `docker login ghcr.io -u Tinellie`，提示时输入具有 `read:packages` 的 Token。

```bash
mkdir -p data/storage data/map data/ref data/state backups/incoming
bash deploy/compose.sh config --quiet
bash deploy/compose.sh pull app db
```

数据库无公网端口；仅应用加入网关网络，别名 `comike-web:3001`。
容器仅信任一层 Caddy 转发以保留真实 IP 限流；不要另行暴露应用端口。
数据位于 `data/` 和独立 Docker 卷 `comike_mysql_data`，不要执行 `down -v`。
当前服务器仅 2 GB 内存、剩余约 15 GB 磁盘：默认不安装 PDF OCR，避免同时运行多个导入/爬虫，建议升级至至少 4 GB 并监控磁盘。

## 3. 迁移本地数据

暂停本地爬虫/写操作，确保已安装与本地数据库同主版本的 **MySQL 客户端**（`mysqldump`）与 `tar`。
在本地仓库执行：

```powershell
# 若 mysqldump 不在 PATH，指定实际路径：
$env:MYSQLDUMP_PATH = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe'
node deploy\export-local.mjs
scp -i "$env:USERPROFILE\.ssh\vultr_deploy" .\backups\export-实际时间\* deploy@139.180.203.201:/opt/comike/backups/incoming/
```

导出数据库（包含用户/收藏）、摊位图片、地图识别结果和地图变换；**不上传 Circle.ms 登录状态**。
导出含私密用户数据，只通过 SSH 传输，勿提交 Git 或公开发布。

回到服务器：

```bash
cd /opt/comike
CONFIRM_RESTORE=comike bash deploy/restore.sh backups/incoming
IMAGE="ghcr.io/tinellie/comike:$(git rev-parse HEAD)"
docker pull "$IMAGE"
DIGEST="$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}')"
bash deploy/deploy.sh "$DIGEST"
```

首次部署会补齐参考文件、执行数据库迁移、检查 Chromium 并等待应用健康。
注册新账号后可授予管理员；已迁移的管理员权限保留：

```bash
bash deploy/compose.sh exec app node deploy/entrypoint.mjs admin 账号 grant
```

## 4. 切换域名与网关

DNS 的 `cm` A 记录指向 `139.180.203.201`；没有配置对应 IPv6 时移除错误的 AAAA。
开放 TCP 80/443（HTTP/3 可选 UDP 443），建议 DNS-only。
若启用 Cloudflare 代理，使用 Full (strict)，并先在 Caddy 配置 Cloudflare 可信代理网段以保留真实客户端 IP。

先确认新应用可达：

```bash
cd /opt/site-gateway
docker compose exec -T caddy wget -qO- http://comike-web:3001/api/health/db
```

再提交并推送 **gateway 项目**的 Caddyfile 修改，由其原有 Action 更新：
`cm.suzutsuki.com` → `comike-web:3001`，**`cm-old.suzutsuki.com` 仍保留旧站**。
不要先切网关，也不要停止旧容器。

```bash
curl -fsS https://cm.suzutsuki.com/api/health/db
curl -I https://cm-old.suzutsuki.com
```

验证后设置 `DEPLOY_ENABLED=true`；以后推送 main/master 自动更新，使用不可变镜像 digest。

## 运维

命令在 `/opt/comike` 执行：

```bash
bash deploy/compose.sh ps
bash deploy/compose.sh logs --tail=100 app
bash deploy/compose.sh stop app
bash deploy/backup.sh full
bash deploy/compose.sh start app
# 回退应用镜像（不会回退数据库）：
PREVIOUS="$(sed -n 's/^COMIKE_IMAGE=//p' .release.env.previous)"
bash deploy/deploy.sh "$PREVIOUS"
```

更新前自动备份数据库；失败尝试启动上一应用镜像，但**不会自动降级数据库结构**。
完整备份先停止 app，执行 `backup.sh full` 后再启动，避免爬虫写入导致文件/数据库不一致；定期把备份复制到服务器之外。
完整备份包含浏览器登录状态，应按私密凭据保管；另行安全保存 `.env`。
勿对整台服务器执行全局 Docker 清理，旧站及其他项目共用此 Docker。

可选完整 OCR：先升级资源（建议至少 4–8 GB 内存并预留更多磁盘），设置仓库变量 `DOCKER_TARGET=ocr`；
在服务器 `.env` 增加 `COMPOSE_FILE=compose.yaml:compose.ocr.yaml`，重新运行 Action。
首次 OCR 需要联网下载模型，缓存保存在 `data/state`；默认轻量镜像仍支持 Preview 查看、收藏导入及管理员爬虫。
