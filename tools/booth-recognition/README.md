# Booth 地图识别

独立 Python 模块，不依赖 Node、数据库或网页服务。全程本地处理：

1. 从 PDF 提取原始地图位图，或直接读取 PNG/JPEG 等单帧图片。
2. OpenCV 按重复矩形尺寸检测格子、去重、修复短缺口，并补检单条边完整缺失的三边格。
3. 抽样确定整张图的数字方向，去边框、补白后批量调用 PaddleOCR 的
   `TextRecognition`，不使用整图文字检测器。
4. 对疑难格使用二值化版本重试；保留低置信度、处理分歧及边框修复标记。
5. 导出原图、标注图和 JSON，不猜测未识别数字。

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

只检测坐标，不加载模型，适合快速查看覆盖情况：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --detect-only --pages all
```

选择四种展馆，或处理全部页面：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --pages 1,2,3,4
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py --pages all
```

指定输入、输出和置信度：

```powershell
tools\booth-recognition\.venv\Scripts\python.exe tools\booth-recognition\test_recognition.py .\map.png --output .\map-result --confidence 0.95
```

CPU 处理几千个格子可能需要数分钟。日志会显示候选格数量、方向及进度。
默认轻量模型为 `en_PP-OCRv5_mobile_rec`，可用
`--model PP-OCRv5_server_rec` 对比大模型效果。离线运行时使用
`--model-dir <模型目录>`，并让 `--model` 与本地模型匹配。
置信度是模型原始评分，不是经过校准的正确概率。

## 输出怎么看

默认目录为本模块的 `output`，不纳入 Git。每次运行覆盖同名结果文件；
如需对比，请使用不同 `--output` 目录。

- `result.json`：所有选中地图的尺寸、格子坐标、数字、评分和问题标记。
- `page-001.png`：提取后的原始底图；坐标对应这张图。
- `page-001-overlay.png`：方框和识别数字，放大查看。

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
- `skippedPages` 明确列出没有内嵌地图的页，包括示例 PDF 第 13 页。

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

示例 PDF 有 12 张地图，第 13 页无地图，明确记录为跳过。
全量 CPU 运行约需数分钟，实际候选数量和复核状态以 `result.json` 为准。
缺边补检后的本次全量结果为 16,672 个候选：原有 16,543 个正常识别，
新增 120 个有两位数字的缺边格（待复核）以及 9 个 OCR 未通过的候选（未识别）。
后者可能包含建筑图形等误检，需人工确认，不作为成功恢复的 booth。
24 项单元测试覆盖缺边恢复及拒绝误补的行为。
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
  不根据编号规律自动补值，也不把 `O` 无条件替换为 `0`。
- 本模块不关联日期、展馆、区块或 a/b 半摊位，不做跨天地图自动合并。
