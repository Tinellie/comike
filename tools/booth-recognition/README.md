# Booth / Island 地图识别

独立 Python 模块，不依赖 Node、数据库或网页服务。全程本地处理：

1. 从 PDF 提取原始地图位图，或直接读取 PNG/JPEG 等单帧图片。
2. OpenCV 按重复矩形尺寸检测格子、去重、修复短缺口，并补检单条边完整缺失的三边格。
3. 抽样确定整张图的数字方向，去边框、补白后批量调用 PaddleOCR 的
   `TextRecognition`，不使用整图文字检测器。
4. 对疑难格使用二值化版本重试；保留低置信度、处理分歧及边框修复标记。
5. 独立 Block 模块将边框像素直接接触的 Booth 分组，并生成外轮廓和内部共享边。
6. 独立的 Island 模块通过彩色像素定位编号，合并字符的分离笔画，
   裁切后调用 PaddleOCR 识别大小写英文字母、平假名和片假名。
7. Island 阶段推断页面编号类型，使用可靠邻居的局部序列校正疑难字符。
8. 独立的划分模块以 Block 为不可拆分单位，结合排列/壁摊拓扑、标记位置及编号唯一性，
   用 OR-Tools CP-SAT 全局求解 Booth → Island 归属，记录真实缺号，不伪造格子。

流水顺序为 **Booth 识别 → Block 分组 → Island 识别（含编号校正）→ Island 划分 → marker 中心点对齐 → half-booth 分割**，
分别封装为 `BoothRecognitionStep`、`BoothBlockGrouper`、`IslandRecognitionStep` / `IslandContextRefiner`、
`BoothIslandAssigner`、`IslandMarkerAligner`、`HalfBoothSplitter`。旧 `OcrRecognitionStep` 仍可单独调用，组合两个原始 OCR 模块。

另由独立的 [VenueRecognizer](./map_recognition/venue.py) 在原始 OCR 阶段识别页面左上角场馆标题。
它与 Island OCR 共用文字识别模型，且不参与 Booth/Block/Island 分组。
PDF 使用 PDFium 以 3 倍分辨率单独渲染左上方页眉（左侧 85%、顶部 12%），
因为页眉通常不在提取出的嵌入地图图像内；图片输入使用左侧 85%、顶部 15%。
只接受带“ホール”的方向及编号标题，避免将地图内“東3/E3”等入口标记当成整页场馆。
归一化全角数字、兼容字形和 OCR 中“ホ－ル”的横线，但不根据页序猜测编号。

`result.json` 及 OCR/校正快照每页新增：

```json
"venue": {
  "label": "東123",
  "rawText": "ComicMarket109 1日目 東123ホール",
  "recognitionScore": 0.96,
  "status": "recognized",
  "issues": []
}
```

`label` 不包含“ホール”；没有可靠文字或出现冲突时为 `null`，状态为 `unrecognized`，
并记录 `no_header_text`、`venue_not_found` 或 `ambiguous_venue`。
低于 0.90 置信度保留候选编号但标记 `needs_review` / `low_confidence`。
`--detect-only` 输出 `not_run`；`--booths-only` 仍为独立的原始 Booth 结果，不执行场馆识别。
字段属于附加页面元数据，不改变 Booth 像素坐标或归属；旧结果不含该字段也能预览。

## 安装

推荐 Windows x64、Python 3.10–3.12，使用独立虚拟环境。
下面的命令均从仓库根目录执行，不需要激活环境：

```powershell
python -m venv tools\booth-recognition\.venv
tools\booth-recognition\.venv\Scripts\python.exe -m pip install -r tools\booth-recognition\requirements.txt
```

使用 CPU PaddlePaddle，无需 CUDA。首次 OCR 会从 PaddleOCR 官方配置的
模型源下载权重并缓存在用户目录下，可能需要等待；地图和裁切图片不会上传。
模型不可用、依赖错误或推理异常会明确报错，不降级成“识别成功”。
划分使用本地 OR-Tools 求解器。已有环境也需重新执行上述安装命令以添加依赖。
VS Code 中也应选择 `tools\booth-recognition\.venv\Scripts\python.exe` 作为 Python 解释器；
系统 Python 不共享该环境的依赖，可能仍提示无法解析 `ortools` 导入。

## 测试实际地图

默认读取仓库的 `ref/official-map.pdf` **第 1 页**：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py
```

默认按上述六个阶段执行。只检测两类标记的坐标、不加载模型，
明确跳过文字校正及 Booth 划分：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --detect-only --pages all
```

示例 PDF 已保留前四页。选择页面，或处理全部页面：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --pages 1,2,3,4
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --pages all
```

仅运行原有 Booth 模块，输出兼容的 schema 1：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --booths-only --pages all
```

执行 Booth/Island 原始 OCR 与几何 Block 分组，输出 schema 7，不校正或分配 Island，仅记录 marker 原始中心点：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --ocr-only --pages all
```

保留 Block 和编号校正，只跳过 Island 划分，输出 schema 7，仅记录 marker 原始中心点：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --no-assignment --pages all
```

`--assignment-time-limit` 为每页求解时限，默认 30 秒。找到可行解后仍可能继续优化至时限；
输出明确区分 `feasible` 与已证明最优的 `optimal`，不把前者宣称为全局最优。
未找到可行解、编号冲突或标记不足时，打印结构化错误，退出码为 2，不保存新的最终结果，
旧输出不会自动删除。不会把最近标记当作失败后的静默兜底。

