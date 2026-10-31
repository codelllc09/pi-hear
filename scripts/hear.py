#!/usr/bin/env python3
"""pi-hear analyzer — video/audio/URL → timestamped transcript. Local only.

Lanes:
  subtitle  yt-dlp platform AI subtitles (URL sources; instant; quality
            UNVERIFIED — the calling model reads a sample and judges,
            The tool fetches, it never judges.)
  asr       ffmpeg → 16k mono wav → engine:
              sensevoice  iic/SenseVoiceSmall + fsmn-vad stitch
                          (zh/yue/en/ja/ko, fast, built-in punctuation;
                          NO native timestamps — VAD boundaries stitched,
                          validated RTF≈0.054 @4 threads)
              whisper     faster-whisper (optional install; native
                          timestamps, keeps English loanwords better)

Output: one JSON object on stdout. Transcripts are verbatim — correction
is downstream work, never this tool's job.
"""
import argparse, glob, json, os, re, shutil, subprocess, sys, tempfile, time

YTDLP = shutil.which("yt-dlp") or os.path.expanduser("~/.local/bin/yt-dlp")

def ffprobe_duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return None

def to_wav16k(src, tmpdir):
    """Any media (audio/video/URL-download) → 16k mono wav. ffmpeg always:
    cheap, uniform, and libsndfile can't read m4a/mp4 anyway."""
    out = os.path.join(tmpdir, "a16k.wav")
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-vn",
                        "-ac", "1", "-ar", "16000", out], capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError(f"ffmpeg failed: {r.stderr.strip()[:200]}")
    return out

def run_ytdlp(args, url, cookies=None):
    cmd = [YTDLP, *args, url]
    if cookies:
        cmd += ["--cookies", cookies]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=300)

TS_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})")

def parse_vtt(path):
    """VTT → [{start,end,text}]; rolling-caption dedup (identical consecutive
    cue text merges by extending the previous cue)."""
    cues, cur = [], None
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.strip()
        m = TS_RE.match(line)
        if m:
            if cur and cur[2].strip():
                cues.append(cur)
            g = [int(x) for x in m.groups()]
            cur = [g[0]*3600 + g[1]*60 + g[2] + g[3]/1000,
                   g[4]*3600 + g[5]*60 + g[6] + g[7]/1000, ""]
        elif cur is not None and line and not line.startswith(("WEBVTT", "Kind:", "Language:")) and not line.isdigit():
            cur[2] += line + "\n"
    if cur and cur[2].strip():
        cues.append(cur)
    out = []
    for s, e, t in cues:
        t = t.strip()
        if out and t == out[-1][2]:
            out[-1][1] = e  # rolling caption: same text again → extend window
        else:
            out.append([s, e, t])
    return [{"start": round(s, 2), "end": round(e, 2), "text": t} for s, e, t in out]

def lane_subtitle(url, cookies):
    with tempfile.TemporaryDirectory(prefix="pi-hear-sub-") as tmp:
        # --write-subs AND --write-auto-subs: bilibili exposes its AI subs
        # as REGULAR subs (ai-zh, srt) while youtube-style platforms use auto-subs
        r = run_ytdlp(["--skip-download", "--write-subs", "--write-auto-subs",
                       "--sub-langs", "zh-Hans,ai-zh,zh-CN,zh,en",
                       "-o", os.path.join(tmp, "sub.%(ext)s"), "--no-playlist"], url, cookies)
        vtts = sorted(glob.glob(os.path.join(tmp, "sub.*")), key=lambda p: ("ai-zh" not in p, p))
        vtts = [p for p in vtts if p.endswith((".vtt", ".srt"))]
        if not vtts:
            return {"available": False,
                    "reason": f"no auto subtitles (yt-dlp: {r.stderr.strip()[-120:] or r.stdout.strip()[-120:]})"}
        lines = parse_vtt(vtts[0])
        if not lines:
            return {"available": False, "reason": "subtitle file present but empty"}
        return {"available": True, "lang": os.path.basename(vtts[0]), "lines": lines,
                "note": "AI subtitles, quality UNVERIFIED — read the first ~200 chars and judge: "
                        "if missing/empty or clearly mismatched to the video topic, rerun mode='asr'"}

def download_audio(url, cookies):
    tmp = tempfile.mkdtemp(prefix="pi-hear-dl-")  # NOT auto-cleaned: model may want the artifact
    r = run_ytdlp(["-x", "-f", "bestaudio", "--no-playlist",
                   "-o", os.path.join(tmp, "dl.%(ext)s")], url, cookies)
    files = sorted(glob.glob(os.path.join(tmp, "dl.*")))
    if not files:
        raise RuntimeError(f"download failed: {r.stderr.strip()[-160:]}")
    return files[0]

