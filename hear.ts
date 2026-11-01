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
 * Whitebox execution: execute() takes the host's (signal, onUpdate) — abort
 * kills the whole python process group (SIGTERM→cleanup, SIGKILL escalation);
 * PROGRESS lines from the analyzer stream to onUpdate (throttled python-side)
 * and to a pi-taskwatcher footer chip (~/.pi/agent/status/hear-<id>.json).
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
	device: string; // cpu | cuda (local machine default: cpu)
	threads: number; // CPU threads for torch — keep conservative (4)
	language: string; // zh | en | ja | ko | yue | auto
	gapMs: number; // VAD stitch: merge utterances with gaps below this
	maxSegS: number; // VAD stitch: force-split segments longer than this
	pythonPath: string;
	cookiesFile?: string; // yt-dlp cookies for member-only sources
	proxy?: string; // yt-dlp proxy, e.g. http://127.0.0.1:7897 — needed for youtube
}

const DEFAULTS: HearConfig = {
	engine: "sensevoice",
	whisperModel: "small",
	device: "cpu",
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

function runPython(script: string, args: string[], opts: RunOpts = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		// detached → own process group: abort kills the whole tree (python +
		// its yt-dlp/ffmpeg children) with one group signal
		const child = spawn(expand(script), args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
		let out = "", err = "", lineBuf = "";
		let killed = false, killTimer: NodeJS.Timeout | undefined;

		const killTree = (sig: "SIGTERM" | "SIGKILL") => {
			try { if (child.pid) process.kill(-child.pid, sig); } catch { /* group already gone */ }
			try { child.kill(sig); } catch { /* already dead */ }
		};
		const onAbort = () => {
			killed = true;
			killTree("SIGTERM"); // python unwinds → tmpdirs cleaned, its children killed
			// torch C calls can hold the interpreter through SIGTERM — escalate
			killTimer = setTimeout(() => killTree("SIGKILL"), 2000);
			killTimer.unref?.();
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		const emit = (line: string) => {
			const [kind, ...vals] = line.split("\t").slice(1); // drop leading "PROGRESS"
			const p = fmtProgress(kind, vals, opts.engine);
			if (!p) return;
			if (opts.state && p.total > 0) opts.state.segTotal = p.total;
			try {
				opts.onUpdate?.({ content: [{ type: "text", text: p.text }], details: undefined });
				if (opts.taskId) writeStatus(opts.taskId, p.done, p.total, p.text.replace(/^hear: /, ""), opts.state?.owner);
			} catch { /* progress must never fail the run */ }
		};
		child.stdout.on("data", (d) => {
			out += d;
			lineBuf += d;
			let nl: number;
			while ((nl = lineBuf.indexOf("\n")) >= 0) {
				const line = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				if (line.startsWith("PROGRESS\t")) emit(line);
			}
		});
		child.stderr.on("data", (d) => (err += d));
		const cleanup = () => {
			if (killTimer) clearTimeout(killTimer);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		child.on("close", (code, sig) => {
			cleanup();
			if (killed || opts.signal?.aborted) return reject(new Error("aborted by user"));
			if (sig) return reject(new Error(`analyzer killed by ${sig}`));
			if (code === 0) return resolve(out);
			reject(new Error(`analyzer exit ${code}: ${err.slice(0, 400)}`));
		});
		child.on("error", (e) => { cleanup(); reject(e); });
	});
}

// python PROGRESS lines → user-visible text + pi-taskwatcher numbers.
// Throttling is python-side (≥2s); TS just forwards what arrives.
function fmtProgress(kind: string, vals: string[], engine?: string): { text: string; done: number; total: number } | null {
	if (kind === "stage") return { text: `hear: ${vals[0] ?? "working"} …`, done: 0, total: 0 };
	if (kind === "download") return { text: `hear: downloading audio … ${vals[0] ?? ""}`, done: 0, total: 0 };
	if (kind === "seg") {
		const done = Number(vals[0]) || 0, total = Number(vals[1]) || 0;
		const tail = engine ? ` · engine=${engine}` : "";
		const text = total > 0
			? `hear: transcribing ${done}/${total} segments (~${Math.min(100, Math.round((done / total) * 100))}%)${tail}`
			: `hear: transcribing ${done} segments${tail}`; // whisper: total unknown until done
		return { text, done, total };
	}
	return null;
}

// pi-taskwatcher status file (~/.pi/agent/status/<id>.json, atomic tmp+rename):
// shows a live footer chip while long transcriptions run. Best-effort only.
const STATUS_DIR = process.env.PI_TASK_STATUS_DIR ?? path.join(os.homedir(), ".pi", "agent", "status");

function writeStatus(id: string, done: number, total: number, note: string, owner?: string): void {
	try {
		fs.mkdirSync(STATUS_DIR, { recursive: true });
		const p = path.join(STATUS_DIR, `${id}.json`);
		fs.writeFileSync(`${p}.tmp`, JSON.stringify({ id, label: "hear", done, total, note, ...(owner ? { owner } : {}), updated: Math.floor(Date.now() / 1000) }));
		fs.renameSync(`${p}.tmp`, p);
	} catch { /* footer chip is optional — never fail the run */ }
}

function removeStatus(id: string): void {
	try { fs.rmSync(path.join(STATUS_DIR, `${id}.json`), { force: true }); } catch { /* best-effort */ }
}

interface HearResult {
	source?: string;
	modeUsed?: string;
	duration?: number | null;
	artifact?: string | null;
	subtitle?: { available: boolean; lang?: string; lines?: { start: number; end: number; text: string }[]; note?: string; reason?: string } | null;
	asr?: { engine: string; language?: string; rtf: number | null; inferS: number; segments: { start: number; end: number; text: string }[]; text: string; duration?: number | null } | null;
	error?: string | null;
}

interface RunOpts {
	signal?: AbortSignal; // host abort → kill the whole python process group
	onUpdate?: (partial: { content: { type: "text"; text: string }[]; details: undefined }) => void; // may be missing (old hosts / nested calls)
	engine?: string; // effective engine, for progress text
	taskId?: string; // pi-taskwatcher status id; undefined → no status file
	state?: { segTotal: number; owner?: string }; // mutable: seg total + owning conversation id
}

async function analyze(cfg: HearConfig, source: string, mode: string, engine?: string, language?: string, opts: RunOpts = {}): Promise<HearResult> {
	const script = path.join(import.meta.dirname, "scripts", "hear.py");
	const args = [script, source, "--mode", mode, "--engine", engine ?? cfg.engine,
		"--language", language ?? cfg.language, "--threads", String(cfg.threads),
		"--gap-ms", String(cfg.gapMs), "--max-seg-s", String(cfg.maxSegS),
		"--whisper-model", cfg.whisperModel];
	if (cfg.cookiesFile) args.push("--cookies", expand(cfg.cookiesFile));
	if (cfg.proxy) args.push("--proxy", cfg.proxy);
	if (cfg.device && cfg.device !== "cpu") args.push("--device", cfg.device);
	if (opts.onUpdate) args.push("--progress"); // else stdout stays pure JSON
	const out = await runPython(cfg.pythonPath, args, { ...opts, engine: engine ?? cfg.engine });
	// tolerate stray non-JSON lines (library banners / PROGRESS): parse from first '{'
	const clean = out.split("\n").filter((l) => !l.startsWith("PROGRESS\t")).join("\n");
	const i = clean.indexOf("{");
	if (i < 0) throw new Error(`analyzer produced no JSON: ${clean.slice(0, 200)}`);
	return JSON.parse(clean.slice(i)) as HearResult;
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const RENDER_LIMIT = 12_000; // chars of segment rendering; longer → artifact + preview
const PREVIEW_SEGS = 50; // segments shown when a full artifact file exists

const fmtSegment = (s: { start: number; end: number; text: string }) => `[${mmss(s.start)}-${mmss(s.end)}] ${s.text}`;

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
		if (r.artifact) {
			parts.push(`[artifact] full transcript (${a.segments.length} segments): ${r.artifact}`);
			parts.push(...a.segments.slice(0, PREVIEW_SEGS).map(fmtSegment));
			if (a.segments.length > PREVIEW_SEGS) parts.push(`… [preview of first ${PREVIEW_SEGS}; read the artifact file for the rest]`);
		} else {
			const joined = a.segments.map(fmtSegment).join("\n");
			if (joined.length <= RENDER_LIMIT) parts.push(joined);
			else parts.push(joined.slice(0, RENDER_LIMIT / 2) + `\n… [${a.segments.length} segments total, render truncated — download locally to get the .transcript.md artifact]`);
		}
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
		async execute(toolCallId: string, args: { source?: string; mode?: string; engine?: string; language?: string } = {}, signal?: AbortSignal, onUpdate?: RunOpts["onUpdate"], ctx?: { sessionManager?: { getSessionId?: () => string } }) {
			if (!args?.source) return { content: [{ type: "text", text: "hear: source (path or URL) required" }], isError: true };
			const mode = ["auto", "asr", "subtitle"].includes(String(args.mode)) ? String(args.mode) : "auto";
			const engine = ["sensevoice", "whisper"].includes(String(args.engine)) ? String(args.engine) : undefined;
			if (signal?.aborted) return { content: [{ type: "text", text: "hear: aborted by user" }], isError: true };
			// footer progress chip (pi-taskwatcher convention) — only when a host
			// actually watches progress; short ids keep the filename sane
			const short = (toolCallId ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(-8) || Math.random().toString(36).slice(2, 8);
			const taskId = onUpdate ? `hear-${short}` : undefined;
			const state = { segTotal: 0, owner: ctx?.sessionManager?.getSessionId?.() };
			try {
				const r = await analyze(cfg, String(args.source), mode, engine, args.language, { signal, onUpdate, taskId, state });
				if (taskId) {
					const total = state.segTotal || 1; // done=total → ✓ chip
					const note = r.asr ? `engine=${r.asr.engine} rtf=${r.asr.rtf}` : (r.subtitle?.available ? "subtitles" : "done");
					writeStatus(taskId, total, total, note, state.owner);
				}
				return { content: [{ type: "text", text: fmt(r) }] };
			} catch (e) {
				if (taskId) removeStatus(taskId);
				const msg = e instanceof Error ? e.message : String(e);
				const text = signal?.aborted || msg.includes("aborted") ? "hear: aborted by user" : `hear failed: ${msg}`;
				return { content: [{ type: "text", text }], isError: true };
			}
		},
	});
}