指定输入、输出和置信度：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py .\map.png --output .\map-result --confidence 0.95
```

CPU 处理几千个格子可能需要数分钟。日志会显示候选格数量、方向及进度。
Booth 默认轻量模型为 `en_PP-OCRv5_mobile_rec`，可用
`--model PP-OCRv5_server_rec` 对比大模型效果。离线运行时使用
`--model-dir <模型目录>`，并让 `--model` 与本地模型匹配。
Island 默认使用 `PP-OCRv5_server_rec`，遇到日文页或主模型有效结果不足时，
再调用 `japan_PP-OCRv3_mobile_rec`。使用 `--island-model`、
`--island-model-dir`、`--island-kana-model-dir` 指定主模型或离线目录；
离线目录须分别对应这两个模型。`--island-confidence` 默认 0.90，
Booth 的 `--confidence` 默认 0.95。置信度是模型原始评分，不是经过校准的正确概率。

### Island 异常裁切框重试

每页完成原始 Island OCR 后、编号上下文校正之前，单独统计该页检测框尺寸：

- 至少 5 个候选框；以宽、高中位数为初筛基准，保留两个维度均在 0.65–1.65 倍内的框，
  再计算这些框的平均宽、高。有效框至少 3 个且占该页过半，否则不使用不可靠的均值。
- 宽或高超出上述平均尺寸 0.65–1.65 倍范围的 marker 触发重试，正常尺寸不增加 OCR。
  扩框保持原中心，每个维度取 `max(原尺寸, 平均尺寸) × 1.25` 向上取整；
  不缩小原框，裁至图像边缘，并以与相邻 marker 原框的间隙中线限制扩展，避免带入其他编号。
- 在原始彩色像素掩码上重新裁切，按页面已确定方向运行主模型的原图/去细笔画版本；
  该页已启用日文模型时也重试日文模型。
- 新候选须达到识别阈值、扩框版本之间无高分歧义，且原编号无效或新结果更可靠才采用。
  不把正常的窄字符（如 I、i）仅凭框尺寸改成另一个字；低分或互相冲突的重试保留原结果。
  与原高分编号冲突时仍标记 `recognition_disagreement`，供后续上下文校正或人工复核。

原检测 `bbox`、marker ID、数量和后续定位依据不变。详细输出/阶段快照中，触发重试的 marker
增加 `cropRetry`，记录平均尺寸、实际扩框、原始识别结果和是否接受新结果；
扩框 OCR 候选以带 `:expanded` 的模型名追加到 `alternatives`，不覆盖原候选。
`--detect-only` 不运行该 OCR 重试；精简 `final.json` 不增加诊断字段。

## 输出怎么看

### 完整 PDF 页面预览

PDF 输入在识别后通过 [pdf_preview](./map_recognition/pdf_preview.py) 用 PDFium 栅格化完整页面，
保存 `page-NNN-pdf.png` 及 `pages[].pdfPreview: {image, width, height, transform}`。
`transform` 为 Canvas 格式 `[a,b,c,d,e,f]`：
`pageX=a*x+c*y+e`、`pageY=b*x+d*y+f`，把识别图像素映射到完整页面像素。
变换来自 PDF 嵌入图片的实际矩阵与页面旋转，不按大致包围框猜测。
渲染分辨率匹配嵌入地图的像素密度，保留页眉、页码、标题及页面留白。
无法匹配嵌入图片尺寸或定位矩阵无效时明确报错。

Preview 使用完整页面作为背景，所有标注在原坐标基础上应用此变换，
适应宽度及百分比缩放按完整页面尺寸计算。关闭背景仍保留完整页面画布和正确的标注位置。
`page-NNN.png` 仍是识别和 Hall 检测依据；不会将 PDF 页眉计入 Hall 的非白色像素矩形。
图片输入及无该字段的旧版结果仍按原图预览。此预览元数据不写入精简业务文件。

### Hall 边框

组合流水线在后处理中调用独立的 [detect_hall_outline](./map_recognition/hall_outline.py)，
不依赖 OCR 重新运行或 Island 求解。使用提取后的原图像素坐标：

- 优先从中性色深线中寻找具有大范围封闭内部、且外轮廓包含所有候选 Booth 完整矩形的外框。
  检查真实轮廓层级，不能把普通 Booth 自身的闭合方格当作 Hall。
  多个有效嵌套外框取最外侧；确认闭合后先以 2 px 容差清除栅格锯齿，
  再忽略长度小于 120 个原图像素的支撑边（120 px 本身保留）。
  长边方向差不超过 3°，且端点到较长边所在直线的距离不超过较短边长的 1%
  （下限 3 px、上限 12 px）时，若端点间隔短于较短边，可跨过中间边段合并。
  合并以较长边所在直线为准；延长相邻支撑线求交，组成连续闭合边界。
  保留不能按以上条件合并的主要凹角，不使用凸包。
  重建需保持在图内、无自交且包围全部 Booth；长边不足或校验失败时记录警告并保留原像素轮廓。
  不做闭运算、膨胀、跨缺口连接或凸包补全，单像素贯穿缺口也不自动修复。
- 没有这样的外框则使用全部非白色像素的最小轴对齐矩形，
  包括文字、彩色标记、浅色像素、墙体和 Booth。
  RGBA 图片先合成到白底，透明背景不算黑色；纯白图报错，不编造整图边界。

完整结果新增 `pages[].hallOutline`：

```json
{
  "method": "nonwhite_bbox",
  "polygon": [{"x": 0, "y": 2}, {"x": 199, "y": 2}, {"x": 199, "y": 149}, {"x": 0, "y": 149}],
  "bbox": {"x": 0, "y": 2, "width": 200, "height": 148}
}
```

真实闭合外框的 `method` 为 `closed_frame`；矩形兜底为 `nonwhite_bbox`。
顶点按顺序排列，末点到首点隐式闭合，包围框尺寸包含边框像素。
此字段不改变原始 Booth/Block/Island/half-booth 坐标，也不进入 OCR 中间快照。
精简导出为 `halls[].boundary`，仅保留顶点；旧结果没有边框时仍可精简导出。
Preview 默认启用独立 `Hall 边框` 层：闭合原框红色实线，矩形兜底红色虚线。

### 图内场馆标签

独立 [HallLabelRecognizer](./map_recognition/hall_labels.py) 在后处理阶段识别地图中的
「東1/E1」「西2/W2」「南1/S1」等深底白字或浅底深字标签，不改写页眉场馆名称 `venue`，
不影响 Booth/Island 识别或 Hall 边框。先定位两种明暗极性的字形，排除大面积留白、
墙体长线及已有 Booth 范围内的深色编号，
再用已有 `PP-OCRv5_server_rec` 识别 0/90/180/270° 的逐行文字，无需新增模型或重新识别 Booth。
只接受完整的方向加编号文本；规范化全角字符，支持東/西/南/北与 E/W/S/N。
相邻、同方向、同编号的日英文字可配对；同一语言的重复标签不会互相合并。

每页保存 `hallLabels[]`：`id`、`text`（实际 OCR 文本）、`label`（规范日文名）、
`code`（规范英文编号）、`bbox`、`center`、`rotation`（逆时针 OCR 纠正角度）、
`recognitionScore`、`status`、`issues`。规范名和代码可由单一语言换算，不表示另一语言也被 OCR 读出；
日英冲突时不猜编号，保存空代码并标记待复核；低置信度同样记录警告。
检测模式保留 `not_run` 候选；非场馆文本不导出。当前定位针对地图的中性色文字，
不是任意背景、任意样式文字的全图 OCR。未发现标签时保存空列表。

位置始终为原始识别图像素，`center = (x + width/2, y + height/2)`；
Preview 的独立 `场馆标签` 层经现有 PDF 仿射变换对齐，可在关闭背景后查看。
同一场馆不同位置的出现分别保存，不推断场馆区域分界。
精简导出增加 `halls[].labels: [{id, text, code, pos}]`，只保留文本、编号和中心位置。
旧结果没有该字段时保持兼容。

默认目录为本模块的 `output`，不纳入 Git。每次运行覆盖同名结果文件；
如需对比，请使用不同 `--output` 目录。

- `step-1.json`：原始 Booth/Island OCR（沿用旧命名，schema 2）。
- `step-2.json`：编号校正后的 Booth/Island 结果，划分前快照（schema 3）。
- `block-grouping.json`：独立 Block 分组快照，包含每页成员、包围框及矩阵行列数，不含 Island 归属或逐条边线。
- `result.json`：最终结果，包含尺寸、格子/Island 坐标、文字、评分、问题和校正依据。
- `final.json`：保存 `result.json` 后生成的精简业务数据，嵌套为 `halls → islands → blocks → booths`，不含统计、评分、推断或备用数据；字段见下文。
- `page-001.png`：提取后的原始底图；坐标对应这张图。
- `page-001-pdf.png`：PDF 输入的完整页面；Preview 通过 `pdfPreview.transform` 对齐识别标注。
- `page-001-overlay.png`：Block 外轮廓/内分割线、Booth 数字与按最终状态着色的 Island 方框/出现位置 ID。
  PNG 使用 ASCII ID，避免依赖日文字体；网页 Preview 显示真正的 Island 文字。

### 精简业务数据

完整流水线保存 `result.json` 后，再由独立的 [final_data](./map_recognition/final_data.py) 读取已保存结果，
生成 `final.json`；不更改原结果、阶段快照、Block 分组或 Preview 的输入。
只保留以下字段：

```text
halls[]
  name                         ← page.venue.label
  islands[]
    id, code                   ← Island ID、label
    markers[]
      id, pos: {x, y}          ← 已对齐的 marker 中心点
    blocks[]
      id, bbox
      grid: {rows, columns}    ← 仅矩阵 Block 有此字段
      booths[]
        id, number, bbox
        split: {a, b}