def vad_stitch(wav_path, threads, gap_ms, max_seg_s, language):
    """SenseVoice has no native timestamps → fsmn-vad gives ms-level speech
    boundaries; force-split overlong chunks, merge short gaps, transcribe
    slices in one batch, stitch back. Validated 2026-11-01 (RTF 0.054)."""
    import torch
    torch.set_num_threads(threads)
    import io as _io
    import contextlib as _ctx
    import soundfile as sf
    from funasr import AutoModel
    # funasr AutoModel prints its version banner to STDOUT on every init —
    # this tool's contract is pure JSON on stdout, so swallow it.
    with _ctx.redirect_stdout(_io.StringIO()):
        vad = AutoModel(model="fsmn-vad", disable_update=True, device="cpu", log_level="ERROR")
        asr = AutoModel(model="iic/SenseVoiceSmall", disable_update=True, device="cpu", log_level="ERROR")
    audio, sr = sf.read(wav_path, dtype="float32")
    if sr != 16000:
        raise RuntimeError(f"expected 16k wav, got {sr}")
    dur = len(audio) / sr
    chunks = vad.generate(input=audio, cache={}, disable_pbar=True)[0]["value"]  # ms pairs
    # force-split chunks longer than max_seg_s
    split = []
    for s, e in chunks:
        s, e = s / 1000, e / 1000
        while e - s > max_seg_s:
            split.append([s, s + max_seg_s]); s += max_seg_s
        split.append([s, e])
    # merge neighbours: gap < gap_ms and total ≤ max_seg_s
    utts = []
    for s, e in split:
        if utts and s - utts[-1][1] < gap_ms / 1000 and e - utts[-1][0] <= max_seg_s:
            utts[-1][1] = e
        else:
            utts.append([s, e])
    slices = [audio[int(s * sr):int(e * sr)] for s, e in utts]
    t0 = time.time()
    res = asr.generate(input=slices, cache={}, language=language, use_itn=True,
                       batch_size_s=300, disable_pbar=True)
    infer = time.time() - t0
    strip = lambda t: re.sub(r"<\|[^|]+\|>", "", t or "").strip()
    segments = [{"start": round(s, 2), "end": round(e, 2), "text": strip(r.get("text"))}
                for (s, e), r in zip(utts, res) if strip(r.get("text"))]
    return {"engine": "sensevoice", "language": language, "rtf": round(infer / dur, 3) if dur else None,
            "inferS": round(infer, 1), "segments": segments,
            "text": "".join(s["text"] for s in segments)}

def whisper_stitch(wav_path, model_size, language):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError("engine 'whisper' needs faster-whisper: "
                           "uv pip install -p ~/.virtualenvs/main/bin/python faster-whisper "
                           "(models small/medium already in ~/.cache/huggingface)")
    import soundfile as sf
    dur = len(sf.read(wav_path, dtype="float32")[0]) / 16000
    m = WhisperModel(model_size, device="cpu", compute_type="int8")
    t0 = time.time()
    gen, info = m.transcribe(wav_path, language=None if language == "auto" else language,
                             vad_filter=True, beam_size=5)
    segments = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
                for s in gen if s.text.strip()]
    infer = time.time() - t0
    return {"engine": "whisper", "language": info.language, "rtf": round(infer / dur, 3) if dur else None,
            "inferS": round(infer, 1), "segments": segments,
            "text": " ".join(s["text"] for s in segments)}

def lane_asr(source, engine, language, threads, gap_ms, max_seg_s, whisper_model, cookies):
    with tempfile.TemporaryDirectory(prefix="pi-hear-asr-") as tmp:
        media = source
        if re.match(r"^https?://", source):
            media = download_audio(source, cookies)
        wav = to_wav16k(media, tmp)
        dur = ffprobe_duration(wav)
        out = whisper_stitch(wav, whisper_model, language) if engine == "whisper" \
            else vad_stitch(wav, threads, gap_ms, max_seg_s, language)
        out["duration"] = round(dur, 1) if dur else None
        return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--mode", default="auto", choices=["auto", "asr", "subtitle"])
    ap.add_argument("--engine", default="sensevoice", choices=["sensevoice", "whisper"])
    ap.add_argument("--language", default="zh")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--gap-ms", type=int, default=800)
    ap.add_argument("--max-seg-s", type=int, default=30)
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--cookies", default=None)
    a = ap.parse_args()

    is_url = bool(re.match(r"^https?://", a.source))
    result = {"source": a.source, "modeUsed": a.mode, "duration": None,
              "subtitle": None, "asr": None, "error": None}
    try:
        if a.mode == "subtitle" or (a.mode == "auto" and is_url):
            if is_url:
                result["subtitle"] = lane_subtitle(a.source, a.cookies)
            else:
                result["subtitle"] = {"available": False,
                                      "reason": "local source has no subtitle track — use mode='asr'"}
            if a.mode == "subtitle":
                return print(json.dumps(result, ensure_ascii=False))
            if result["subtitle"].get("available"):
                lines = result["subtitle"]["lines"]
                result["duration"] = lines[-1]["end"] if lines else None
                return print(json.dumps(result, ensure_ascii=False))
        # asr (forced, or auto fallback)
        result["asr"] = lane_asr(a.source, a.engine, a.language, a.threads,
                                 a.gap_ms, a.max_seg_s, a.whisper_model, a.cookies)
        result["duration"] = result["asr"].get("duration")
    except Exception as e:
        result["error"] = str(e)[:400]
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
