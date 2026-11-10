# Booth / Island 地图识别

独立 Python 模块，不依赖 Node、数据库或网页服务。全程本地处理：

1. 从 PDF 提取原始地图位图，或直接读取 PNG/JPEG 等单帧图片。
2. OpenCV 按重复矩形尺寸检测格子、去重、修复短缺口，并补检单条边完整缺失的三边格。
3. 抽样确定整张图的数字方向，去边框、补白后批量调用 PaddleOCR 的
   `TextRecognition`，不使用整图文字检测器。
4. 对疑难格使用二值化版本重试；保留低置信度、处理分歧及边框修复标记。
5. 独立的 Island 模块通过彩色像素定位编号，合并字符的分离笔画，
   裁切后调用 PaddleOCR 识别大小写英文字母、平假名和片假名。
6. 以上 OCR 系统封装成步骤 1；独立步骤 2 推断页面编号类型，
   使用可靠邻居的局部序列校正疑难 Island 字符。导出原始结果与最终结果，
   保留修复依据；证据不足不强行补号，也不在此阶段分配 Booth 归属。

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

## 测试实际地图

默认读取仓库的 `ref/official-map.pdf` **第 1 页**：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py
```

默认流水执行步骤 1（Booth → Island OCR）→ 步骤 2（页面类型/邻域校正）。
只检测两类标记的坐标、不加载模型；步骤 2 明确记录为跳过：

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

仅执行步骤 1，输出 schema 2，不推断改号：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --ocr-only --pages all
```

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

## 输出怎么看

默认目录为本模块的 `output`，不纳入 Git。每次运行覆盖同名结果文件；
如需对比，请使用不同 `--output` 目录。

- `step-1.json`：步骤 1 的原始 Booth/Island 结果（完整流水线生成）。
- `result.json`：最终结果，包含尺寸、格子/Island 坐标、文字、评分、问题和校正依据。
- `page-001.png`：提取后的原始底图；坐标对应这张图。
- `page-001-overlay.png`：Booth 方框/数字与按最终状态着色的 Island 方框/出现位置 ID。
  PNG 使用 ASCII ID，避免依赖日文字体；网页 Preview 显示真正的 Island 文字。

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

### 步骤 2：页面类型与邻域校正

完整流水线最终输出 `schemaVersion: 3`，`processingSteps` 为
`["ocr", "island_context"]`。Booth 与原图完全不变，每页新增 `islandInference`，
每个 Island 标记新增 `inference`。Preview 兼容 schema 1、2、3。

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

完整流水线依次执行两个独立步骤：

```python
from map_recognition.pipeline import MapRecognizer

result = MapRecognizer().recognize(r"ref\official-map.pdf", pages=[1, 2])
result.save(r"map-result")
data = result.to_dict()
```

可用 `MapRecognizer(booths=BoothRecognizer(...), islands=IslandRecognizer(...))`
配置步骤 1 的两个识别器；它们仅共享基础坐标类型与 Paddle 推理适配器，
不相互调用；同一实例复用已加载的模型。`MapRecognizer(refine=False)` 仅运行步骤 1。

各个步骤也可单独调用，步骤 2 不加载 OCR 模型，不修改输入：

```python
from map_recognition.ocr_step import OcrRecognitionStep
from island_recognition.context import IslandContextRefiner

raw = OcrRecognitionStep().run(r"ref\official-map.pdf", pages=[1])
page_result = IslandContextRefiner().refine(raw.islands[1])
print(page_result.page_type.to_dict())
for marker in page_result.markers:
    print(marker.label, marker.inference.to_dict())
```

不要把步骤 2 的结果再次输入校正器；应使用步骤 1 的标记，重复校正会明确报错。

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

61 项单元测试还覆盖彩色/灰度分离、非固定颜色、分离笔画、点状附属笔画、
细小注音、透明背景、字符类别和 NFC、方向/模型分歧、错误结果数量及合并导出。
当前四页示例的 CPU 完整运行约 3 分钟，结果为：

| 类型 | 候选数 | recognized | needs_review | unrecognized |
| --- | ---: | ---: | ---: | ---: |
| Booth | 5,604 | 5,561 | 40 | 3 |
| Island 步骤 1 | 191 | 146 | 42 | 3 |
| Island 步骤 2 | 191 | 164 | 27 | 0 |

步骤 2 修正 19 个编号、确认 12 个编号；21 个项未获得充分的局部推断依据。
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
- 尚未实现行列/壁摊拓扑推断及 Booth → Island 归属。
- 步骤 2 以同页只有一种编号类型为前提；不处理混合类型页的自动改号。
  局部序列是保守的横纵对齐启发式，不是完整场馆拓扑；斜排、折线、历史假名
  或特殊编号顺序可能无法校正。残留错误和不确定项仍需人工核验。
