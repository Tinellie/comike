# Comike

空白全栈项目：TypeScript、Node.js、React、Vite、React Router、Express、
MUI、MySQL 和 Drizzle ORM。

界面包含主导航栏、Booth List 首页 (`/`) 和 OSM 地图 Map (`/map`)。
另提供 Preview (`/preview`) 用于查看地图识别结果。

## Booth List

首页使用可复用的 `client/src/booths/BoothList.tsx`，默认选择已保存数据中最新的 Comiket，
也可以切换活动。列表每次请求 40 条，接近底部时继续加载；排序、筛选切换会取消旧请求并重新分页，
不一次下载全部 booth。错误会显示重试入口，图片延迟加载，缺失图片明确提示。
各列固定宽度依次为 40/160/160/128/240/240/136/40px；宽屏剩余空间均匀分配，首尾留白各为列间空隙的一半，
表头与数据行共用布局，窄屏保持列宽并横向滚动。

- 显示预留红色标记、两张图片宽度的图片区（单图居中、列表等比缩放至 112px 高，左右各留 6px、上下和图片之间不留间距；详情保留自然高度）、
  社团/作者、位置/日目、类别/标签、预留 Memo、外部链接和预留操作按钮。
  Circle.ms、Pixiv、X 使用 `client/public/icons` 下的图标，填满 36px 圆角方形按钮并裁剪边角；账号缺失时置灰禁用。
  点击链接不会打开详情；点击其他行区域或聚焦行后按 Enter/空格，会打开右侧详情。
  详情按需请求，显示完整「補足説明 / サークルアピール」及「タグ」；列表标签仅返回前 512 字符。
  详情只按 ID 读取该记录，并查询活动曜日用于日目展示；不重算场馆筛选、类别排序或全部活动列表。
  普通位置/名称分页不执行类别全量排序，仅类别排序或类别筛选时读取所需类别数据。
  增量列表用 ID Set 去重，避免每个新项目反复扫描全部已加载项目。
- 社团名按 `circle_name_reading` 排序。服务端使用本地 kuromoji 字典自动生成读音，
  将片假名转为平假名、全角字符规范化、英文转小写，然后持久化；这是读音，不是翻译。
  新采集自动写入，已有数据先执行 `npm run db:init`，再执行 `npm run db:readings -w server`；
  回填只处理读音为 NULL 的记录，可中断后重跑，不重新爬取。
  特殊社团名/生僻汉字无法保证准确，未知汉字片段保留原文并在服务端警告；不提供人工校正界面。
- 位置升序依次为日目、東→西→南→北、馆号降序（123 在 7 前）、island、数字摊位号、
  后缀（空、a、ab、b），以唯一 ID 稳定打破并列；再次点击表头反转排序。
  日目使用当前活动在数据库中的全部曜日推断，而非当前页或筛选结果，支持土→日→月跨周。
  仅凭曜日存在歧义时显示警告，并按周一至周日排列；尚未采集到的曜日无法推断。
- 类别支持排序和独立多选筛选。类别顺序由当前活动完整数据中各类别位置最靠前的记录决定，
  不按类别名称或当前页排序，也不因日期、场馆筛选而改变；同类别内始终按位置升序及 ID 排列。
  再次点击类别表头仅反转类别组顺序。筛选选项沿用此类别顺序，支持全选、清空和重置，
  可与日期、场馆条件叠加，缺失类别也可选择。
- 位置表头的紧凑面板按日期和场馆横向排列选项，窄屏自动换行，支持多选、全选或全部取消。场馆直接使用地图系统
  `tools/booth-recognition/output/official-map/final.json` 的 Hall→island 对应，
  不手工维护第二份分区表；保留 A/a、平/片假名差异，目前为東123、東7、西12、南12。
  无映射的 island 单列为“未匹配”并警告，地图缺失或格式无效时明确报错。
  **当前仅配置一份地图，没有按届数区分：浏览其他届数据前须提供适用地图，不能保证跨届馆区对应正确。**

只读 API：

- `GET /api/booths/options?eventId=240`：活动、曜日顺序、场馆和按位置排列的 `genres` 筛选项；省略活动时选择最新一届。
- `GET /api/booths/days?eventId=240`：仅返回 `{ event, days, warnings }`；省略活动时选择最新一届，
  供地图日期选择器使用，不计算完整筛选项。
- `GET /api/booths?eventId=240&offset=0&limit=40&sort=location&direction=asc`：
  返回 `{ items, total, nextOffset }`；`sort` 支持 `name`/`location`/`genre`，每页最多 100 条。
  `days`/`halls` 接受逗号分隔的筛选值；省略表示全选，空字符串表示全部取消。
  `genres` 使用 URL 编码的 JSON 数组（如 `["ブルーアーカイブ",null]`），避免类别名称中的逗号被拆分；
  省略表示全选，`[]` 表示全部取消，`null` 数组项表示数据库 NULL 类别。
- `GET /api/booths/:id`：单条完整详情。
- `GET /api/booths/images/c109/24031654_1.png`：仅提供 `<MEDIA_ROOT>/booths` 下格式匹配的图片，
  不开放任意存储路径、私密登录文件或目录浏览。

`server/test/booths.test.ts` 包含地图、日期、参数、自动读音及 HTTP 测试；
加载 `server/.env` 后运行该文件还会执行真实 MySQL 排序/分页测试，测试记录在事务中回滚，不清空现有数据。

## 地图与社团匹配

- 地图右侧面板提供“日目 / 参展日期”下拉框，使用当前数据库最新活动的日期，默认一日目。
  单击半摊位后按活动、曜日、场馆、island、编号和 a/b 查询，打开与首页完全相同的
  `BoothDetail` 组件；a 查询 a/ab，b 查询 b/ab，保留拉丁字母大小写、平假名/片假名差异。
  同位置有多条记录时可切换社团；拖动、Alt 旋转及取消手势不会打开详情。
  位置接口已返回完整社团详情，直接交给共用抽屉显示，不再按 ID 重复请求；
  查询失败的“重试”只重试该位置，日目读取失败只重试日目，不重载 OSM、Hall 数据和变换文件。
  数据库位置组合索引收窄查询范围，同时保留 island 的大小写和假名严格校验。