```

`number` 保留 `"01"` 这样的两位字符串。`split` 从实际 half-booth 坐标计算，
`l/r/t/b` 分别表示左/右/上/下，例如 `{"a":"l","b":"r"}` 或 `{"a":"b","b":"t"}`；
不重复保存 half-booth ID、坐标或切线方向。无法确定 a/b 时整个 `split` 为 `null`。
场馆名或 Island 编号未知时也保留 `null`，不丢弃实体，并输出警告；详细原因仍查 `result.json`。
归属引用损坏、遗漏实体、重复归属或 half-booth 不是等分时明确报错，不写入新的精简结果。

每个原页面对应一个 hall，各自沿用该页原图坐标；即使场馆名相同也不合并页面。
不规则 Block 原样保留其 Booth，省略 `grid`，不会在精简阶段重分组。
`--detect-only`、`--ocr-only`、`--no-assignment` 和 `--booths-only` 不生成新的 `final.json`。
输出目录中旧文件不会自动清除，精简导出失败时旧 `final.json` 也保持不变。

已有完整结果可以不重跑 OCR/求解，单独重新导出（从仓库根目录执行）：

```powershell
Push-Location tools\booth-recognition
.\.venv\Scripts\python.exe -m map_recognition.final_data output\official-map\result.json
Pop-Location
```

文件写在输入结果旁，固定命名为 `final.json`。

标注颜色：

| 颜色 | status | 含义 |
| --- | --- | --- |
| 绿 | `recognized` | 两位数字且通过当前检查 |
| 橙 | `needs_review` | 低评分、边框修复、方向不确定或重试结果不一致 |
| 红 | `unrecognized` | 未得到合法两位数字，`number` 为 `null` |
| 蓝 | `not_run` | 仅检测，未执行 OCR |

JSON 中每个 booth 类似：

```json
{
  "id": "p001-b00001",
  "bbox": {"x": 28, "y": 40, "width": 29, "height": 41},
  "number": "73",
  "rawText": "73",
  "recognitionScore": 0.9999,
  "rotation": 0,
  "status": "recognized",
  "issues": []
}
```

- 左上角为原点，X 向右、Y 向下，单位为原图像素。
- 坐标不受 OCR 旋转影响；`rotation` 是裁切图校正时逆时针旋转的角度。
- bbox 包含边框，共边相邻格子的边框可能有少量像素重叠。
- `"01"` 保留前导零；`id` 是当次几何排序生成的标识，不是官方 booth 身份。
- `counts` 是检测和识别状态统计，**不是准确率**。
- `skippedPages` 明确列出没有内嵌地图的页。

### Island 结果

步骤 1 输出为 `schemaVersion: 2`，保留原有 Booth 字段，每页新增
`islandMarkers`、`islandCounts`，顶层新增 `islandCounts`、
`islandModel` 和 `islandKanaModel`。后两个字段记录配置模型，
日文辅助模型按需加载，不表示每一页都使用过它。

每个出现位置单独保存，不按同名字符合并：

```json
{
  "id": "p001-i0001",
  "bbox": {"x": 100, "y": 120, "width": 24, "height": 30},
  "color": "#ee2481",
  "label": "ア",
  "rawText": "ア",
  "recognitionScore": 0.97,
  "rotation": 0,
  "status": "recognized",
  "issues": [],
  "alternatives": []
}
```

- `id` 是标记出现位置 ID，**不是逻辑 Island ID**。重复出现的 `ア` 不代表两个 Island。
- `A`/`a`、平假名/片假名严格区分，只做 Unicode NFC 规范化。
- 基于颜色饱和度、连通域和相对尺寸检测，不预设具体颜色、编号表或页面位置。
  去除细小注音，合并分离笔画；保留原色与原图坐标，不修改底图。
- 尝试四个方向并选页级方向；日文辅助模型和去噪裁切结果用于对照。
  多个高评分结果分歧、低评分、边缘截断、方向不确定等均保留复核标记。
- `alternatives` 保留各模型、方向、裁切版本的结果，便于排查；
  步骤 1 中 `label: null` 表示没有合法单字符 OCR 结果。
- Preview 中已识别 Island 为紫色实线，待复核橙色虚线、未识别红色虚线、
  未执行 OCR 为蓝色。Booth 颜色保持上表定义。

### Island 阶段：页面类型与邻域校正

划分前的输出为 `schemaVersion: 3`，`processingSteps` 为
`["ocr", "island_context"]`。Booth 与原图完全不变，每页新增 `islandInference`，
每个 Island 标记新增 `inference`。Preview 兼容 schema 1–7。

子步骤分别封装在 [context.py](./island_recognition/context.py)：

1. **`PageTypeInferer`**：四类编号分别统计出现次数与不同字符。
   OCR 分数至少 0.5 的字符参与加权，每个不同字符只取最高分，避免重复壁摊
   标记压倒其他证据。领先类型至少有 3 个不同字符，且占加权票至少 75% 才确定类型；
   否则类型为 `null`，不改号。`confidence` 是加权票占比，不是正确概率。
2. **`MarkerNeighborhood`**：根据字符尺度建立局部横向/纵向对齐关系，
   在两侧各至多三个位置内寻找原始 OCR 可靠锚点，检查正向/反向连续性。
   间距不能超过典型间距的 2.2 倍或字符尺度的 8 倍；遇到断层不跨越。
   英文使用字母顺序，假名使用现代基本五十音顺序，不使用 Unicode 顺序。
3. **`IslandContextRefiner`**：处理待复核、未识别以及与页面类型不符的项。
   至少两个锚点须一致；两侧有锚点且字形支持至少 0.45 时可确认，
   没有字形支持则需要两侧合计至少三个一致锚点。
   只有单侧支持时仍需至少两个锚点及 0.5 的字形支持。
   原始 OCR、同方向备选、大小写/平片假名对应字形可提供支持，
   但**不单凭类型统一大小写或假名**。横纵推断冲突时不修复。

所有锚点来自步骤 1，要求 OCR 分数至少 0.90 且没有文字或方向问题
（只带图像边缘截断问题的项可作文字锚点）。
不会把刚修复的项继续当锚点，不因修复顺序形成连锁猜测。
重复编号、跳号或不满足局部序列的壁摊不强行串成一条序列。
濁音、半濁音、小假名等可保留 OCR 字符，但不套用基本五十音连续性补值。

`inference` 保留：

- `original`：步骤 1 的 `label`、`status`、`issues`。
- `outcome`：`corrected`（改字）、`confirmed`（确认原字）、`unresolved`、
  `not_needed` 或 `skipped`。
- `proposedLabel`、`supportingIds`、`reason`：候选编号、支持锚点和依据。
- `score`：独立的启发式上下文支持分数，不是概率，也不覆盖 `recognitionScore`。
- `resolvedIssues`：本次消除的文字问题。原始 `rawText`、OCR 分数、备选结果、
  方向、坐标均不修改；边缘截断、方向不确定及未知问题仍保留为待复核。

最终 `label` 是接受的修复结果；未接受的候选仅放在 `proposedLabel`。
Preview 以最终结果绘图，显示类型和校正数量，修正/确认后的标签带 `*`。
文字问题全部解除才将状态变为 `recognized`，其他问题不会被隐藏。

### 步骤 2：像素接触 Block 分组

独立模块位于 [booth_blocks](./booth_blocks)，只依赖 Booth 的几何/状态，不加载 OCR 或求解器。
判定使用含边框的整数像素坐标：左右/上下边框在同一像素或相邻像素，
且共享超过一个像素的边段，才连为同一 Block。只接触角点不连接；
只要中间已有一个空白像素便不连接，不使用相对格子尺寸或“距离近”的容差。
并查集处理传递连接，每个有效 Booth 恰好属于一个 Block，孤立 Booth 也是单格 Block。
`unrecognized` 候选被保留在排除记录中，不可作为连接桥；`not_run` 可仅按几何生成 Block。

JSON 不再保存 `outline` 或 `dividers` 数组，而是按需生成绘图几何：

- 规则矩阵保存 `bbox` 和 `grid: {"rows": 2, "columns": 15}`，完整等距排列才会标为矩阵。
  Preview 按边界宽高除以行列数，通过循环生成横竖边线，无需保存每条线的位置。
- L 形、阶梯、缺格、部分共边或空洞等不规则 Block 保存 `grid: null`，
  Preview 从 `boothIds` 引用的原始坐标重建真实外轮廓和去重的内分割线。
  不强制用包围矩形均分，以免填上不存在的格子。
- 同一矩阵内存在不同复核状态时，也从成员坐标生成边线，保留状态着色。
- 相邻像素的共边仅在显示几何中对齐，原始坐标、数字、评分和问题不变。
- Canvas `BlockLayer` 和 PNG 导出均先画外轮廓，再画分割线；共享边只绘一次。
  边线保留识别状态颜色，共享边有待复核成员时采用待复核颜色。
- 旧版无 Block 的输出仍按单个 Booth 描边，不静默猜测或改写旧数据。

### 步骤 4：Block → Island 划分

独立模块位于 [island_assignment](./island_assignment)。
输入是 Booth 识别结果、步骤 2 的 Block、校正后的 Island 标记，以及可选的页面编号类型；
无需原图或 OCR 模型。传入的 Block 会被校验，不能将过道两侧伪装成同一 Block。
兼容未传 Block 的独立调用，此时使用同一个 `BoothBlockGrouper` 生成，不维护第二套接触算法。

1. **Block 硬约束**：每个 Block 仅有一个 Island 选择变量。
   绝不因最近标记或重复数字而拆开同一个 Block。
2. **逻辑 Island 种子**：同页同名标记归并，保留所有出现位置。
   大小写/平片假名不折叠；与已知页面类型冲突的未解决文字使用 `label: null`
   的独立逻辑 ID，保留来源标记，不能把错误文字冒充官方编号。
3. **布局证据**：同轴组件跨过道连接；单格宽组件可经转角连接。
   多次标记在两轴上大范围分布时，给出环绕式壁摊先验，不预设具体编号或馆名。
   单格宽以 Booth 数量与主轴跨度估算，避免把沿斜墙阶梯排列的单排误判为多排矩阵。
   标记沿行/列方向的距离折扣处理，避免顶部/过道标记被误判给邻排。
4. **全局求解**：每个组件只取一个 Island，同 Island 每个两位编号至多出现一次；
   位置距离、切断布局链接的代价和编号跨度共同构成优化目标。
   缺号是允许的软代价，不根据缺号制造 Booth，不要求从 01 开始。
5. **独立校验**：重新计算相接关系，核对 Booth 全覆盖、同岛编号唯一、
   组件/成员引用及缺号统计。只有验证通过的结果才返回。

`unrecognized` 候选不视为 Booth 参与划分，原样保留在每页 `excludedCandidates`。
有合法编号的 `needs_review` Booth 仍参与，不会以“待复核”为由丢格。
数字尚未 OCR 的 `not_run` 数据不参与 Island 划分；`--detect-only` 明确跳过步骤 4，但保留 Block。
相接组件出现重号、有效标记不足或求解无解时抛出 `AssignmentError`；
不会改写 OCR 数字、拆分相接组件或创建额外虚构 Island 来凑出成功。

最终输出为 `schemaVersion: 7`，Preview 兼容 schema 1–7：

- `processingSteps`：`booth_recognition` → `booth_block_grouping` → `island_recognition` → `booth_island_assignment` → `island_marker_alignment` → `half_booth_splitting`。
- 每页 `booths`、`blocks`、`islands` 为独立对象数组，仅通过
  `islands[].blockIds` → `blocks[].boothIds` 表达归属。
- 每个 Booth 仅保留原始 `id`、`number`、`rawText`、OCR 分数、坐标、旋转、状态和 OCR `issues`。
  不再写入 `blockId`、`islandId` 或包含反向引用的 `assignment`。
- 每个 Block 含 `id`、`boothIds`、`bbox`、`grid`；完成划分后还有 `axis`、`thin` 布局特征。
  不再保存 `islandId`、`outline`、`dividers`。
- 每个 Island 含 `id`、`label`、`color`、`markerIds`、`blockIds`、排序后的 `numbers`、
  `numberRange`、`numberGaps`、`status`、`issues`，不再重复保存 `boothIds`、`componentIds`。
- 每页 `blockGrouping` 仅保留方法/容差和统计；`islandAssignment` 仅保留求解/约束/统计元数据，
  不再包含 `components` 或 `islands`。其中 `assignmentReviews` 用 Booth ID 映射待复核问题数组，
  只记录需要复核的项，保留精确问题依据，不记录成员归属。
- 加载后再建立父级索引和绘图边线，供着色、筛选、缺号标注使用，不修改输入 JSON。
  全部有效 Booth 恰好属于一个 Block；完成求解时每个 Block 恰好属于一个 Island。
  重复引用、遗漏成员或矩阵约束不匹配均明确报错。
- `numberGaps` 仅记录范围，例如 `[{"first":"89","last":"92"}]`；
  不在 Booth 93 内添加缺号标记，不补造 89–92。
- `counts` 统计参与划分的 Booth；`candidateCounts` 保留划分前候选统计。
- `global_constraint_choice`、等距歧义、未确认 Island 编号或原始 OCR 问题均保留待复核。
  满足数学约束不等于已人工确认所有归属。

### 步骤 5：marker 中心点对齐

独立模块位于 [marker_alignment.py](./map_recognition/marker_alignment.py)，
输入原始 marker 与已完成的 Island 划分，不运行 OCR 或重新求解，也不修改输入。

- 先取像素外框的中点 `x + (width - 1) / 2`、`y + (height - 1) / 2`。
  后续计算仅用中点；最终 marker 删除 `bbox`，只保存 `center: {"x": ..., "y": ...}`。
  `step-1.json`、`step-2.json` 保留原始 bbox，便于追溯。
- 每个 Island 根据全部成员 Block 的单排证据输出 `layoutKind`：
  全为单排且至少 4 个 Booth 时为 `wall`，全为非单排为 `interior`，混合或证据不足为 `uncertain`。
  这是布局推断，不是人工确认的墙体检测；同一个 Island 只有一种分类。
- 内部 Island 根据附近 Block 主轴寻找 marker 行／列：
  同行对齐 y、同列对齐 x，取组内中位数；必须包含相邻的不同 Island。
  组内法向偏差不超过 Booth 短边中位数的 0.4 倍，沿行列相邻距离不超过 14 倍。
  对齐带限制整体宽度，不沿渐变偏差连锁吞并成对角线。
- 已形成内部行／列时，沿另一轴尝试移动到**整个 Island 的 Booth 包围范围中点**，
  不是 marker 外框或最近 Block 的中点。位移超过 2 个 Booth 短边、
  目标侵入 Booth 或与另一 marker 碰撞时保留该轴原值。
- 壁摊 marker 仅与附近同向、同侧壁摊 marker 对齐，绝不与内部 Island 混组，
  不移动沿墙方向的坐标，也不移向 Island 中点。
  转角按各 marker 最近的壁摊 Block 分方向；斜向阶梯壁摊不强制拉成水平／竖直线。
  `uncertain` 布局保留原始中心，避免误居中。
- 未执行 Island 划分时（包括 `--detect-only`），只记录原始中心，
  `markerAlignment.status` 为 `centers_only`，不猜测归属来移动标记。

每页 `markerAlignment` 保存方法、执行状态、参与对齐／居中数量及布局分类统计；
统计为参与约束的 marker 数，不要求坐标实际产生非零位移。
Preview 在 center 绘制半径 2.5 个原图像素的实心圆点，文字上移 24 个原图像素，
并自动补足顶部留白；schema 7 不绘制 marker 外框，不改变记录的 center；
旧版 schema 1–6 的 bbox 标记仍可读取和绘制。PNG 导出以中心十字和 occurrence ID 标注。
这些变化不改变 Booth 坐标、数字、Island 归属、OCR 问题或原始图片。

### 步骤 6：Booth → a/b half-booth

独立模块 [half_booths.py](./map_recognition/half_booths.py) 输入 Block、Island 归属和布局分类，
不运行 OCR、不改变数字、不重新划分成员。只在已完成 Island 划分后执行。

- 规则 Block 按 `grid.columns` 与 `grid.rows` 的比例决定 `axis`，不按单格像素长宽比判断。
  方形 grid（正常为 1×1 或 2×2）参考同 Island 最近、同排／列的已知走向 Block；
  壁摊也可从同 Island 的附近墙边 Booth 排列恢复局部墙向。
  不规则 Block 用格子尺寸归一化后的几何跨度判定。
  最终导出的 `blocks[].axis` 使用此步骤确定的走向；不修改前序求解和 marker 对齐结果。
- 普通切线垂直 axis：横向 Block 的 Booth 左右等分，纵向则上下等分。
  在同行／列中，a 靠近较小数字的一侧，b 靠近较大数字的一侧。
  同 Block 内像素共边的阶梯壁摊格也可作为相邻证据。
- 非壁摊的每条排列两端改用平行 axis 的切线：
  横向 Block 两端上下等分，纵向 Block 两端左右等分。
  外半是远离 Block 横截面中心的一半。
  **相邻编号小于自己时，外半取 a；大于自己时，外半取 b；内半取相反字母。**
  例如横向双排 Block 左上角编号 01、右邻 02，则上半为 b、下半为 a。
- 局部缺乏编号证据或方向冲突时，参考同 Island、相同 axis、同行／列的最近 Booth；
  不跨 Island，不使用已经推断的 a/b 作为新证据。
  完全没有证据时仍几何等分，但 `suffix: null`、`status: "needs_review"`，
  明确记录缺少方向／编号、外侧不明确或编号方向冲突等原因，并写日志。
  布局分类为 `uncertain` 的结果也保持待复核，不擅自应用非壁摊端部规则。

原 `booths` 数组保留，每页额外输出 `halfBooths`，每个原 Booth 恰好对应两个记录：

```json
{
  "id": "p001-b00001-h1",
  "boothId": "p001-b00001",
  "suffix": "a",
  "bbox": {"x": 28, "y": 40, "width": 10.5, "height": 30},
  "status": "resolved",
  "issues": []
}
```

`h1` 稳定表示左半或上半，`h2` 表示右半或下半；ID 不根据推断出的 a/b 改变。
半格 bbox 是连续区域 `[x, x + width) × [y, y + height)`，允许 `.5`，
两半尺寸相同、无重叠、面积和边界精确覆盖父 Booth。
`resolved` 仅表示几何和编号规则证据充分，不会清除原 Booth 的 OCR 或归属复核状态。
每页 `halfBoothSplitting` 保存方法和 `booths` / `halfBooths` / `reviewBooths` 统计。
这是 schema 7 的可选附加数据；旧结果不含该字段仍可预览。

Preview 独立的 `HalfBoothLayer` 默认开启，可用 `Half-booth a/b` 开关关闭，
显示每格唯一的切线，每个半格只标注 `a` 或 `b`，不重复数字，跟随 Island 筛选。
half-booth 字母不受“识别编号”开关影响；关闭 half-booth 后恢复原 Booth 编号绘制。
未解决的后缀显示 `?` 和橙色；此层不修改 PNG 原图或原有识别标注 PNG。

结构示例（省略 OCR 和统计字段）：

```text
pages[]
  booths[]   { id, number, bbox, ... }
  blocks[]   { id, boothIds, bbox, grid, axis, thin }
  islands[]  { id, label, blockIds, markerIds, ... }
  halfBooths[] { id, boothId, suffix, bbox, status, issues }
  blockGrouping     方法、容差、统计
  islandAssignment  求解状态、约束、统计、assignmentReviews
