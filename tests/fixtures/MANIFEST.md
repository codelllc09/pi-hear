# Fixture: review-90s.wav

- **Provenance**: first 90 s of the audio track of a Bilibili "CodeReview" talk
  video (zh speaker, heavy English loanwords: CodeReview, parser, compile,
  type variable).
- **Format**: 16 kHz mono wav, 90.0 s.

## Cross-engine reference (same content)

whisper small (2026-10-28, native timestamps) — first lines:

```
[00:00-00:03] 好 我们今天久违的做一个CodeReview
[00:03-00:07] 这个CodeReview是上次拍抗台湾的挑战视频
[00:07-00:08] 欠大家的
[00:08-00:09] 这里顺便说一下
[00:09-00:11] 拍抗台湾还有一个月就要开始了
```

SenseVoiceSmall (2026-11-01, VAD-stitch timestamps):

```
[00:00-01:00] 好，我们今天久违的做一个coded review啊。这个coded review呢是上次…
```

## Known traits (regression criteria)

| 引擎 | 判据 |
|---|---|
| sensevoice | 标点+ITN 自带；"CodeReview"→"coded review"（英文术语拆碎是已知弱点）；时间戳来自 VAD 缝合，首段 start=0；RTF(4线程) 0.04–0.12 |
| whisper | 无标点；"CodeReview" 原样保留；"拍comicon台湾"→"拍抗台湾"（专有名词两家全灭，共享已知限制） |

**回归标准**：换 funasr/faster-whisper 版本后重跑 `tests/test-hear.py` 全绿 +
上表特征不漂移（术语渲染方式、标点有无）。若 sensevoice 突然吐出原生
sentence_info，可考虑退役 VAD 缝合——先在题库记录对比数据。

## Audio-format matrix (2026-11-01, 60 s clip of this fixture)

mp3 / m4a / flac / ogg / **direct mp3 URL** (http.server + yt-dlp generic
extractor) all transcribe identically (RTF 0.05–0.08, same 'coded review'
rendering). The original production input format was m4a; mp3+m4a are
pinned in the test suite; the URL path needs a live server, judge it by
spot-check.

## Negative results (do not re-try without new evidence)

- SenseVoice via `merge_vad=True/False` 都不返回分段（字段只有 key/text）
  ——时间戳必须 VAD 缝合，别再试 generate 参数（2026-11-01 验证）。