- `server/src/booths/reconcile.ts` 封装地图位置比对：从当前 `final.json` 枚举已识别的半摊位，
  按活动中每个已采集曜日与 `booths` 比对；ab 同时覆盖 a/b。缺少 a/b/ab 后缀的社团不会推断占位，
  无法识别的地图编号/island/分割会跳过并警告，位置重复或非法数据明确报错。
- 未匹配位置存入独立 `map_vacancies` 表：活动、届数、曜日、方向、场馆、island、摊位编号、
  a/b、地图格子 ID 和比对时间；不伪造社团，也不混入首页列表。
  每个活动的旧结果在一个事务中替换，以活动、曜日、场馆、island、编号及 a/b 作为联合主键避免重复，
  不设置额外 ID；其他活动不受影响。
  地图点击这些位置显示未匹配说明；若尚未比对则提示完成采集或重跑，而不声称该处是官方空摊位。
- 采集全部详情成功后、标记任务完成前自动执行一次比对（使用数据库跳过全部详情的任务也会执行）。
  比对失败会记录服务端错误并令任务失败，可继续重试；未完成、被停止或有详情失败时不刷新空位结果。
  比对基于数据库现有社团，不代表官方确认的空摊位；不完整数据会产生更多未匹配位置。
- 首次部署执行 `npm run db:init`。需要独立更新时运行
  `npm run db:map-vacancies -w server`，默认最新活动；指定活动可加 `-- 240`。
  当前仍使用一份地图，没有自动跨届对应；指定其他届前必须确保地图适用。
- `GET /api/booths/location?eventId=240&weekday=火&hallGroup=東123&island=ア&number=03&suffix=a`
  返回 `{ circles, vacancy }`，优先使用实时社团记录，防止旧空位结果遮蔽新采集社团。
- `GET /api/booths/map-data?eventId=240&weekday=火` 仅查询 ab 位置和已保存的空缺半格，
  返回 `{ merged: { "メ": ["10", "11"] }, vacancies: { "メ": ["12a", "12b"] } }`。
  Map 按当前活动、曜日预加载，切换日目时取消旧请求并清除旧日的显示，不逐格请求或加载社团详情。
  预加载失败明确提示，可单独重试，不重载地图几何数据。

## OSM 地图

运行 `npm run dev` 后打开 http://localhost:5173/map。
Map 页面读取本地 [osm-map.osm](./ref/osm-map.osm)，在 React 管理的原生 Canvas 2D 上绘制，
不需要在线地图服务、瓦片或 API Key，也不会上传地图文件。
后端通过 `/api/map/osm-map.osm` 提供该固定 OSM 文件，不开放任意文件路径。
刷新页面或取消下载时，文件接口不会修改已发送的响应头，也不会向已关闭连接写入错误响应，
避免请求中断导致后端退出；连接中断仍记录在服务器日志中。

- 使用 Web Mercator 投影；配色与绘制规则参考原项目的 OSM 页面：
  东馆红色、西馆蓝色、南馆绿色，普通建筑暖橙色，步行区青色，步道绿色，铁路蓝色；
  没有 `tokyo-big-sight` 标签的范围外要素灰化。
  Tokyo Big Sight 的外围墙（`boundary`）使用灰色描边，保持原线宽和图层。
  普通粉色区域填充使用 12% 不透明度，东馆红色配色不变。
- 按 `level`（未标注时仅排序默认 0，先于 level 1 绘制；筛选时仍视为未标注）、类型图层排序，展示 100 米网格及单行方向箭头。
  highway、railway、route、pathway 和 `path:*` 路径样式的描边/填充，
  使用原 RGBA 色叠加白色后的实心 RGB 色（各通道 `round(原色 × alpha + 255 × (1-alpha))`）；
  原线宽、虚实线及层级不变，level 排除样式仍保持淡灰透明轮廓。
  带 `hall-*`（兼容 `hall:*`）标签的 area 在同层其他 OSM 对象之后绘制，PDF Hall 仍在该层 OSM 之后。
  东/西/南子馆填充不透明度分别为 0.48/0.4/0.38；其他东/西/南 Hall 为 0.28/0.19/0.16，
  普通橙色建筑为 0.08。
  线宽、楼梯虚线和箭头采用实际地图米数，随地图缩放，而不是固定屏幕像素；
  已补偿 Mercator 在当地纬度的比例变形，原始地图坐标不变。
- 标签优先显示 `hall:e` / `hall:w` / `hall:s` 的彩色馆号，不再铺满普通地名，
  同楼层已显示的 PDF Hall 按 `labels[].code` 占用子馆编号，隐藏对应 OSM 馆号标记；
  未占用编号保持显示，隐藏或被 level 排除的 PDF Hall 不占用编号，判定不随视口裁剪变化。
  馆号保持正向、白色描边并避让；较大比例下字号也随地图放大。
- 继承有效 Relation 的绘制标签（含路径、单行和馆区标签），保留多个取值；
  已组合的多边形不重复填充成员边界或标注馆号。
- 支持拼接多边形关系的分段外环/内环，以保留孔洞；忽略 JOSM 的 `action="delete"` 和 `visible="false"` 对象。
- 初始适应有效地图范围；按住鼠标左键拖动，滚轮围绕鼠标位置缩放。
- 提供放大、缩小、适应地图按钮；聚焦画布后也可用方向键、`+` / `-`、`Home`。
- 画布随容器调整尺寸，并适配高分屏；缩放范围为适应比例的 25%–25600%。
- 加载/解析失败会显示错误与重试入口；缺失几何引用会显示警告，不跨缺失节点连线或强行填充不完整多边形。

绘图使用本地矢量样式，并非完整的 OSM 官方地图样式；非多边形关系只提供成员的绘制标签，不额外叠绘，避免重复道路/线路。
本页没有移植参考项目的编辑器、楼层筛选、路径高亮选择或车站 HTML 徽标。

### Hall 图层和变换