```

Preview 的独立 `NumberGapLayer` 根据每个 Island 的缺号范围，找到后续编号，
在该格**外部**用橙色引线标注，例如缺 89–92 则标注 `93`。
`AssignmentLayer` 提供分组着色和单 Island 筛选。
断点绘制只存在于 Preview，不写回 Booth，不写入原图或 PNG 标注导出。

### 缺边格补检

闭合轮廓检测后，使用标准格尺寸和水平/垂直线段端点生成候选位置，
校准端点误差，支持缺左、右、上、下四种边：

- 三条已有边的线段覆盖率至少为 80%，缺失边的覆盖率低于 30%。
- 内部必须包含不与裁切边界连通、大小接近字符的墨迹，避免空白或建筑边线误检。
- 位于图像边缘附近，或与附近完整格子排列对齐；不递归向外扩展网格。
- 与已有格子重叠超过 25% 的候选被排除。
- 仅允许几像素的边缘截断；较大范围裁掉的格子不根据编号猜测恢复。

补检只生成逻辑 bbox，不修改原图，也不向 OCR 输入补画的边框。
`issues` 保留 `repaired_border` 和 `missing_left_border` /
`missing_right_border` / `missing_top_border` / `missing_bottom_border`；
被图像边界截断时另加 `truncated_at_image_edge`。
OCR 识别到合法数字后仍强制标记 `needs_review`，Preview 显示为橙色；
识别失败则保持 `unrecognized` 和 `number: null`。仅检测模式仍为 `not_run`。

## 在其他 Python 代码中复用

可选：安装为本地包：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe -m pip install -e tools\booth-recognition
```

