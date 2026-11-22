# Comike

React + Express + MySQL。生产入口：**https://cm.suzutsuki.com**。

列表右侧操作面板支持修改个人收藏：颜色即时保存，Memo 失焦自动保存；取消收藏仅清除颜色并保留备注。
未改动的值不发送保存请求；编辑后先更新本地列表，再异步保存，关闭面板不重新加载列表。保存失败保留本地修改并提示重试。
仅管理员可在面板内编辑公共 Circle.ms / Pixiv / Twitter ID，按 Enter 或点击保存生效。重新导入收藏会以导入结果覆盖个人收藏和备注。

社团详情的 Memo 使用当前登录用户导入的备注；未登录或无备注显示短线，列表和地图入口一致。

## Pixiv 作品图片

详情页先读取本地最新图片及列表刷新状态，填充网格；只有确认需要重新检测列表后，
才在获取最新列表期间显示顶部扁加载条，避免命中缓存时闪现。读取本地状态期间不显示加载条，
有效列表缓存的读取与缺图补下也不显示列表加载条。已有图片保持展示，列表未变不重载已有图片，
有更新才按新顺序替换网格；Pixiv 网格仍只获取 `square_medium` 缩略图。
Twitter / Pixiv 标题与网格之间保留固定间隔，加载条出现或消失不改变内容位置。
没有本地图片时网格不占高度，首张图片加载成功后才展开；加载失败仍提供重试提示。
最新列表中的作品已有磁盘文件时直接使用本地图片，
缺失图片在格子中显示旋转动画，并通过服务器独立转发、逐张显示，不再等待所有图片或使用 Base64 JSON。
即时下载共用 3 并发上限，同一作品的并发请求合并；图片返回浏览器无需等待本地保存，
列表成功同步后替换 `images_pixiv` 索引，后台复用同一份下载内容写入原存储路径，
本地读取只展示索引中已有文件的图片。保存失败会记录服务端错误，下次仍会尝试修复。
临时转发链接由服务器签名且 15 分钟后过期，过期可重新打开详情；单张加载失败可以点击格子重试。
登录后详情与批量刷新共用按平台 / 作者区分的列表缓存，取消原来的 1 小时批量间隔；
距上次成功检测**超过 10 分钟**才重新获取列表，恰好 10 分钟仍复用缓存，读取缓存不延长检测时间。
列表、图片地址及检测时间保存在 `social_image_lists`，空列表也缓存，重启后继续生效。
同一作者的并发列表请求合并；列表请求失败不更新时间，下次可重试。未登录只读取本地图片。
10 分钟内仍会比较已有列表与本地文件，缺失图片可补下，不必再次获取列表。
同步列表失败时保留已显示的本地图片并提示错误；成功的空列表会清空展示及最新索引。
即时同步不删除旧文件，避免影响其他已打开的详情页；后台缓存不会标记整个账号已经完成批量检查。
关闭详情取消前端等待，已共享的列表请求、图片下载与缓存可继续完成；批量采集菜单仍保留。
以下批量采集的检查时间及原子替换规则与即时的逐图缓存分开。

登录后，列表搜索栏右侧的「⋯」可刷新或补全自己收藏的 booth 图片（跨活动，按 Pixiv 账号去重）。
刷新与详情共用上述 **10 分钟**列表检测间隔；补全仅选择 `pixiv_images_updated_at` 为空的社团。
详情页显示最新 10 个插画/漫画作品的 `square_medium` 方形裁剪缩略图，以 5×2 网格显示。
Twitter / Pixiv 登录后点击图片，先显示现有缩略图，再按需通过服务器获取 `large` 大图并替换，加载失败保留缩略图并提供重试；
未登录仍只放大本地缩略图。点击图片外或按 Escape 关闭，关闭时取消大图请求并释放浏览器临时图片。
大图不预加载、不写入服务器磁盘，响应使用 `private, no-store`；仅弹窗打开期间保留浏览器内存中的图片。
Pixiv 使用作品详情 `image_urls.large`（多页作品对应第一页）；Twitter 照片使用 `name=large`，视频 / GIF 封面使用 `:large`，不下载视频。
不回退到原图；大图仍受 CDN 域名、作品归属、图片格式及 20 MiB 下载上限检查，超过上限会显示加载错误。

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
不因作品的 `x_restrict` 标记而在本地删去已获准访问的作品；网格与批量采集只下载 `square_medium` 缩略图，点击预览才请求 `large`，不下载原图。
账号的年龄与内容可见设置需要你自行在 Pixiv 完成，程序不修改或绕过这些限制。
App API 仍可能与网页存在差异，**不承诺永久完全一致**；列表缺项如果是平台静默过滤，只能通过网页对照发现。
明确不可见的作品、缺少 `square_medium`、权限错误或格式异常都会报错，不回退到其他尺寸，不跳过后冒充完整采集，也不退回匿名模式。
读取已有图片及有效列表缓存不需要访问 Pixiv 作品列表接口；OAuth Token 不会发送到图片 CDN、前端或第三方地址。
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