Map 同时读取识别输出的 `final.json` 和独立的 [hall-transforms.json](./ref/hall-transforms.json)，
将每页 Hall 作为一个整体绘制到 OSM 坐标中；不读取详细 `result.json`，也不加载 PDF 背景。
Hall 边界内部保持透明，不绘制白色底面；Map 隐藏 PDF 识别出的 Hall 外边框，保留摊位和文字标签。
Hall 内部绘制使用缓存的 Island → Block → Booth 包围框层级进行视口裁剪：
不相交时跳过整个子树，完整包含时省略子级检查，部分相交时再筛选 Booth 及其 a/b。
每帧将实际画布四角逆变换到 Hall 原图坐标，兼容地图旋转、非等比缩放和高分屏；
预留文字及线宽边缘余量，marker 单独保守裁剪，不以点是否在屏幕内直接丢弃文字。
Block 格线仍按状态批量绘制，不拆成逐 Booth 绘制；全图可见时复用原始页面数据。
该优化仅减少绘制，不修改识别数据、编号归属或变换文件，Preview 保持原逻辑。
重用 Preview 的 Block 格线和 Booth 编号绘制，Booth 框线统一深灰色；
每个 Block 的真实 Booth 占用区域以半透明浅灰色（`rgba(128, 128, 128, 0.18)`）填充，
位于框线和编号后方，不填满不规则 Block 包围框内的空缺。
Map 不绘制 Half-booth 分割线或 a/b，只显示完整 Booth 数字编号，编号深灰且无白色底板。
右侧「PDF 原图」开关默认关闭；开启后才加载对应完整 PDF 页，以 35% 不透明度绘制在
Booth 底色、空缺遮盖、高亮、格线及编号下方。复用导出数据中的 `sourcePage`、
`pdfPreview` 页图及坐标变换，再统一跟随 Hall 的平移、旋转、缩放和长宽比，不按 Hall 顺序猜页码。
原图不参与点击检测，楼层过滤时隐藏；关闭立即移除，再次开启复用已解码图片。
图片加载或尺寸校验失败会明确提示并支持单独重试。
旧数据缺少原图元数据时，从已有 `result.json` 重新导出 `final.json` 即可，无需重跑 OCR。
另外绘制最终数据中的场馆标签中心。没有 Hall 外边框、分组着色、Block 外扩虚线或缺号提示。
Map 的 Island marker 文字直接以 `pos` 为中心绘制，无偏移、圆点或白色底板；
每页的 `textRotation` 保存 OCR 识别出的原 PDF 数字方向（0/90/180/270°），
不按 PDF 页面竖直方向或单个 Booth 的宽高推断；同页所有 Booth 编号、Island/Hall 标记共用此基础角度。
再仅以 0°/180° 翻转避免倒置，不新增 90°/270° 纠正。
这些文字同时考虑 Hall 变换及地图视口旋转，
仅绘制文字、无白色底板。两类 marker 均使用
[`ref/hall-meta.json`](./ref/hall-meta.json) 中对应场馆的 `marker-color`，
优先按场馆标签的 E/W/S/N 编号匹配，无编号时按场馆名称前缀匹配；缺失或歧义配置明确报错。
此元数据随前端构建加载，部署后修改需重新构建；Preview 的诊断绘制保持不变。
精简数据未保留 Booth OCR 旋转，数字方向按格子宽高推导；场馆标签没有文字框，按中心标注。

每个配置项包含：

- `hallIndex`：`final.halls` 的零基下标，配合 `name` 校验，不按名称合并同名 Hall。
- `anchor.latitude/longitude`：WGS84 经纬度锚点。
- `offset.x/y`：相对锚点的地面米数，X 向东、Y 向南。
- `rotation`：顺时针角度；`scale`：每个识别图像素对应的地面米数（允许 0.001–10）。
- `aspectRatio`：横向缩放系数（允许 0.01–100）；1 保持原比例，小于 1 压窄，大于 1 拉宽。
  旧配置省略此字段时按 1 读取，保存时写入该字段。

以源 Hall 边界包围框中心为基点，先按 `aspectRatio` 缩放 X、保持 Y，再按 `scale` 等比缩放并旋转，
转到当地米坐标，再补偿 Mercator 纬度比例，
最后使用地图视口统一平移缩放。初始四个 Hall 放在对应场馆附近，使用已固定在配置文件中的
随机示例位移、角度和比例，**不是精确地理配准，也不会每次刷新重新随机**。
重新排序或增删最终 Hall 后需同步修改配置，缺失/重复/名称不匹配均会报错。

Map 页面保留导航、地图及「重新计算全部 Hall」按钮，右侧悬浮面板提供 `rotation` 拉杆
（-180°–180°）和可折叠 `level` 勾选区（1–4），不显示配准报告或额外说明文字。
按住 Alt 拖动，以地图视口中心旋转；普通拖动、滚轮和键盘操作在旋转后仍按屏幕方向工作，
滚轮缩放保持鼠标所指的地理位置不变，并保留 OSM 必需署名。
默认勾选 level 1、2 并启用过滤；取消全部勾选时正常显示全部对象。
鼠标悬停时按 Hall → Island → Block → Booth → half-booth 逐层检测，
右侧面板底部以小字显示 `Hall / Island / 编号a或b`；ab 合并摊位显示 `编号ab`，未命中显示 `—`。
普通摊位悬浮时仅高亮命中的半格，ab 合并摊位无论命中哪一半都高亮整格。
空缺半格在预加载数据到达后按 Hall 合并为连续区域，缓存合并范围和绘制路径，
每个 Hall 一次填充深灰底色，不逐格绘制；保留不规则轮廓、内部空洞及真实间隙。
缓存不随平移、缩放、旋转或窗口尺寸变化重建；日目或数据变化时重新生成。
灰底位于格线和编号下方；空缺半格不触发悬浮高亮，仍显示位置编号并保持点击匹配。
悬浮在可点击摊位（含空缺半格）时鼠标显示手形，移出恢复抓取样式；拖动和 Alt 旋转保持各自的光标。
悬浮非空缺摊位时，鼠标上方显示带尖角的社团预览框，按位置、名称、图片排列；
位置使用社团实际后缀（含 ab），多条记录分别展示，无图片时显示占位提示。
同格移动仅更新浮层位置，不重复查询；短暂停留后复用位置详情接口，
预览与点击共用进行中的请求及当前活动/日目的会话内结果缓存，打开详情不重复获取已预览的数据。
移出、拖动、切换日目时隐藏预览；空缺半格不触发预览。预览不拦截鼠标，不影响地图点击和缩放。
加载失败在预览框中明确提示，移开后重新悬浮可重试；切换活动/日期或离开地图会清除缓存并取消请求。
检测随地图平移、缩放、旋转及楼层过滤更新；隐藏的 Hall 不参与，重叠时优先较高楼层及后绘制的 Hall。
鼠标移动按帧合并命中查询，仅高亮格子改变时请求重绘，同一半格或同一 ab 内移动不重复重绘。
勾选后，OSM `level` 标签不包含任一所选数值的对象
（包括未标注 level 的对象）仅绘制灰色轮廓，不填充、不显示文字或实心箭头，
保留原线宽及虚实线格式；原本仅填充、没有轮廓的对象使用普通建筑轮廓宽度。
支持分号、逗号及多值标签，level 0 不等同于 level 1。
PDF Hall 按元数据 `level` 参与过滤：未选中的 Hall 保留灰色框线、格线和分割线，不显示文字。
每层先绘制 OSM 对象，再绘制该层 PDF Hall，最后绘制更高层对象；Hall 层级来自
[`ref/hall-meta.json`](./ref/hall-meta.json)，视口旋转和 level 选择不修改已保存的 Hall 变换。
Hall 边界、Block/Booth 和分割线直接不等比缩放；编号、a/b、Island 标记文字和场馆标签的
锚点随长宽比移动，但字形及文字底板只跟随基础等比缩放和旋转，不拉伸。
自动变换计算集中在独立的 [Hall 数据整理模块](./client/src/map/hallPreparation.ts)，
与按配置绘制 Hall 的逻辑分离。统一入口「重新计算全部 Hall」一次处理所有 Hall，
无需选中或逐个操作，依次执行：