```python
from booth_recognition import BoothRecognizer

recognizer = BoothRecognizer(confidence=0.95)
result = recognizer.recognize(r"ref\official-map.pdf", pages=[1, 2])
result.save(r"map-result")

for page in result.pages:
    for booth in page.booths:
        print(page.page, booth.bbox, booth.number, booth.status)
```

同一个实例会复用已加载的模型。`recognize_image(PIL.Image)` 可直接处理内存图片。
`detect_only=True` 可单独调用方格检测；`result.to_dict()` 可交给其他服务存储，
无需强制导出文件。

独立识别 Island，不依赖 Booth 的几何检测或识别结果：

```python
from PIL import Image
from island_recognition import IslandRecognizer

recognizer = IslandRecognizer()
with Image.open(r"map.png") as image:
    markers = recognizer.recognize_image(image, page=1)
for marker in markers:
    print(marker.bbox, marker.label, marker.status, marker.issues)
```

完整流水线依次执行六个独立阶段：

```python
from map_recognition.pipeline import MapRecognizer

result = MapRecognizer().recognize(r"ref\official-map.pdf", pages=[1, 2])
result.save(r"map-result")
data = result.to_dict()
```

可用 `MapRecognizer(booths=BoothRecognizer(...), islands=IslandRecognizer(...))`
配置两个 OCR 识别器；它们仅共享基础坐标类型与 Paddle 推理适配器，
不相互调用；同一实例复用已加载的模型。
`MapRecognizer(assign=False)` 跳过划分；
`MapRecognizer(refine=False, assign=False)` 执行原始 OCR 和几何 Block 分组。

