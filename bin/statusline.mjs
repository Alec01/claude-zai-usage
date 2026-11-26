#!/usr/bin/env node
/**
 * zai-usage-statusline — Claude Code custom status line.
 *
 * Renders:  glm-5.3 · high │ ctx 24.6k/200K 12.3% │ zai 5h 28% · wk 44% · web 6%
 *
 * - ctx segment: from the JSON Claude Code pipes to stdin (`context_window`);
 *   refreshed after every assistant message. Yellow above 70%, red above 90%.
 * - zai badge: quotas from the Zhipu/Z.ai Coding Plan endpoint
 *   (GET {base}/api/monitor/usage/quota/limit, Bearer auth): the 5h token
 *   window (TOKENS_LIMIT, or CREDIT_LIMIT on current plans, unit=3), the
 *   weekly token window (unit=6) and the web-tools quota (TIME_LIMIT:
 *   search-prime / web-reader / zread) — one segment per window the endpoint
 *   returns. Cached in os.tmpdir() for 45 s, keyed by a hash of base+key:
 *   concurrent sessions share one request per expiry (an in-flight fetch is
 *   leased by restamping the cache before it starts), key never on disk.
 *   After the endpoint stops answering, the last successful values stay on
 *   screen for 10 minutes. Colored by the highest shown value: green below
 *   70%, yellow at 70, red at 90; omitted when no quota.
 *
 * The API key is only ever sent to the vendor host it belongs to (strict
 * hostname match on ANTHROPIC_BASE_URL); any other host means no badge and
 * no request.
 *
 * Contract with Claude Code: always exit 0 and always print — a non-zero
 * exit or empty stdout blanks the status line.
 *
 * Environment:
 *   ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY  API key (env only, no settings.json parsing)
 *   ANTHROPIC_BASE_URL  provider base → quota host (bigmodel.cn → open.bigmodel.cn, z.ai → api.z.ai)
 *   ZAI_USAGE_BASE      quota host override (https: only; plain http: allowed on loopback for testing)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const SEP = " │ ";
const CACHE_TTL_MS = 45_000;
const STALE_MAX_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 4_000;

/** Used tokens: 834 → `834`, 24_600 → `24.6k`, 156_300 → `156.3k`, 150_000 → `150k` */
function fmtUsed(n) {
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) {
		const s = (n / 1000).toFixed(1);
		return `${s.endsWith(".0") ? s.slice(0, -2) : s}k`;
	}
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** Window size: 200_000 → `200K`, 1_000_000 → `1M` */
function fmtWindow(n) {
	if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** `glm-5.3-flash · high` — `[1m]` 1M-context suffix trimmed, effort level (or `think` for thinking-only models) after a separator */
function modelSegment(input) {
	const name = (input.model?.display_name || input.model?.id || "").replace(/\s*\[1m\]/gi, "").trim();
	if (!name) return null;
	const level = input.effort?.level || (input.thinking?.enabled ? "think" : "");
	return level ? `${name} · ${level}` : name;
}

/** `ctx 0.0k/200K 0.0%` before the first API response, `ctx 24.6k` without a known window, else `ctx 24.6k/200K 12.3%` */
function ctxSegment(cw) {
	const used = cw ? Number(cw.total_input_tokens) : NaN;
	const size = cw ? Number(cw.context_window_size) : NaN;
	if (!Number.isFinite(used) || used <= 0) {
		const shown = Number.isFinite(size) && size > 0 ? fmtWindow(size) : "200K";
		return `ctx 0.0k/${shown} 0.0%`;
	}
	if (!Number.isFinite(size) || size <= 0) return `ctx ${fmtUsed(used)}`;
	const pct = (used / size) * 100;
	const text = `ctx ${fmtUsed(used)}/${fmtWindow(size)} ${pct.toFixed(1)}%`;
	if (pct > 90) return `${RED}${text}${RESET}`;
	if (pct > 70) return `${YELLOW}${text}${RESET}`;
	return text;
}

/** Key from the env (Claude Code puts settings.env into the process environment); base strictly by hostname */
function resolveEndpoint() {
	const key = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
	const override = (process.env.ZAI_USAGE_BASE || "").trim();
	if (override) {
		// https only — plain http would carry the key in cleartext (loopback exempt for fixture testing)
		try {
			const u = new URL(override);
			const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname.toLowerCase());
			if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) {
				return { key, base: override.replace(/\/+$/, "") };
			}
		} catch {
			/* invalid override → no badge */
		}
		return { key, base: "" };
	}
	const raw = (process.env.ANTHROPIC_BASE_URL || "").trim();
	if (!raw || !key) return { key, base: "" };
	let host = "";
	try {
		host = new URL(raw).hostname.toLowerCase();
	} catch {
		return { key, base: "" };
	}
	if (host === "bigmodel.cn" || host.endsWith(".bigmodel.cn")) return { key, base: "https://open.bigmodel.cn" };
	if (host === "z.ai" || host.endsWith(".z.ai")) return { key, base: "https://api.z.ai" };
	return { key, base: "" };
}