1. 为每个 Hall 选取出现次数最多的完整 Booth 宽高尺寸（并列时取首个），
   将 `高/宽` 写入横向系数，使该类 Booth 变为正方形，不累乘旧系数。
2. [子馆配准模块](./client/src/map/hallRegistration.ts) 按精简数据 `labels[].code`（如 E1）
   匹配 OSM 的 `hall-e`/`hall:e`、`hall-w`/`hall:w`、`hall-s`/`hall:s`、`hall-n`/`hall:n`。
   同编号重复文字取位置均值；每个 OSM 子馆取外轮廓面积中心，用对应点的相对分布确定整体大致方向，
   而不是把入口/边缘文字强行对齐建筑中心。
3. 合并所匹配子馆图形，剔除共边、重叠内边和关系成员重复图形，再生成单个**凹形套索**：
   从凸包出发，使用真实子馆的外轮廓顶点/连续边链逐步收紧，只有不自交且仍包裹全部子馆的
   面积减小操作才接受。填补封闭中庭、内部孔洞和子馆间缝隙，尽量保留外侧宽浅凹口；
   多子馆的深开口（深度超过口宽一半）视为开放中庭并封口，判断拐点时忽略小于 3° 的 OSM 抖动。
   单子馆保留自身的真实凹口。这是确定性的紧凑凹包近似，不声称不存在更小的其他凹包。
   此范围替代此前的严格子馆并集，不使用独立的更大完整建筑外框。
   对长宽比修正后的 PDF Hall 框线及 OSM 边界按弧长采样，
   原 PDF 水平/垂直边使用 4 倍拟合权重，并加入平行方向惩罚及 OSM 长边对齐的角度起点，
   使斜边和短凸起不易带偏主要方向。
   多起点加权 ICP 提供初值；选取可作为外侧支撑边的最长 PDF 垂直边（没有时使用水平边），
   按距离匹配套索边界上仍属于真实 OSM 子馆的长边，不拿新增的套索连接线判向。
   候选角度限定在文字判向 ±60°、ICP 初值 ±45° 内，然后**锁定精确平行角度**，
   后续只优化位移和基础缩放，不再让斜边把角度带偏。主边平行误差超过 1e-6° 明确报错。
   在保持包含的前提下尽量贴近轮廓；PDF 与建筑形状不一致时，不强行让全部边共线或拉伸变形。
   每条变换后的 PDF 边都按套索边界交点分段检查，不只检查顶点或少量采样点；
   最终 Hall 框线及所有 Booth 矩形必须完整位于整体 Hall 套索内。
   少量 Booth 若超出识别框线（例如像素包围框的末端 +1 差异），也加入优化约束，而非最后才报错。
   必要时缩小，不用裁剪隐藏越界。数值包含校验容差为 1e-7 Mercator 米，
   优化时使用更严格的 1e-9 米容差，避免转回地图坐标的浮点舍入造成越界。
   只有一个子馆时（例如東7）无法仅靠文字判向，改为全周角度搜索并用非对称轮廓确定方向；
   若轮廓存在近似等价的对称方向，则报错，需手动配准。
4. 保留原经纬度锚点，以当地地面米数写入新 `offset`、`rotation`、`scale` 和 `aspectRatio`，
   直接供现有绘制使用。所有计算在源识别坐标进行，不使用完整 PDF 页的显示变换，
   也不改变 OSM 或识别数据。

任一 Hall 缺少 Booth、有效子馆文字/OSM 闭合图形、方向有歧义、
无法生成包裹所有子馆的无自交套索、找不到可匹配的轴向长边、
无法在支持的缩放范围内完整放入套索或结果超出支持范围时明确报错，
整批保留原配置，不部分覆盖。仅手动点击按钮时执行自动计算，然后通过
`PUT /api/map/hall-transforms.json` 将整批结果原子写入 `ref/hall-transforms.json`；
保存成功后才应用新变换，保存期间禁用按钮，失败时保留原绘制配置并提示错误。
普通加载、刷新及后续绘制直接读取已保存的变换，不执行长宽比计算或 OSM 自动配准，
直到下一次手动触发重新计算。
计算模块仍返回包含校验及拟合残差报告，但页面不再展示报告或诊断叠加线。
识别回退矩形可能含空白/标牌，PDF 也不一定严格按建筑比例绘制，
因此这是近似几何配准，非矩形套索仍可能限制可用缩放，
应人工核对配准结果。完整包含约束仅用于自动配准的 Hall/Booth 几何；
文字字形及标记仍按原绘制规则显示。
页面不提供单独的保存入口，重新计算按钮同时负责保存；
需允许服务器写入配置及其所在目录。原始识别数据和 OSM 文件不会被修改。
保存接口只允许同源请求及 `HALL_EDITOR_ORIGIN` 指定的编辑器来源（默认 `http://localhost:5173`，用于 Vite 代理）。
这是本地编辑接口，未提供多用户权限/版本冲突管理，不应直接暴露到公开网络。

固定 Hall 读取接口为 `/api/map/final.json` 和 `/api/map/hall-transforms.json`；
缺失文件、无效数据或计算/绘制失败时记录控制台错误，并以红色重新计算按钮提示失败，
按钮悬停及无障碍标签提供错误详情；加载失败可点击同一按钮重试，不增加额外面板。