原始 OCR 与 Island 上下文校正也可单独调用；后者不加载 OCR 模型，不修改输入：

```python
from map_recognition.ocr_step import OcrRecognitionStep
from island_recognition.context import IslandContextRefiner

raw = OcrRecognitionStep().run(r"ref\official-map.pdf", pages=[1])
page_result = IslandContextRefiner().refine(raw.islands[1])
print(page_result.page_type.to_dict())
for marker in page_result.markers:
    print(marker.label, marker.inference.to_dict())
```

不要把上下文校正结果再次输入校正器；应使用原始 OCR 标记，重复校正会明确报错。

独立复用 Block 分组和 Island 划分模块：

```python
from island_assignment import BoothIslandAssigner, validate_assignment
from booth_blocks import BoothBlockGrouper, validate_blocks

blocks = BoothBlockGrouper().group(raw.booths.pages[0].booths, page=1)
validate_blocks(raw.booths.pages[0].booths, blocks)
print(blocks.to_dict())

assignment = BoothIslandAssigner(time_limit=30).assign(
    raw.booths.pages[0].booths, page_result.markers,
    page=1, page_type=page_result.page_type.label_type, blocks=blocks,
)
validate_assignment(raw.booths.pages[0].booths, assignment)
print(assignment.to_dict())
print(assignment.memberships)
```