输出网页与 App 的作品 ID 差集；不一致或失败返回非零退出码，不写数据库、不下载图片、不改变列表检测时间。
请包含你有权查看的普通作品及限制作品样本，并在同一时间窗口比较；发布/删除作品也可能造成差异。
此检查只核对作品列表；要验证缩略图可下载，仍需成功运行采集并在详情页对照，不能以模拟测试代替真实账号验证。

运行 `npm run db:init` 应用迁移：`booths.pixiv_images_updated_at` 记录最后成功检查时间（包括无新图或空作品列表），
`images_pixiv` 以唯一作品 ID 关联 Pixiv 用户 ID。文件存入 `storage/pixiv/[pixiv_id]/[image_id].[ext]`（使用 `MEDIA_ROOT` 时跟随该根目录）。
首次没有列表缓存时联网检查；已有文件仍复用，但文件修改时间不再冒充成功检测列表的时间。
网络下载全部成功后才替换索引、删除超出最新 10 个作品的文件并更新时间，失败可重新运行菜单任务。
同一 Pixiv 账号的 booth 共用缓存和检查时间；数据库已有但磁盘缺失的图片会在下次允许检查时补下。
Circle.ms 重新采集若更换了 Pixiv 账号，会清空该 booth 的图片检查时间，避免沿用旧账号记录。
每个平台全站一次只执行一个后台图片任务，状态按登录用户隔离；重启不恢复任务，已保存图片和数据库记录保留。
每个账号最多同时下载 3 张作品缩略图，不再主动等待固定的 500ms 请求间隔；账号之间仍顺序处理。
列表使用上述 10 分钟检测间隔，保留网络请求超时；遇到 HTTP 429 时按上述规则等待并自动重试。
缩略图按原始响应内容保存，不做本地压缩或缩放；保留 20 MiB 下载安全上限及图片格式检查。
超出安全上限或格式异常会明确报错，不覆盖该账号的旧缓存。

## Twitter 作品图片

登录后列表右上角「⋯」提供四项：刷新 / 补全 twitter 图片、刷新 / 补全 pixiv 图片。
两种平台的批量任务均仅针对当前用户收藏的社团。
Twitter 与 Pixiv 使用相同的详情渐进加载流程：先展示本地最新图片，登录后并行读取有效列表缓存或检测最新列表，
顶部扁加载条显示同步状态；列表更新后才替换网格，已有文件直接复用，缺失图片在格子中旋转加载、
经服务器转发后逐张展示并异步保存。未登录只读取本地图片。
详情和批量任务共用上述 10 分钟列表缓存；详情不更新完整批量检查时间，
取消原来的 1 小时批量限制。缓存包含图片地址及推文时间 / 附件顺序，重启后可继续复用及补图；
最新索引在列表同步成功后保存（包括空列表），列表失败保留本地展示并提示错误。
转发请求使用签名、15 分钟有效链接，复用 3 并发限制与同图请求合并，保存失败记录服务端错误；
详情同步不清理旧文件，旧文件仍由成功的批量任务统一清理。