## 地图预览

运行 `npm run dev` 后打开 http://localhost:5173/preview。
选择页数查看完整 PDF 页面（含页眉、页码和页面留白）、识别图格和 Island 标记叠加，
支持背景、边框、Block 外扩框、编号、Island 标记、分组着色和缺号断点独立开关，
以及适应宽度和 50%–200% 缩放；放大后使用滚动条查看细节。

预览读取 `tools/booth-recognition/output/official-map/result.json` 和对应的
`page-NNN-pdf.png` 完整页面，不使用预生成的标注图。
`pages[].pdfPreview` 保存完整页面尺寸及从识别图坐标到页面像素的仿射变换；
Booth、Block、Island 和 Hall 的原坐标不改写，仅在绘制时统一对齐。
图片输入及没有 `pdfPreview` 的旧版结果仍使用 `page-NNN.png`。
完整 PDF 图片缺失或尺寸不匹配时明确报错，不偷偷退回裁切图。
首次使用或重新生成数据：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --pages all --output tools\booth-recognition\output\official-map
```

只列出识别输出实际包含的页码；当前示例 PDF 保留了前四页。
数据或图片缺失会显示错误，不会静默绘制空地图。
也可以点击预览页的「重新生成」：服务端使用上述虚拟环境和主脚本处理 PDF 全部页面，
同时更新预览结果和 Map 使用的 `final.json`；按钮在执行期间禁用，完成后自动刷新数据与底图，
失败时显示错误，详细日志见服务端终端。刷新页面后仍可查询当前任务状态；同一服务进程只运行一个任务。
接口为 `POST /api/preview/regenerate`（启动）和 `GET /api/preview/regenerate`（状态），
写入沿用 Hall 编辑器的同源限制及 `HALL_EDITOR_ORIGIN` 配置。

相关脚本：
- [PDF 识别命令入口](./tools/booth-recognition/test_recognition.py)
- [完整地图识别流水线](./tools/booth-recognition/map_recognition/pipeline.py)
- [结果及图片保存](./tools/booth-recognition/map_recognition/result.py)
- [Map 精简数据导出](./tools/booth-recognition/map_recognition/final_data.py)
- [服务端调用入口](./server/src/regeneratePreview.ts)

颜色表示识别状态，不代表人工核验过的准确率。

`Hall 边框` 开关显示每页场馆边界：原图连续闭合外框为红色实线；
没有可靠闭合外框时，取原图**全部非白色像素**的轴对齐包围矩形，显示为红色虚线。
后者包含文字、彩色标记、墙体和 Booth，不只按 Booth 包围框计算。
独立 [Hall 边框识别](./tools/booth-recognition/map_recognition/hall_outline.py) 不补接缺口、
不以凸包替代凹边界；闭合外框必须包含所有候选 Booth 的完整矩形，且具有大范围封闭内部。
确认闭合后，忽略短于 120 个原图像素的支撑边；方向差不超过 3°、位置接近的长边，
若端点间隔短于两者中较短的边，则跨过中间突出部分合并，延长相邻长边求交形成闭合边界。
无法安全重建（例如截掉 Booth、自交或长边不足）时明确记录警告并保留原轮廓；矩形兜底不变。
结果保存为 `pages[].hallOutline: {method, polygon, bbox}`；`polygon` 是原图像素顶点，
末点到首点隐式闭合。精简输出仅保存 `halls[].boundary` 顶点，不复制检测元数据。
旧版没有该字段的结果仍可预览；纯白图片无法确定边界时明确报错。

`场馆标签` 开关显示图内「東1/E1」「西2/W2」等深底白字或浅底深字标签及其文字范围，
与页面左上角的场馆名称 `venue` 分开记录。每页 `hallLabels` 保留实际 OCR 文本、
规范场馆名及代码、原图 `bbox` 和 `center`、旋转方向、置信度与复核状态。
支持四向和分行识别，相邻日文/英文同号配对；不同位置的重复标签分别保留。
完整 PDF 预览沿用同一坐标变换；精简输出为 `halls[].labels: [{id,text,code,pos}]`，
其中 `pos` 为原识别图中的文字中心，而非完整 PDF 页面的坐标。

React 使用原生 Canvas 2D，无需额外绘图库：
[MapPreviewRenderer](./client/src/preview/MapPreviewRenderer.ts) 管理画布和坐标缩放，
[绘图层](./client/src/preview/layers.ts) 分别封装背景、方框、编号和 Island 标记绘制，
[BlockLayer](./client/src/preview/BlockLayer.ts) 先绘制 Block 的真实外轮廓，再绘制去重后的内部横竖线，
[blockGeometry](./client/src/preview/blockGeometry.ts) 按矩阵行列数推导等距边线；不规则 Block 从成员坐标临时重建，
[BlockFrameLayer](./client/src/preview/BlockFrameLayer.ts) 另用蓝色虚线绘制向外扩展 6 个原图像素的矩形包围框，
[分组绘图层](./client/src/preview/assignmentLayers.ts) 独立绘制分组颜色和缺号断点，
[MapCanvas](./client/src/preview/MapCanvas.tsx) 负责 React 生命周期、图片加载和尺寸变化。
Booth 编号按照原图方向绘制，Island 标签正向显示，所有层使用原图像素坐标，
适配高分屏。Island 已识别标记为紫色；不确定项保留橙色/红色状态。
旧版 Booth-only 结果仍可预览，并明确提示尚无 Island 数据。
步骤 3 的结果会显示页面编号类型、修正/确认数量；标签后的 `*` 表示上下文校正或确认。
仍有边缘截断、方向问题的标记保持待复核，不会因为文字推断成功而清除其他问题。
步骤 2 显示像素接触的 Block 数量，不跨过道；L 形、缺格和空洞不会被补成整块矩形。
额外的 Block 外扩框仅用于 Preview 标注，可独立开关，并随 Island 筛选；
不替代真实轮廓，不修改识别结果或 PNG 导出。开启时画布增加留白，避免贴地图边缘的外扩框被裁切。
步骤 4 显示 Booth 归属，支持选择某一个 Island 查看着色范围。
同岛允许真实缺号，但不允许重复编号；缺号后第一个 Booth 的编号在格外用橙色引线标注，
例如缺 89–92 时在 93 格旁标注 `93`。此标注只由 Preview 推导绘制，
不修改 Booth 93 的数字、坐标、OCR 或问题记录，也不补造不存在的格子。
后端仅通过 `/api/preview/result.json`、`/api/preview/page-NNN.png` 和 `/api/preview/page-NNN-pdf.png`
提供白名单文件，不暴露工具目录。

## 地图识别工具

独立的 [地图识别模块](./tools/booth-recognition/README.md)
支持 PDF/图片输入，通过 OpenCV 定位方格、PaddleOCR 识别两位数字，
并通过单独的 Island 模块定位彩色编号、识别大小写英文字母及平/片假名。
主脚本通过六个独立阶段流水执行：

1. `BoothRecognitionStep`：定位 Booth、识别两位数字。
2. 独立的 [BoothBlockGrouper](./tools/booth-recognition/booth_blocks/grouping.py)：
   仅按边框像素接触生成 Block，输出成员、包围框和矩阵行列数，不改写 Booth 坐标或保存逐条边线。
3. `IslandRecognitionStep` + `IslandContextRefiner`：识别彩色编号，
   推断页面类型并结合可靠邻居校正疑难项。
4. 独立的 [BoothIslandAssigner](./tools/booth-recognition/island_assignment/assigner.py)：
   以 Block 为不可拆分单位，结合过道排列、壁摊转角、重复标记和编号唯一性，
   使用本地 OR-Tools CP-SAT 全局划分；硬约束冲突时明确报错，不降级成错误归属。
5. 独立的 [IslandMarkerAligner](./tools/booth-recognition/map_recognition/marker_alignment.py)：
   仅用 marker 中点对齐附近行列，内部 Island 再尝试沿另一轴居中；
   壁摊只与附近同向、同侧壁摊标记对齐，不参与内部 Island 居中。
6. 独立的 [HalfBoothSplitter](./tools/booth-recognition/map_recognition/half_booths.py)：
   按 grid 走向和同 Island 邻近编号将原 Booth 等分为 a/b；内部 Block 两端改为平行切线。
   新增 `pages[].halfBooths`，原 Booth 和 Island → Block → Booth 映射不变。
   Preview 的 `Half-booth a/b` 开关显示切线及编号后缀，并跟随 Island 筛选。

输出 `step-1.json`（原始 Booth/Island OCR，沿用旧命名）、
`step-2.json`（编号校正后、划分前）、`block-grouping.json`（独立 Block 结果）
和 `result.json`（schema 7，带 Block、归属、缺号和 marker 中心点的最终结果）。
完整流水线保存 `result.json` 后，还会生成独立的 `final.json`：
以 `halls → islands → blocks → booths` 嵌套，仅保留场馆名、Island 编号/marker 中心点、
Block ID/外框/可选 grid，以及 Booth ID/两位编号/外框/a-b 位置映射。
例如 `split: {a: "l", b: "r"}` 表示 a 在左、b 在右，`t/b` 表示上/下；
未知值保留 `null` 并输出警告。不重复导出 half-booth 坐标或统计、评分、推断数据。
每页保留独立坐标系；此精简文件不替代 Preview 使用的 `result.json`。
跳过划分的模式不生成新的精简文件；可通过工具文档中的独立命令从已有完整结果重新导出。
最终 `islandMarkers[]` 仅保存 `center: {x, y}`，不再保存 `bbox`；
原始 OCR 外框仍保留在阶段快照中。Preview 在中心点绘制半径 2.5 px 的圆点，
文字在中心上方 24 px，不再描 marker 外框；画布自动补足顶部留白以避免文字裁切。
每页使用 `islands[].blockIds` → `blocks[].boothIds` 单向映射：
不在 Booth/Block 中重复保存父级 ID，也不再导出 `islandAssignment.components` 或 Island 的完整 Booth 列表。
规则 Block 以 `bbox` + `grid: {rows, columns}` 表示；不规则 Block 的 `grid` 为 `null`，
Preview 从已有 Booth 坐标重建真实形状。`outline`、`dividers` 只在内存中生成，不写入 JSON。
求解元数据仍保留于 `islandAssignment`，逐 Booth 的待复核依据集中保存在 `assignmentReviews`，
它只记录复核问题，不重复记录归属关系。Preview 仍兼容旧版 schema 1–6。
未识别候选不视为 Booth 参与划分，保留在 `excludedCandidates`，不丢弃原始记录。
重复标记按同页同编号合并为逻辑 Island；编号仍不可靠的 Island 可以保留 `label: null`，
其 Booth 有稳定的逻辑 Island ID，但官方文字仍需复核。
使用 `--no-assignment` 仅跳过划分，`--ocr-only` 同时跳过编号校正与划分。
这两种模式仍生成几何 Block；`--booths-only` 保留旧版纯 Booth 输出。
Half-booth 分割需要已完成的 Island 划分；跳过划分时不生成 half-booth，也不猜测其 a/b。
全程不依赖启动网页或数据库；已有 Python 环境需重新安装工具的 requirements 以加入 OR-Tools。

独立的 [VenueRecognizer](./tools/booth-recognition/map_recognition/venue.py) 识别左上角的场馆编号，
写入 `pages[].venue`，例如 `label: "東123"`，并保留 OCR 原文、置信度、状态和复核问题。
PDF 页眉不在嵌入的地图图像内，因此使用本地 PDFium 单独栅格化页眉；不改变 Booth 的原图坐标。
图片输入则识别图片左上方区域。检测模式不运行场馆 OCR；旧结果缺少该字段仍可预览。
Preview 在页数选项及页面说明中显示场馆编号，低置信度标记为待复核。

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

空白网页无需数据库即可启动。使用数据库前，先启动 MySQL，
准备具有适当权限的用户，然后复制环境变量示例：

```powershell
Copy-Item server\.env.example server\.env
```

编辑 `server/.env` 的 `DATABASE_URL`，替换用户名、密码、主机和数据库名。
用户名和密码中的特殊字符需要 URL 编码。不要提交 `.env`。

Drizzle 连接位于 [server/src/db/index.ts](./server/src/db/index.ts)，
表定义放在 [server/src/db/schema.ts](./server/src/db/schema.ts)。
已定义 `booths`、`crawl_jobs`、`circle_list_cache` 和 `map_vacancies`。首次运行时使用具有建库权限的账号执行：

```powershell
npm run db:init
```

此命令在数据库不存在时创建数据库，再应用已提交的 Drizzle 迁移；
重复执行不会清空数据。MySQL 服务本身需要事先安装并启动。
日常运行可换用仅具有应用所需读写权限的账号。修改表定义后运行：

```powershell
npm run db:generate
npm run db:migrate
npm run db:studio
```

生成的 `server/drizzle` 迁移文件应纳入版本控制。

- `GET /api/health`：应用存活检查。
- `GET /api/health/db`：通过 Drizzle 执行 `SELECT 1`；
  未配置或连接失败返回 HTTP 503，详细错误记录在后端日志中。

## 社团采集 Dashboard

访问 `/crawler`。前端可以初始化数据库、开始/停止/继续采集、查看当前动作、
进度及一条已落库的示例数据；关闭网页不影响服务器上的任务。
停止或服务重启后点击“继续 / 重试失败项”，根据 `booths` 中实际存在的记录跳过已成功保存的详情，
而非仅信任任务的成功 ID 数组；数据库被清空或某条记录被删除时，会重新读取缺失项。
完整列表独立缓存到 MySQL `circle_list_cache`，重启、开始新任务和继续任务均可复用，
缓存记录数量、完成时间及活动/届数；旧版已完整读取的任务会自动迁入缓存。
没有完整缓存时重新逐日读取列表，不将部分列表标记为成功。
缓存不会自动检测网站换届或名单修改；这时点击“刷新列表并采集”，强制重新读取全部列表，
成功后替换缓存。刷新失败不会覆盖之前的完整缓存。

页面主按钮：

| 按钮 | 功能 |
|---|---|
| 初始化数据库 | 建库及应用迁移，保留已有数据，不是清空操作 |
| 开始采集 | 新建任务，优先使用完整列表缓存；按数据库跳过已保存详情 |
| 继续 / 重试失败项 | 继续上次任务，只读取数据库中尚未保存的记录（包括失败项） |
| 刷新列表并采集 | 强制重新读取列表，再采集缺失详情；不会清空已有 booth |
| 停止 | 请求停止当前采集，保留已保存数据、图片和进度 |
| 打开登录窗口 | 打开服务器浏览器的登录画面 |
| 清除登录会话 | 清除网站登录状态，不删除 booth、图片或列表缓存 |
| 清空数据和图片 | 删除全部 booth、地图未匹配位置、全部采集任务记录及 `<MEDIA_ROOT>/booths` 下的爬虫图片；保留表结构、完整列表缓存和登录会话 |

“清空数据和图片”仅在没有正在运行/停止中的任务时可用，需在弹窗输入“清空”再次确认。
后端同样验证确认文字并禁止与开始/继续/再次清空并发执行，不因前端按钮被绕过而允许冲突操作。
只清理 `booths/c数字/数字_序号.图片扩展名` 及对应下载临时文件，不清理整个 `MEDIA_ROOT`；
未知文件、额外子目录或符号链接会阻止操作并明确报错，避免误删其他资源。
SQL 清理在一个事务中执行，但文件系统与 SQL 不在同一事务；图片删除失败时会明确提示可能已部分清空，
排除权限等问题后可以重试。清空不会自动开始采集；之后点击“开始采集”，即可复用缓存按新规则重新下载全部详情。
登录窗口内的“确认登录”用于验证并保存会话，“暂时关闭”只隐藏窗口，
“重试打开登录页”用于重新加载；其余发送文本、按键及滚动按钮用于操作远程网页。

**当前按需求不实现管理账号鉴权。页面、控制 API、登录画面及输入接口都是公开的。**
任何能访问它们的人均可控制采集及第三方登录会话。使用真实账号前，
必须通过防火墙、VPN 或反向代理限制整个 `/crawler` 和 `/api/crawler` 的访问，
不要只隐藏导航。跨站请求检查不等于身份验证。后续可以通过
`createApp` 的 `authorizeCrawler` middleware 对全部采集 API 统一鉴权，
并同时保护前端路由。

### 本地运行与登录

```powershell
npm install
npx playwright install chromium
npm run db:init
npm run dev
```

1. 在 `server/.env` 配置 `DATABASE_URL`；必须先配置并启动服务，网页不能设置数据库密码。
2. 打开 http://localhost:5173/crawler，点击“开始采集”。
3. 无有效会话时自动打开 dashboard 登录窗口。该画面来自**服务器上的
   headless Chromium**，并非嵌入第三方网站，所以本地测试和远程部署使用同一流程。
   点击“打开登录窗口”会立即显示窗口和浏览器启动提示，不等待网站加载完成。
   启动或网络错误会显示在窗口内，可点击重试；若提示后端响应超时，
   检查开发终端或调试器是否暂停，必要时重新启动 `npm run dev`。
   弹窗只由实际打开的服务端登录窗口触发，不会因后台正在验证已保存会话而弹出。
   登录成功后自动关闭弹窗并停止截图；服务重启导致窗口丢失时提示重新打开，
   截图接口以 HTTP 409 表示窗口已关闭，不再将正常的窗口关闭视为 HTTP 500。
4. 点击画面中的字段直接输入；中文/粘贴可用下方隐藏内容的输入栏，另提供
   Tab、Enter、全选及滚动按钮。手动完成网站要求的验证后，点击“确认登录”。
5. 服务端访问受保护的 `/Spa` 验证登录，成功后保存会话并继续任务。
   网站主动拒绝自动化、验证码或权限要求均不绕过。
   服务重启后会先验证并复用已保存的有效会话；确认失效才重新打开登录窗口。

登录模块与采集模块分开，窗口按约一秒一帧传输 JPEG；
每帧只请求截图，直接处理接口返回的启动中、已关闭、登录成功或错误状态，不再额外请求一次登录状态。
不是完整远程桌面：
不支持文件上传、拖拽及本地设备绑定的 Passkey；顶层导航仅允许 `circle.ms`
及其子域。若站点启用外部身份提供商或设备绑定登录，需要进一步适配，
不能保证所有认证方式兼容。窗口关闭按钮只关闭前端显示，不会注销网站。

### 采集与存储约定

- 使用 Crawlee `CheerioCrawler` 静态读取
  `https://classic-webcatalog.circle.ms/Circle/Syllabary`，
  从 `.date-list` 发现日期，从 `.sortnav-list` 发现五十音行。
  先读取第一日的全部行，再逐日重复；当前无链接的行也计入采集范围。
  行链接可能省略日期，因此每个后续请求都显式设置 `Day` 和 `column`，
  不继承 genre、地区等筛选条件。仅提取 `.md-circlelist` 中的详情链接并跨页去重。
  当前样本为 3 日 × 10 行；不硬编码日期数量，允许合法空行。
  单并发、每分钟最多 60 个请求、失败最多重试两次。
  只有全部日期/行页面结构校验和解析成功才进入详情阶段；
  超时、错误日期、导航变化或任一页面失败都不会被视为完整列表。
  Dashboard 动作文本显示日期、行名、已完成页面数和社团数量，无需滚动等待。
  静态列表没有 `eventId` 时，由首条详情确定并持久化活动 ID，后续详情必须一致。