## 自动化测试

```powershell
Set-Location tools\booth-recognition
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

单元测试不下载或加载 Paddle 模型，覆盖准确格数、灰底、旋转、短缺口及四向整边补检、
去重、坐标不变、前导零、异常数字、置信度、识别分歧、PDF 及 JSON/图片输出。
另外验证空白、建筑线条、孤立 U 形及缺失两条边不会盲目补格，
验证少量边缘裁切不产生越界坐标，并保留复核标记。
真实模型的端到端测试使用上面的 `test_recognition.py`。

94 项单元测试还覆盖彩色/灰度分离、非固定颜色、分离笔画、点状附属笔画、
细小注音、透明背景、字符类别和 NFC、方向/模型分歧、错误结果数量及合并导出。
当前四页示例的 OCR 约 3 分钟，划分每页至多再优化 30 秒，结果为：

| 类型 | 候选数 | recognized | needs_review | unrecognized |
| --- | ---: | ---: | ---: | ---: |
| Booth | 5,604 | 5,561 | 40 | 3 |
| Island 步骤 1 | 191 | 146 | 42 | 3 |
| Island 步骤 2 | 191 | 164 | 27 | 0 |

Booth 划分排除上述 3 个未识别候选，将 5,601 个有效 Booth 全部分配到
440 个 Block（四页分别为 177、54、128、81 个），再划分至
114 个逻辑 Island（四页分别为 37、23、34、20 个）。
同岛无重复编号，相接格没有被拆分。记录 4 处缺号范围：
东馆ア 89–92；西馆あ 16–21、62–65；西馆め 62–65。
一个 Island 的官方文字仍不可靠，保留空标签和稳定逻辑 ID 供复核。
额外测试覆盖过道、壁摊转角/多边/分区、重号冲突、相接不拆分、
未知候选排除、真实缺号、全覆盖校验和完整六阶段导出；
Block 测试覆盖严格像素接触/角点/单像素空隙、矩阵/L 形/空洞、
部分共享边、显示对齐不改坐标、过道分离和 Block 结果失配拒绝。

Island 上下文校正修正 19 个编号、确认 12 个编号；21 个项未获得充分的局部推断依据。
其中一些修正/确认项仍有方向或几何问题，所以仍保留待复核状态。
四页类型依次为片假名、大写字母、平假名、小写字母。
测试同时覆盖类别证据不足、重复壁摊票数限制、正反/横纵序列、
假名顺序、跨过道/跳号/冲突拒绝修复、无连锁推断、原始结果保护、
独立步骤、跳过 OCR 和新旧结果导出。

四页 Island 出现位置分别为 54、30、58、49。实际数量以本地运行结果为准。
未识别项可能包括误检，需人工确认；`recognized` 仍可能有 OCR 错误。
输出数量不代表已用人工标注验证全量准确率或召回率。

## 适用范围

- 主要针对本例这种清晰、轴对齐、单页内主要格子尺寸一致的印刷地图。
  检测尺寸范围为约 10–200 像素，不处理透视、斜拍或大面积断线。
- 自动方向校正以整张地图方向一致为前提，不是逐个格子的任意方向检测器。
- 其他矩形图标如果与 booth 同尺寸，仍可能误检；需要核对标注图。
- PDF 页需有一张主要内嵌地图。多张相近大小的图片会报错，避免默默漏掉地图；
  纯矢量 PDF 需先导出 PNG。没有内嵌图的页会记录为跳过；
  全部页面都不可处理时返回错误。
- 没有人工全量标注，不能保证“识别所有格子”或宣称某个准确率。
  Booth 不根据编号规律自动补值，也不把 `O` 无条件替换为 `0`；
  Island 的上下文推断只修复已检测到的位置，不新增标记或补画缺失字符。
- 本模块不关联日期、展馆、区块或 a/b 半摊位，不做跨天地图自动合并。
- Island 检测以“只有编号是彩色”为前提；彩色图例或装饰可能误检，
  低饱和度字符、极小字符可能漏检。OCR 会混淆形近字、大小写及不同字符类别，
  无法仅凭模型分数保证纠正；须人工复核，不能把高评分当作正确性证明。
- 划分采用几何和编号约束，不保证复杂展馆或错误 OCR 下的归属一定正确。
  会明确报告冲突或复核状态；不根据结果反向改写 Booth 数字。
- Island 上下文校正以同页只有一种编号类型为前提；不处理混合类型页的自动改号。
  局部序列是保守的横纵对齐启发式，不是完整场馆拓扑；斜排、折线、历史假名
  或特殊编号顺序可能无法校正。残留错误和不确定项仍需人工核验。