/** Hash of base+key — identifies the cache file without writing the key to disk */
function cachePath(base, key) {
	const h = crypto.createHash("sha256").update(`${base}\n${key}`).digest("hex").slice(0, 16);
	return path.join(os.tmpdir(), `claude-zai-usage-${h}.json`);
}

function readCache(p) {
	try {
		const c = JSON.parse(fs.readFileSync(p, "utf8"));
		// okAt (last successful fetch) required: files written by older versions lack it and are refetched once
		if (typeof c.fetchedAt === "number" && typeof c.okAt === "number" && "quotas" in c) return c;
	} catch {
		/* corrupt or absent counts as absent */
	}
	return null;
}

/** Atomic write (pid-unique temp + rename); failures are non-fatal */
function writeCache(p, data) {
	const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(data));
		fs.renameSync(tmp, p);
	} catch {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
	}
}

/** number, or null when absent / not numeric */
function numOf(v) {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** Age of a timestamp: now - t, or Infinity when absent or in the future (a backward clock move never extends freshness) */
function ageOf(t, now) {
	return typeof t === "number" && t <= now ? now - t : Infinity;
}

/** Quota percentages {h5, wk, web} (null = endpoint lists no such window), or null when it lists none.
 * Token rows are TOKENS_LIMIT on older plans, CREDIT_LIMIT on current ones — same unit/percentage encoding. */
function parseQuotas(body) {
	const quotas = { h5: null, wk: null, web: null };
	for (const lim of body?.data?.limits ?? []) {
		const tokenRow = lim.type === "TOKENS_LIMIT" || lim.type === "CREDIT_LIMIT";
		if (tokenRow && lim.unit === 3 && quotas.h5 === null) quotas.h5 = numOf(lim.percentage);
		else if (tokenRow && lim.unit === 6 && quotas.wk === null) quotas.wk = numOf(lim.percentage);
		else if (lim.type === "TIME_LIMIT" && quotas.web === null) quotas.web = numOf(lim.percentage);
	}
	return quotas.h5 !== null || quotas.wk !== null || quotas.web !== null ? quotas : null;
}

/** {ok:true, quotas} when the endpoint answered (quotas null = no recognized windows), {ok:false} on any failure */
async function fetchQuotas(base, key) {
	let resp;
	try {
		resp = await fetch(`${base}/api/monitor/usage/quota/limit`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				"Accept-Language": "en-US,en",
			},
			redirect: "error",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch {
		return { ok: false };
	}
	if (!resp.ok) return { ok: false };
	try {
		const body = await resp.json();
		if (body?.success === false) return { ok: false };
		return { ok: true, quotas: parseQuotas(body) };
	} catch {
		return { ok: false };
	}
}

/** Fresh cache → no network; expired → fetch once (leased so racing runs reuse it);
 * a failed fetch keeps the last successful values for STALE_MAX_MS. */
async function readQuotas(base, key) {
	const p = cachePath(base, key);
	const now = Date.now();
	const cache = readCache(p);
	const shown = ageOf(cache?.okAt, now) <= STALE_MAX_MS ? cache.quotas : null;
	if (ageOf(cache?.fetchedAt, now) < CACHE_TTL_MS) return shown;
	// lease: restamp before fetching so runs racing this one see a fresh cache instead of refetching
	if (cache) writeCache(p, { fetchedAt: now, okAt: cache.okAt, quotas: shown });
	const res = await fetchQuotas(base, key);
	if (!res.ok) return shown;
	writeCache(p, { fetchedAt: now, okAt: now, quotas: res.quotas });
	return res.quotas;
}

function zaiBadge(q) {
	const segs = [];
	let pct = 0;
	for (const [label, v] of [["5h", numOf(q.h5)], ["wk", numOf(q.wk)], ["web", numOf(q.web)]]) {
		if (v === null) continue;
		pct = Math.max(pct, Math.round(v));
		segs.push(`${label} ${Math.round(v)}%`);
	}
	if (!segs.length) return null;
	const text = `zai ${segs.join(" · ")}`;
	if (pct >= 90) return `${RED}${text}${RESET}`;
	if (pct >= 70) return `${YELLOW}${text}${RESET}`;
	return `${GREEN}${text}${RESET}`;
}

async function main() {
	let input = {};
	try {
		input = JSON.parse(fs.readFileSync(0, "utf8")) || {};
	} catch {
		/* empty or garbage stdin → defaults */
	}
	const parts = [];
	const model = modelSegment(input);
	if (model) parts.push(model);
	parts.push(ctxSegment(input.context_window));

	const { key, base } = resolveEndpoint();
	if (base && key) {
		const q = await readQuotas(base, key);
		if (q) {
			const badge = zaiBadge(q);
			if (badge) parts.push(badge);
		}
	}
	return parts.join(SEP);
}

// EPIPE when Claude Code cancels an in-flight run for a newer one → done, quietly
process.stdout.on("error", () => process.exit(0));

try {
	process.stdout.write(`${await main()}\n`, () => process.exit(0));
} catch {
	process.stdout.write(`${DIM}zai-usage${RESET}\n`, () => process.exit(0));
}