- 随后 `CheerioCrawler` 请求 `/Circle/<id>`，最大并发为 **5**，
  每分钟最多启动 180 次详情请求（包括重试），失败最多重试两次。
  静态列表遇到登录页，或详情/图片检测到登录失效时暂停等待远程登录。
  Playwright 仅用于远程交互登录及会话验证，不再用于列表采集。
  其他请求错误明确记录；失败项可点击继续重试。
- 详情主键取当前页面 ID，`circle_id` 取社团主页 ID，二者不同；无社团主页链接时保存 SQL NULL，
  不因此放弃该参展记录。活动 ID、社团名和届数仍必须存在。
  届数从分享 URL 中的 `hashtags=C109WebCatalog` 或静态分享按钮的
  `data-hashtags="C109WebCatalog"` 等标记识别，
  不根据来源 `eventId` 推算。不同详情必须属于同一活动及同一届。
- `weekday` 为 `char(1)`，例如 `火`。配置位置拆为 `hall`、`island_code`、
  `booth_number`（保留 `04` 的前导零）、`booth_suffix`，不保存完整 `location`。
- `circle_appeal` 保存「補足説明/サークルアピール」，`tags` 保存「タグ」，
  分别使用可空的 `LONGTEXT` 列。保存纯文本，保留换行、段落及标签分隔，不保存 HTML；
  页面字段为空时保存 SQL NULL。已有记录不会自动回填，后续重新采集的记录才写入这两列。
