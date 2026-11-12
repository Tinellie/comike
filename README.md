# Comike

空白全栈项目：TypeScript、Node.js、React、Vite、React Router、Express、
MUI、MySQL 和 Drizzle ORM。

界面包含主导航栏、空白 Home (`/`) 和 OSM 地图 Map (`/map`)。
未添加数据库业务表。
另提供 Preview (`/preview`) 用于查看地图识别结果。

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
右侧面板底部以小字显示 `Hall / Island / 编号a或b`；未命中显示 `—`。
检测随地图平移、缩放、旋转及楼层过滤更新；隐藏的 Hall 不参与，重叠时优先较高楼层及后绘制的 Hall。
鼠标移动仅按帧合并命中查询，不触发整幅地图重绘。
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
数据或图片缺失会显示错误，不会静默绘制空地图；生成后刷新预览页。
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
