**English** · [简体中文](./docs/README.zh-CN.md)

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
| subtitle | yt-dlp subs | ~seconds (network) | Bilibili AI subs (`ai-zh`) need login cookies and ride the *regular* subtitles flag (`--write-subs`); both subs flags are on, so YouTube-style auto-subs work too. Quality unverified — the calling model reads the first ~200 chars before trusting |
| asr (default engine) | SenseVoiceSmall + fsmn-vad stitching | RTF 0.04–0.07 @ 4 threads, CPU | zh/yue/en/ja/ko; punctuation + ITN built in; **no native timestamps → VAD stitching** (validated) |
| asr (engine=whisper) | faster-whisper (optional install) | est. RTF 0.1–0.3 | native timestamps; keeps English loanwords better |

Engine trade-off (fixture-judged): pure Chinese → sensevoice; mixed zh/en
technical speech → whisper ("CodeReview" comes out as "coded review" under
sensevoice). No overall winner — switchable via config.

## Install

```bash
# 1) analyzer deps — install into a Python venv (torch MUST come from the CPU
#    index: the PyPI linux default bundles gigabytes of CUDA you don't need)
uv pip install -p ~/.virtualenvs/main/bin/python -r scripts/requirements.txt
uv pip install -p ~/.virtualenvs/main/bin/python "torch==2.9.1" \
    --index-url https://download.pytorch.org/whl/cpu

# 2) the extension
pi install npm:pi-hear
```

(`scripts/requirements.txt` ships in the npm package next to `hear.ts`; run
step 1 from the repo, or from the installed package dir.)

Or try it once without persisting:

```bash
pi -e git:github.com/codelllc09/pi-hear
```

System deps (not pip): `ffmpeg`/`ffprobe`, `yt-dlp`.

Config `~/.pi/agent/pi-hear.json` (all keys optional):

```jsonc
{
  "engine": "sensevoice",
  "whisperModel": "small",
  "device": "cpu",          // "cuda" puts ASR on GPU; VAD stays CPU (benchmarked split)
  "threads": 4,
  "language": "zh",
  "gapMs": 800,             // VAD stitch: merge utterances with gaps below this
  "maxSegS": 30,            // VAD stitch: force-split segments longer than this
  "pythonPath": "~/.virtualenvs/main/bin/python",
  "cookiesFile": "~/secrets/bilibili-cookies.txt",  // member-only sources
  "proxy": "http://127.0.0.1:7897"                   // plumbed to yt-dlp
}
```

## Design

- Pure measurement: verbatim transcripts, no semantic judgment — subtitle
  quality checks belong to the calling model, corrections belong to the
  downstream pipeline.
- SenseVoice has no native timestamps → millisecond VAD boundaries + forced
  splits (> `maxSegS`) + gap merging (< `gapMs`) + batched transcription +
  stitching. Timestamps must exist and be monotonic (test-enforced).
- ASR is CPU-heavy: roughly 3–6 min per hour of audio at 4 threads — the tool
  description orders the model to warn the user with a duration×RTF estimate
  before long media.
- Long transcripts render truncated (> 12k chars); a `.transcript.md` artifact
  is written next to local sources with a 50-segment preview. Batch/production
  work should use a batch pipeline, not this interactive tool.
- Visual frames are out of scope — `ffmpeg` sampling + `look` composes.

Validated against a cross-engine fixture (see `tests/fixtures/MANIFEST.md`).

## License

MIT — see [LICENSE](./LICENSE).