- `images` 是一个 **TEXT column**，保存 JSON 字符串数组，例如
  `["24031654_1.png","24031654_2.png"]`，不是额外图片表，也不是 SQL JSON 类型。
  下载详情图片区域 `.m-circletable-cuts` 中所有 `/Spa/CachedImage/<任意ID>/2/...` 图片，
  不要求图片来源 ID 与当前详情 ID 相同；忽略 `/1/`、其他来源站点、广告及 Pixiv 作品。
  按页面顺序对 URL 去重后，以当前详情 ID 和从 1 开始的连续序号命名：`24031654_1`、`24031654_2` 等；
  文件名中的序号不代表来源图片类型或来源 ID。
  若页面没有 `/2/` 图片则保存空数组，不以 `/1/` 图片代替。
- 图片保存在 `<MEDIA_ROOT>/booths/c109/24031654_2.png` 等路径，
  不按 booth 再建子目录；数据库数组只存文件名。
  扩展名根据实际 PNG/JPEG/GIF/WebP 内容识别；图片写入临时文件后原子替换。
  图片支持最多五次 HTTPS 重定向，目标仅限来源站点和 Azure Blob 存储；
  网站 Cookie 不会转发给 Azure。登录重定向会暂停等待登录，
  其他不支持的目标或下载错误明确报错，不误报为登录失效。
  详情全部目标图片保存成功才写入 booth 并增加成功进度。
  SQL 与文件系统不是同一个事务，数据库写入失败时可能留下尚未引用的图片，
  继续任务会使用相同文件名重新下载并更新，不新增重复 booth。
  高频详情进度快照最多每秒写入一次，阶段切换、结束及停止仍立即保存；
  图片和 booth 仍逐条可靠写入。崩溃时未写入快照的成功记录由数据库恢复，不会重复读取。
  此图片规则适用于后续采集；数据库中已有的成功记录仍会跳过，不会自动回填或删除旧图片。

