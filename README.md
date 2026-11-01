# pi-hear

One `hear()` tool, two lanes — the calling model is the router. Fully local:
no VLM, no cloud ASR. 

```
hear(source)                     source = URL → AI subtitles first (instant,
                                        quality UNVERIFIED — model judges);
                                 source = local file → local ASR
hear(source, mode="asr")         ffmpeg → 16k mono → engine, timestamps forced
hear(source, mode="subtitle")    force subtitle lane (URL only)
```

## Lanes

| Lane | Engine | Cost | Notes |
|---|---|---|---|
| subtitle | yt-dlp subs | ~seconds (network) | B站需登录 cookies（ai-zh，普通字幕旗）；质量未验，调用模型读 200 字再信 |
| asr (default engine) | SenseVoiceSmall + fsmn-vad stitch | RTF 0.04–0.07 @4 threads, CPU | zh/yue/en/ja/ko；自带标点 ITN；**无原生时间戳 → VAD 缝合**（已验证） |
| asr (engine=whisper) | faster-whisper（按需装） | est RTF 0.1–0.3 | 原生时间戳；英文术语保留更好 |

Engine trade-off (fixture-judged): 纯中文 → sensevoice；中英混说技术内容 →
whisper（"CodeReview" sensevoice 渲染成 "coded review"）。无全胜者，配置可切。

## Install

```bash
# analyzer deps into the central venv (torch MUST use the CPU index, see file)
uv pip install -p ~/.virtualenvs/main/bin/python -r scripts/requirements.txt
uv pip install -p ~/.virtualenvs/main/bin/python "torch==2.9.1" \
    --index-url https://download.pytorch.org/whl/cpu
pi install ~/Work/pi-hear
```

Config `~/.pi/agent/pi-hear.json` (all keys optional):

```json
{
  "engine": "sensevoice",
  "whisperModel": "small",
  "device": "cpu",
  "threads": 4,
  "language": "zh",
  "gapMs": 800,
  "maxSegS": 30,
  "pythonPath": "~/.virtualenvs/main/bin/python",
  "cookiesFile": "~/secrets/bilibili-cookies.txt",
  "proxy": "http://127.0.0.1:7897"
}
```

## Design

- Pure measurement: verbatim transcripts, no semantic judgment — subtitle
  quality checks belong to the calling model , corrections
  belong to the downstream pipeline.
- ASR is CPU-heavy; the tool description orders the model to warn the user
  with a duration×RTF estimate before long media.
- Long transcripts render truncated (>12k chars); batch/production work
  should use a batch pipeline, not this
  interactive tool.
- Visual frames are out of scope — `ffmpeg` sampling + `look` composes.

Validated against a cross-engine fixture (see `tests/fixtures/MANIFEST.md`).

## Remote GPU (gpu-host) recipe

Validated 2026-11-01 (RTF 0.006 vs 0.055 CPU on RTX 4090; 1h audio → ~22s):
`--device cuda` puts the ASR model on GPU, VAD stays on CPU (benchmarked split).
Standard workhorse loop: rsync media to `gpu-host:~/staging/` →
`ssh redacted-redacted 'cd ~/staging && ~/.virtualenvs/main/bin/python hear.py X --mode asr --device cuda'`
→ rsync results (incl. `.transcript.md` artifact) back. No proxy needed —
modelscope downloads are domestic-direct.