Twitter 使用 `rettiwt-api` 的 `user.details(username)` 将用户名解析为永久数字 ID，
存入 `booths.twitter_number_id`；已有数字 ID 时直接复用。通过 `user.media(numberId)` 分页读取媒体页，
按推文发布时间从新到旧取 10 张媒体，同一时间用推文 ID 排序、同条推文按原附件顺序排列，
不以媒体 ID 判断新旧；重复使用的媒体保留最近一次发布的位置。旧置顶按其实际发布时间参与排序，
不会优先挤占新图。视频 / GIF 仅下载其图片封面，不下载视频，转推不参与采集。
凑齐 10 张后继续读取后续页确认时间边界，避免仅凭旧置顶的多图提前结束；按媒体流的逆时间分页读取，
遇到空页即视为媒体流结束，即使 X 仍返回变化的游标也不继续翻页；未满 10 张时返回已有媒体。
不能保证取得平台未返回、隐藏、已删除或当前账号无权访问的内容。
网格及批量采集只请求 `pbs.twimg.com` 的 thumb 尺寸：照片使用 `name=thumb`，视频 / GIF 封面保留扩展名并使用 `:thumb`，
避免部分封面的 `format/name` 查询返回 404 或被忽略而下载原尺寸。媒体页中无媒体的有效推文会跳过，
真正的结构异常或下载失败仍会报错，不回退到原图。同一媒体 ID 只保存一次，
文件存入 `storage/twitter/[twitter_number_id]/[image_id].[ext]`，索引为 `images_twitter`。
索引同时保存 `tweet_id`、`tweet_created_at` 和 `media_index`，详情直接沿用此顺序，不再按媒体 ID 重排。
排序迁移保留已有图片，将缺少发布时间的旧索引对应账号检查时间置空；升级后运行一次「补全 twitter 图片」
即可重新确定最新 10 张及顺序，修复完成前旧图仍可读取。
成功完成整个账号后更新 `booths.twitter_images_updated_at`；获取列表受上述 10 分钟检测间隔限制，
补全只处理尚无成功采集时间的账号。最多 3 张图片并发下载，账号顺序处理，
失败不替换旧索引或检查时间；HTTP 401 / 403 / 429 停止 Twitter 批量任务并显示错误。
Circle.ms 采集若更换 Twitter 用户名，会重置数字 ID 及检查时间；同名（大小写无关）则保留。

本地在 `server/.env`、Docker 在根 `.env` 中配置：

```dotenv
TWITTER_API_KEY=你自己的Rettiwt用户认证密钥
# 可选，供 Rettiwt API 和图片下载使用，不继承系统或 Pixiv 代理
TWITTER_PROXY_URL=http://127.0.0.1:7890
```