环境变量（相对路径从项目根目录解析）：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MEDIA_ROOT` | `storage` | 图片根目录 |
| `CRAWLER_STATE_DIR` | `.local/crawler` | 私密登录会话及 Crawlee 工作目录 |
| `HALL_EDITOR_ORIGIN` | `http://localhost:5173` | 允许的管理页面 Origin；HTTPS 代理后设为实际站点 Origin |

任务 ID、列表 ID、成功/失败项及示例数据保存在 MySQL `crawl_jobs.state`，
每次进度更新持久化。当前支持**单个 Node 实例、单个活动任务与单个网站账号**，
不是多实例分布式队列。登录会话保存在私密状态目录，不通过 API 返回 Cookie，
不写入图片目录、不提交 Git；提供清除会话按钮。需要备份 MySQL 和图片；
会话文件若要备份，应单独加密。不要提交含个人信息或防伪令牌的登录后 HTML。

### Ubuntu 24.04 部署

安装项目支持的 Node.js 和 MySQL，在项目目录执行：

```sh
npm ci
npx playwright install --with-deps chromium
npm run db:init
npm run build
npm start
```

无需 Xvfb、桌面或 noVNC；Chromium 以 headless 模式运行。
`server/drizzle` 必须随服务部署，用于 CLI / dashboard 初始化。
图片与私密状态目录应指向持久化存储，不能放进每次发布都会清空的构建目录；
保持私密目录仅服务账号可访问。使用 HTTPS，并配置
`HALL_EDITOR_ORIGIN` 为实际公开 Origin。浏览器远程输入经过服务器，
应只部署在可信服务器上。自动初始化只创建数据库及表，不安装 MySQL。

### 验证

`npm test` 包含 Chromium 登录集成测试，需要先安装 Playwright Chromium。
列表测试使用本地 HTTP 服务验证逐日逐行顺序、保留日期、清除筛选、
空行、去重、错误日期、请求失败及登录失效；
真实列表与详情解析均使用参考 HTML，不登录实际网站。
另外使用本地 HTTP 服务验证完整详情流水线的实际峰值并发为五、
图片平铺落盘、进度及示例数据、三次失败后重试恢复和跳过已完成项；
真实 Chromium 验证远程输入、登录确认、会话保存/恢复及过期重新登录。
详情失效测试覆盖登录 HTML、401、403 和跳转登录页。
真实账号的登录、网站当期完整列表及访问配额仍需在授权会话下联调验证。

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
