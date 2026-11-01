#!/usr/bin/env python3
"""pi-hear analyzer smoke tests. Run: python3 tests/test-hear.py
Fixture: review-90s.wav = first 90s of a CodeReview talk video (zh with
English loanwords), whisper small reference transcript in MANIFEST.md."""
import json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.expanduser("~/.virtualenvs/main/bin/python")
HEAR = os.path.join(HERE, "..", "scripts", "hear.py")
FIX = os.path.join(HERE, "fixtures", "review-90s.wav")

def run(*args):
    r = subprocess.run([PY, HEAR, *args], capture_output=True, text=True, timeout=600)
    return r.returncode, r.stdout, r.stderr

class TestASR(unittest.TestCase):
    def setUp(self):
        code, out, err = run(FIX, "--mode", "asr", "--engine", "sensevoice")
        self.assertEqual(code, 0, err[:400])
        self.r = json.loads(out)

    def test_segments_and_timestamps(self):
        a = self.r["asr"]
        self.assertGreaterEqual(len(a["segments"]), 2, "expect multiple utterances in 90s")
        for i, s in enumerate(a["segments"]):
            self.assertGreater(s["end"], s["start"], f"segment {i}: end<=start")
            self.assertTrue(s["text"].strip(), f"segment {i}: empty text")
        starts = [s["start"] for s in a["segments"]]
        self.assertEqual(starts, sorted(starts), "timestamps must be monotonic")
        self.assertLess(a["segments"][0]["start"], 1.0, "speech begins near file start (VAD may trim breath)")

    def test_content_markers(self):
        text = self.r["asr"]["text"]
        self.assertIn("review", text.lower(), "loanword 'review' expected (SenseVoice renders it 'coded review')")
        self.assertIn("今天", text)

    def test_rtf_sane(self):
        self.assertLess(self.r["asr"]["rtf"], 0.5, "CPU RTF should be well under 0.5 at 4 threads")

    def test_duration(self):
        self.assertAlmostEqual(self.r["asr"]["duration"], 90.0, delta=1.5)

class TestSubtitleLane(unittest.TestCase):
    def test_local_file_no_subtitle(self):
        code, out, _ = run(FIX, "--mode", "subtitle")
        self.assertEqual(code, 0)
        r = json.loads(out)
        self.assertFalse(r["subtitle"]["available"])
        self.assertIn("asr", r["subtitle"]["reason"])

class TestAudioFormats(unittest.TestCase):
    """Audio (not just video) sources flow the same pipe: ffmpeg feeds all
    containers; verified matrix mp3/m4a/flac/ogg + direct-URL in
    fixtures/MANIFEST.md (2026-11-01)."""
    def _transcribe(self, ext, codec):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            f = os.path.join(td, f"clip.{ext}")
            r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", FIX, "-t", "60"]
                               + (codec and ["-c:a", codec] or []) + [f], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr[:200])
            code, out, err = run(f, "--mode", "asr")
            self.assertEqual(code, 0, err[:300])
            return json.loads(out)["asr"]

    def test_mp3_and_m4a(self):
        for ext, codec in (("mp3", "libmp3lame"), ("m4a", "aac")):
            with self.subTest(ext=ext):
                a = self._transcribe(ext, codec)
                self.assertGreaterEqual(len(a["segments"]), 1, f"{ext}: no segments")
                self.assertIn("review", a["text"].lower(), f"{ext}: content marker missing")
                self.assertLess(a["rtf"], 0.5)

class TestArtifact(unittest.TestCase):
    """Long-content workaround: full transcript must land as a file next to
    local sources; render is just a preview."""
    def test_artifact_written_and_cleaned(self):
        art = FIX + ".transcript.md"
        if os.path.exists(art):
            os.remove(art)
        code, out, err = run(FIX, "--mode", "asr")
        self.assertEqual(code, 0, err[:300])
        r = json.loads(out)
        self.assertEqual(r["artifact"], art, "artifact path expected for local source")
        self.assertTrue(os.path.exists(art))
        body = open(art, encoding="utf-8").read()
        self.assertIn("review", body.lower())
        self.assertIn("[00:0", body, "timestamped lines expected")
        os.remove(art)  # keep fixtures dir clean

    def test_url_never_writes_artifact_side_effect(self):
        # write_artifact must skip URLs (no local path to sit beside)
        code, out, _ = run("https://example.com/x.mp4", "--mode", "subtitle")
        r = json.loads(out)
        self.assertIsNone(r.get("artifact"))

class TestErrors(unittest.TestCase):
    def test_whisper_not_installed_hint(self):
        code, out, _ = run(FIX, "--mode", "asr", "--engine", "whisper")
        self.assertEqual(code, 0)
        r = json.loads(out)
        try:
            import importlib.util as u
            have = u.find_spec("faster_whisper") is not None
        except Exception:
            have = False
        if have:
            self.assertGreaterEqual(len(r["asr"]["segments"]), 2)
        else:
            self.assertIn("faster-whisper", r["error"])

    def test_missing_file(self):
        code, out, _ = run("/nonexistent.mp4", "--mode", "asr")
        self.assertEqual(code, 0)
        r = json.loads(out)
        self.assertTrue(r["error"], "missing file must surface as error, not crash")

if __name__ == "__main__":
    unittest.main(verbosity=2)