媒体页需要用户认证，未配置密钥时服务仍可启动和展示旧图，但采集会明确报错，不降级匿名访问。
密钥是自己 Twitter 登录 Cookie 的 Base64 编码，按
[Rettiwt 的认证说明](https://github.com/Rishikant181/Rettiwt-API#authentication) 在本地取得，
不要贴到聊天、提交 Git 或发送给前端。仅采集有权保存和公开展示的图片；网站访客可读取已缓存图片。
当前使用 `rettiwt-api@7.2.0`；需要 Node 22.21+（22.x）或 Node 24.x。
通过 `patches/rettiwt-api+7.2.0.patch` 缓存请求标识的初始化材料：同一个服务实例的不同目标账号、
分页请求共用初始化过程，成功初始化后保留 1 小时；每次 API 请求仍根据方法和路径生成新的 transaction ID，
此补丁仅缓存初始化材料，不复用完整请求标识；媒体列表另按上述 10 分钟策略缓存。
初始化 / 生成失败会清理缓存并报错；HTTP 400 / 401 / 403 / 404
清理对应材料供下次请求重新初始化，不新增认证失败重试，429 仍立即停止批量任务。
`npm ci` / `npm install` 的 `postinstall` 自动应用补丁，失败会中止安装；不要使用 `--ignore-scripts`。
Docker 构建同样先复制并应用补丁；升级 Rettiwt 时需重新核对补丁及对应测试。
旧版 6.0.8 的请求标识解析不兼容当前 X 页面，可能报 `Couldn't get KEY_BYTE indices`。
出现 `ECONNRESET`、连接超时等网络错误时，检查 `TWITTER_PROXY_URL`；
如果 Pixiv 已通过代理正常访问，可填写相同的代理地址，但两项配置不会自动互相继承。
代理也覆盖 Rettiwt 请求标识模块内部的静态脚本下载，且仅在 Twitter API 请求上下文中生效，不改变其他请求的代理。
浏览器 Cookie 常用的 `; ` 分隔格式会在内存中自动规范化，避免 Rettiwt 将空格识别为 Cookie 名称的一部分；
不会改写配置中的 Key，无需为此重新生成。HTTP 401 仅表示认证被拒绝，应检查 Cookie 格式、会话和接口兼容性，
不能仅凭 401 判断 Key 已过期。修改配置或升级代码后请完整重启后端。
Twitter 的非官方接口可能变化，不能保证所有账号 / 媒体永久可用，需使用实际账号验证。
运行 `npm run db:init` 应用新增迁移，修改环境变量后完整重启服务。
若数据库已应用旧分支的收藏颜色迁移 `0012_melodic_wiccan`，仍可直接运行 `npm run db:init`：
图片迁移保留原顺序，`0016_dazzling_gambit` 在末尾将收藏颜色设为可空的 `char(7)`，保留已有收藏数据。

## 本地

Node.js 22.21+（22.x）或 24.x、MySQL 8.4。复制 `server/.env.example` 为 `server/.env` 并填写数据库：

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

Preview 默认将 PDF 背景里的饱和彩色转成白色，保留黑白灰；取消「彩色转白」可对照原图。
路径识别采用同一彩色转白规则，并额外清理彩色笔画周围 2 像素内仍带色偏的边缘，避免细碎绕行；纯灰黑像素不做这项清理。
原 PDF、摊位 OCR 和 Island 标记识别仍使用各自原有的彩色输入，不受影响。

管理员可在 Preview 勾选「路径图」查看 PDF 上的通道。生成器在 Hall 范围内允许预处理后的白色和近白色通行；
面积小于 1000 个原图像素且不含黑色或近黑色的灰色连通块也视为可通行，与较大障碍相连的灰色细节仍会保留。
只保留最大的四连通区域；用完全可通行的 4 像素网格识别通道，因此极窄的缝隙不会保留。
分别沿两个轴扫描，优先使用长直线、合并共线段、保留环路，并采用线段数较少的结果；
再检查可拉直的折线：只有两段扫过的区域可通行、支路接点不变、且总长度缩短时，才用直线替换绕行。
最后沿原方向检测每段共线合并后的直线两端，即使起点已与垂直路径相交。
延长线只能接到前方第一条路径，或到达 Hall 外轮廓内侧；如果先碰到摊位等内部障碍，则不延伸。
西 1–2 馆的原图没有闭合外框；该版地图按实测的凹口边界裁剪路径，并校验凹口不会切掉已识别的摊位。
西馆中央的两条细横线会在路径识别和 Preview 的「彩色转白」背景中去掉，原 PDF 不变。
第二页检测外轮廓接点时额外忽略边缘附近的中等粗度深灰框线，保留大面积浅灰摊位和厚墙；室内通路提取仍使用原来的规则。
这是简化策略，不保证全局最少。重新生成地图时自动输出 `page-*-paths.json`。已有 PDF 预览可跳过 OCR 单独补生成：

```powershell
cd tools\booth-recognition
.\.venv\Scripts\python.exe -m map_recognition.path_graph output\official-map\result.json
.\.venv\Scripts\python.exe -m map_recognition.final_data output\official-map\result.json
```

第二条命令把已有路径和 Hall 外轮廓转换为 [地图数据](./tools/booth-recognition/map_recognition/final_data.py) 各 Hall 的 `pathGraph`。
`nodes` 使用与摊位相同的 Hall 原图坐标，`edges` 以节点索引记录双向的 `indoor` 和 `perimeter` 通路；
交点会拆成共享节点，靠到外轮廓的路径会补齐网格留下的间隙。外轮廓是图上的通路，不代表验证过的出入口或场馆之间的道路。
Map 默认绘制该图层，可用地图右上角的悬浮「路径图」按钮隐藏，不需要加载 PDF 原图。
Map 设置中的「卫星底图」默认关闭。开启后，浏览器按当前视口通过本站接口加载 Esri World Imagery 的 Web Mercator 瓦片，将其绘制在 OSM、Hall 和路线图层下方，随地图一起拖动、缩放和旋转。服务器需要能通过 HTTPS 访问 `server.arcgisonline.com`。

导航栏的 **Map2**（`/map2`）使用同一底图组件读取 [`ref/ref.osm`](./ref/ref.osm)，不加载 Comiket 叠加层。

在其他页面可以直接使用 [`<OsmBasemap data={data} />`](./client/src/map/basemap/OsmBasemap.tsx)，父容器需提供可用高度。`data` 只需要 OSM 的 `bounds` 和 `features`（例如 `parseOsm(xml)` 的结果），不需要活动、摊位或用户数据。底图自带网格、卫星开关、平移、缩放和旋转。要叠加自己的内容，可通过 `attachLayer` 接入与底图共用视口的事件和绘制回调；`afterLevel` 逐层绘制，`afterFeatures` 在地物之上绘制。当前 Map 由 [ComiketMap](./client/src/map/ComiketMap.tsx) 接入 [ComiketMapLayer](./client/src/map/ComiketMapLayer.ts)，负责日目、场馆、PDF、摊位、类别颜色和路线规划。
勾选设置面板中 `genre` 右侧的复选框启用类别上色，再点击 `genre` 打开类别筛选。
展开 `routes` 可勾选并高亮 OSM 关系中的联络通路和待机列。联络通路用目的馆的主题色，待机列用名称首馆的主题色；高亮显示整条路线，不受楼层筛选影响。
`routes` 下方的 `planner` 可在「東」和「西南」之间切换。点击 `cal route` 后，只绘制待机列的入场段，并按步行距离贪心选择下一个当日收藏摊位。纳入导航网络的待机列路段只能沿入场方向通行，规划路线和手动导航都不能逆行。路线颜色从蓝色出发，沿步行距离连续走完一圈色相后回到蓝色；联络通路暂停渐变，与前后路段衔接处同色，摊位的虚线连接使用到达时的颜色。先绘制整条路线的白边，再绘制彩线。每段取最短路径，但不保证遍历顺序全局最优；无法纳入的收藏会提示数量。
规划后，设置面板左侧的路径列表按访问顺序显示摊位。拖动条目（或聚焦条目后按 Alt + ↑/↓）可调整顺序；只重新计算起终点组合改变的路段，无法通行时保留原顺序。悬浮条目时，地图在对应摊位显示与直接悬浮相同的预览；摊位在画面外时，地图会移到该摊位。
规划路线以较细的主线绘制，长脉冲沿路线前进，颜色随所在路段变化、尾部逐渐淡出。脉冲长度为 128 屏幕像素，速度为每秒 180 地图米，缩放不改变脉冲头在路线上的位置，同一点约每 4.74 秒经过一次。每当脉冲头到达访问点，对应摊位或半摊位会以其收藏标记色高亮 1.2 秒，摊位边缘绘制带白边的粗线，同色外框向外扩张并淡出；启用系统的减少动态效果设置时不播放动画。
`planner` 的「颜色系数」沿用 List 的颜色顺序，默认值为 `1`。编辑有效值后自动保存到当前用户的颜色配置，无需点击 `cal route`；刷新后仍保留。重新计算时按「固定距离 + 其余步行距离 ÷ 目标摊位颜色系数」选择下一站。联络通路默认计入固定距离；标记 `ratioable=yes` 的联络通路路段可双向通行，且其距离参与系数计算。待机列仍只允许沿入场方向通行。同一位置有多个颜色时取最高系数，系数为 `0` 的摊位不作为访问目标。每段仍走实际最短路径，路线渐变不受系数影响。
区域只填充浅色，不画边框；楼梯路段（`highway=steps`）以虚线高亮，虚线间隙用半透明主题色连接，白色描边贯穿整段楼梯。普通路段的高亮线更细，楼梯的单向箭头绘制在最上层。线宽和单向箭头随地图缩放；高亮路段按楼层从低到高绘制，高层路径的细白边将它与下方路径分开。
Preview 的「摊位朝向」沿 a/b 分割线显示箭头。靠近 Hall 外框且沿墙只有一排的 Island 整组标为壁摊，箭头背对最近边线、指向馆内。
西 1–2 馆的三条凹口边也参与最近边线计算，并允许单排摊位与凹口边之间有较宽的间隔。
南 1–2 馆使用矩形包围框时，按外框与壁摊之间的留白放宽距离；角位使用最近且能判定朝内的边线。
普通摊位只朝向有过道且未被邻摊挡住的一侧。无法唯一判断时以圆点标记，不猜方向。
有对应 `outside-hall` OSM 关系时（例如 `outside-hall=e123`），Map 将所有场馆框线节点投到该关系中最近的路段，
并沿相连的 OSM 路段重画框线。室内通路保持原位，原有内外接点用虚线标出投影位置；虚线不代表已验证的实际通道。
没有对应关系时保留原框线。投影只影响 Map 显示，不改动 Hall 原图坐标或 OSM 数据。

Map 导航：鼠标分别悬浮在起点和终点按空格，立即高亮路线；按 `X` 清除。
起终点使用相同规则：悬浮在摊位上时，从所选摊位（有 a/b 时为所选半摊）的中心沿朝向画到前缘，
再以虚线接入最近且未被邻摊阻挡的馆内路径；其他点须位于
`tokyo-big-sight=yes` 的区域内，排除带 `path:*-entry` 的区域。馆内优先使用 OSM Hall 区域对应的楼层，
多个场馆层重叠时优先取筛选内最高的场馆层；馆外取筛选后覆盖该点的最高楼层。
不限方向接入同层最近的导航路段，直线接入以虚线显示。A* 在馆内路径、内外投影线、OSM `outside-hall` 路段和「連絡通路」
之间寻路。至少一端在馆外时，还可使用标有 `tokyo-big-sight=yes` 的其他步行路段；摊位和 OSM Hall 区域内的端点仍只接入原有网络。
隐藏的 PDF 外框不参与寻路；馆内外路段和投影线均按距离计算代价。OSM 单向路段按 `oneway` 指定的方向通行，
即使被投影接点分割也不能逆行。投影线未验证为实际出入口，路线仅供参考。

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
