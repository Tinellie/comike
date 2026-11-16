# Comike

React + Express + MySQL。生产入口：**https://cm.suzutsuki.com**。

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
