/**
 * pi-hear — one hear() tool, two lanes; the calling model is the router.
 * Pure local measurement: no VLM, no cloud ASR. hear never judges content —
 * subtitle quality judgment is the calling model's job.
 *
 *   hear(url)               → try platform AI subtitles first (instant,
 *                             quality unverified); miss/garbage → mode='asr'
 *   hear(local-file)        → straight to local ASR
 *   hear(x, mode="asr")     → force ASR (ffmpeg → sensevoice | whisper)
 *   hear(x, mode="subtitle")→ force subtitle lane (URL only)
 *
 * ASR is CPU-heavy: RTF 0.04–0.1 at 4 threads → 1h audio ≈ 2.5–6 min with
 * all cores busy. The tool description tells the model to warn the user
 * before long media.
 *
 * Config: <agent-dir>/pi-hear.json
 *   { "engine": "sensevoice", "whisperModel": "small", "threads": 4,
 *     "language": "zh", "gapMs": 800, "maxSegS": 30,
 *     "pythonPath": "~/.virtualenvs/main/bin/python",
 *     "cookiesFile": null }        // e.g. "~/secrets/bilibili-cookies.txt"
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface HearConfig {
	engine: string; // sensevoice | whisper
	whisperModel: string; // faster-whisper size: small | medium ...
	threads: number; // CPU threads for torch — keep conservative (4)
	language: string; // zh | en | ja | ko | yue | auto
	gapMs: number; // VAD stitch: merge utterances with gaps below this
	maxSegS: number; // VAD stitch: force-split segments longer than this
	pythonPath: string;
	cookiesFile?: string; // yt-dlp cookies for member-only sources
}

const DEFAULTS: HearConfig = {
	engine: "sensevoice",
	whisperModel: "small",
	threads: 4,
	language: "zh",
	gapMs: 800,
	maxSegS: 30,
	pythonPath: "~/.virtualenvs/main/bin/python",
};

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const expand = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

function loadConfig(): HearConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(agentDir(), "pi-hear.json"), "utf-8"));
		return { ...DEFAULTS, ...raw };
	} catch {
		return { ...DEFAULTS };
	}
}

function runPython(script: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(expand(script), args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`analyzer exit ${code}: ${err.slice(0, 400)}`))));
		child.on("error", reject);
	});
}

interface HearResult {
	source?: string;
	modeUsed?: string;
	duration?: number | null;
	subtitle?: { available: boolean; lang?: string; lines?: { start: number; end: number; text: string }[]; note?: string; reason?: string } | null;
	asr?: { engine: string; language?: string; rtf: number | null; inferS: number; segments: { start: number; end: number; text: string }[]; text: string; duration?: number | null } | null;
	error?: string | null;
}

async function analyze(cfg: HearConfig, source: string, mode: string, engine?: string, language?: string): Promise<HearResult> {
	const script = path.join(import.meta.dirname, "scripts", "hear.py");
	const args = [script, source, "--mode", mode, "--engine", engine ?? cfg.engine,
		"--language", language ?? cfg.language, "--threads", String(cfg.threads),
		"--gap-ms", String(cfg.gapMs), "--max-seg-s", String(cfg.maxSegS),
		"--whisper-model", cfg.whisperModel];
	if (cfg.cookiesFile) args.push("--cookies", expand(cfg.cookiesFile));
	const out = await runPython(cfg.pythonPath, args);
	// tolerate stray non-JSON lines (library banners): parse from first '{'
	const i = out.indexOf("{");
	if (i < 0) throw new Error(`analyzer produced no JSON: ${out.slice(0, 200)}`);
	return JSON.parse(out.slice(i)) as HearResult;
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const RENDER_LIMIT = 12_000; // chars of segment rendering; longer → artifact + preview

function fmt(r: HearResult): string {
	const parts: string[] = [];
	parts.push(`[hear] mode=${r.modeUsed}${r.duration ? ` duration=${(r.duration / 60).toFixed(1)}min` : ""}`);
	if (r.subtitle) {
		if (!r.subtitle.available) parts.push(`[subtitle] unavailable: ${r.subtitle.reason ?? "unknown"}`);
		else {
			parts.push(`[subtitle] ${r.subtitle.lines!.length} cues — ${r.subtitle.note ?? "AI subtitles"}`);
			for (const l of r.subtitle.lines!) parts.push(`[${mmss(l.start)}-${mmss(l.end)}] ${l.text.replace(/\n/g, " ")}`);
		}
	}
	if (r.asr) {
		const a = r.asr;
		parts.push(`[asr] engine=${a.engine} lang=${a.language ?? "?"} rtf=${a.rtf} infer=${a.inferS}s`);
		const lines = a.segments.map((s) => `[${mmss(s.start)}-${mmss(s.end)}] ${s.text}`);
		const joined = lines.join("\n");
		if (joined.length <= RENDER_LIMIT) parts.push(joined);
		else parts.push(joined.slice(0, RENDER_LIMIT / 2) + `\n… [${a.segments.length} segments total, render truncated — full text lost beyond here; for long media prefer downloading locally and running batch scripts]`);
	}
	if (r.error) parts.push(`[error] ${r.error}`);
	return parts.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => { cfg = loadConfig(); });
	let cfg = loadConfig(); // reloaded each session_start — config edits need no restart

	pi.registerTool({
		name: "hear",
		description:
			"Transcribe a video or audio file into a timestamped text transcript — fully local (only subtitle fetching touches the network). Accepts a local file path or a media URL (e.g. Bilibili). Default for URLs: fetch platform AI subtitles first — instant, but quality unverified; read the first ~200 chars and judge: if missing, empty, or clearly mismatched to the video's topic, rerun with mode='asr'. Local files go straight to ASR. ASR is CPU-heavy: roughly 3-6 minutes per hour of audio with all cores busy at 4 threads — tell the user the estimate BEFORE transcribing long media. mode='asr'/'subtitle' forces a lane. engine='sensevoice' (default: fast, zh/yue/en/ja/ko, punctuation built-in) or 'whisper' (better on English loanwords, needs optional faster-whisper install). language: 'auto' or 'zh','en','ja','ko','yue'. Visual frames are NOT extracted here — sample frames with ffmpeg yourself and read them via look.",
		parameters: Type.Object({
			source: Type.String({ description: "Local media file path, or a media URL (Bilibili etc.)" }),
			mode: Type.Optional(Type.String({ description: "Lane: auto (default) | asr | subtitle" })),
			engine: Type.Optional(Type.String({ description: "ASR engine override: sensevoice | whisper" })),
			language: Type.Optional(Type.String({ description: "auto | zh | en | ja | ko | yue" })),
		}),
		async execute(_toolCallId: string, args: { source?: string; mode?: string; engine?: string; language?: string } = {}) {
			if (!args?.source) return { content: [{ type: "text", text: "hear: source (path or URL) required" }], isError: true };
			const mode = ["auto", "asr", "subtitle"].includes(String(args.mode)) ? String(args.mode) : "auto";
			const engine = ["sensevoice", "whisper"].includes(String(args.engine)) ? String(args.engine) : undefined;
			try {
				const r = await analyze(cfg, String(args.source), mode, engine, args.language);
				return { content: [{ type: "text", text: fmt(r) }] };
			} catch (e) {
				return { content: [{ type: "text", text: `hear failed: ${String(e instanceof Error ? e.message : e)}` }], isError: true };
			}
		},
	});
}
