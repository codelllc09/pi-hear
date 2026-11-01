[English](../README.md) · **简体中文**

# pi-hear

一个 `hear()` 工具，两条车道——路由权在调用方模型手里。纯本地测量：无
VLM、无云 ASR。

```
hear(source)                     source = URL → 先取平台 AI 字幕（秒回，
                                        质量未验——由模型判断）；
                                 source = 本地文件 → 直接本地 ASR
hear(source, mode="asr")         ffmpeg → 16k 单声道 → 引擎，强制带时间戳
hear(source, mode="subtitle")    强制走字幕车道（仅 URL）
```

## 车道

| 车道 | 引擎 | 代价 | 说明 |
|---|---|---|---|
| subtitle | yt-dlp 字幕 | 秒级（走网络） | B站 AI 字幕（`ai-zh`）需登录 cookies，挂在**普通字幕**旗（`--write-subs`）下；两个字幕旗全开，YouTube 式自动字幕也通吃。质量未验——调用方模型先读前 ~200 字再信 |
| asr（默认引擎） | SenseVoiceSmall + fsmn-vad 缝合 | RTF 0.04–0.07 @ 4 线程，CPU | zh/yue/en/ja/ko；自带标点 + ITN；**无原生时间戳 → VAD 缝合**（已验证） |
| asr（engine=whisper） | faster-whisper（按需安装） | 估 RTF 0.1–0.3 | 原生时间戳；英文术语保留更好 |

引擎取舍（fixture 对照判分）：纯中文 → sensevoice；中英混说技术内容 →
whisper（"CodeReview" 在 sensevoice 下变成 "coded review"）。没有全胜者，
配置可切。

## 安装

```bash
# 1) 分析器依赖——装进 Python venv（torch 必须走 CPU 源：PyPI 的 linux
#    默认捆绑几个 G 你用不到的 CUDA）
uv pip install -p ~/.virtualenvs/main/bin/python -r scripts/requirements.txt
uv pip install -p ~/.virtualenvs/main/bin/python "torch==2.9.1" \
    --index-url https://download.pytorch.org/whl/cpu

# 2) 扩展本体
pi install npm:pi-hear
```

（`scripts/requirements.txt` 随 npm 包发布在 `hear.ts` 旁边；第 1 步在仓库
目录或已安装的包目录里跑都行。）

或试运行一次（不写入配置）：

```bash
pi -e git:github.com/codelllc09/pi-hear
```

系统依赖（非 pip）：`ffmpeg`/`ffprobe`、`yt-dlp`。

配置 `~/.pi/agent/pi-hear.json`（全部键可选）：

```jsonc
{
  "engine": "sensevoice",
  "whisperModel": "small",
  "device": "cpu",          // "cuda" 把 ASR 放上 GPU；VAD 留在 CPU（实测拆分）
  "threads": 4,
  "language": "zh",
  "gapMs": 800,             // VAD 缝合：间隙小于此值的相邻段合并
  "maxSegS": 30,            // VAD 缝合：超此时长的段强制拆分
  "pythonPath": "~/.virtualenvs/main/bin/python",
  "cookiesFile": "~/secrets/bilibili-cookies.txt",  // 会员源需要
  "proxy": "http://127.0.0.1:7897"                   // 透传给 yt-dlp
}
```

## 设计

- 纯测量工具：逐字保留转写，不做语义判断——字幕质量抽查是调用方模型的
  职责，纠错属于下游流水线。
- SenseVoice 无原生时间戳 → 毫秒级 VAD 边界 + 强制拆分（> `maxSegS`）+
  间隙合并（< `gapMs`）+ 批量转写 + 缝合。时间戳必须存在且单调（测试断言）。
- ASR 吃 CPU：4 线程下每小时音频约 3–6 分钟——工具描述强制要求模型在长
  媒体转写前先向用户报出 duration×RTF 估时。
- 长转写渲染截断（> 12k 字符）；本地源旁边会写一份 `.transcript.md` 工件
  并给 50 段预览。批量/生产任务请走批量流水线，别用这个交互工具。
- 画面抽取不在范围内——`ffmpeg` 抽帧 + `look` 组合去做。

跨引擎 fixture 验证（见 `tests/fixtures/MANIFEST.md`）。

## 许可证

MIT — 见 [LICENSE](../LICENSE)。
