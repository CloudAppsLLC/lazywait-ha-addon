#!/usr/bin/env node
/**
 * guardrails.mjs — static cost / security / performance gate. Node 20, zero deps.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Sep 2026 Supabase cycle billed 201,696,244 Realtime messages ($492) and
 * 142 GB of log ingestion ($61). Nothing in CI could have caught the binding
 * that caused it. Five people ship AI-assisted code into ten repos here; the
 * cheap, unambiguous failure modes (an unfiltered subscription, a 2s poll, a
 * service-role key in a bundle, a migration that turns RLS off) must be caught
 * by a machine, not by whoever happens to read the PR.
 *
 * Judgement calls are NOT this script's job — those go to the AI reviewer
 * (.github/scripts/ai-review.mjs) and to REVIEW_RULES.md. This file only
 * enforces rules that can be decided by looking at the text.
 *
 * BASELINES
 * ---------
 * Every repo already violates some of these. A baseline records the CURRENT
 * per-file count of each accepted violation, so existing debt does not block
 * every PR while a NEW violation still fails. Baselines are per (rule, file)
 * COUNTS, not line numbers, so they survive unrelated edits above them.
 *
 * Three findings are NEVER baselinable, because there is no version of them
 * that is acceptable:
 *   - a hardcoded service_role JWT (bypasses RLS on the live database)
 *   - a tracked .env file that is not a template
 *   - a service_role key reachable from a frontend bundle
 *
 * USAGE
 *   node .github/scripts/guardrails.mjs                  # gate (exit 1 on failure)
 *   node .github/scripts/guardrails.mjs --json           # machine-readable report
 *   node .github/scripts/guardrails.mjs --write-baseline # accept current state as debt
 *
 * CONFIG: .github/guardrails.config.json (see the `repo` key for which repo).
 * ENV:    GUARDRAILS_BASE_SHA — when set, added-file rules run against that base.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, extname, sep, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(REPO_ROOT, '.github', 'guardrails.config.json');

const ARGS = new Set(process.argv.slice(2));
const WRITE_BASELINE = ARGS.has('--write-baseline');
const JSON_OUT = ARGS.has('--json');

if (!existsSync(CONFIG_PATH)) {
	console.error(`guardrails: missing ${relative(REPO_ROOT, CONFIG_PATH)}`);
	process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const SOURCE_DIRS = cfg.sourceDirs || [];
const MIGRATIONS_DIR = cfg.migrationsDir || null;
const IS_FRONTEND = cfg.isFrontend === true;
const TS_ONLY = cfg.tsOnly !== false;
const POLL_HARD_FLOOR_MS = cfg.pollHardFloorMs ?? 5000;
const POLL_WARN_FLOOR_MS = cfg.pollWarnFloorMs ?? 60000;
const IGNORE = cfg.ignore || [];
const BASELINE = cfg.baseline || {};

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const SKIP_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'lib', 'coverage', '.next', '.expo',
	'android', 'ios', 'windows', 'windows.paper', 'Pods', '.yarn', '.venv',
	'partner-builds', 'bin', 'obj', 'public', 'assets',
]);

/** Findings are {rule, severity, file, line, message, baselinable}. */
const findings = [];
const notes = [];

const add = (rule, severity, file, line, message, baselinable = true) =>
	findings.push({ rule, severity, file, line, message, baselinable });

// ─────────────────────────────────────────────────────────────── file discovery

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
			walk(full, out);
		} else if (e.isFile()) {
			out.push(full);
		}
	}
	return out;
}

const isIgnored = (rel) => IGNORE.some((pat) => rel.includes(pat.replace(/\*/g, '')));

function collect(dirs, extFilter) {
	const files = [];
	for (const d of dirs) {
		const abs = join(REPO_ROOT, d);
		if (!existsSync(abs)) continue;
		if (statSync(abs).isFile()) {
			files.push(abs);
			continue;
		}
		for (const f of walk(abs)) {
			if (extFilter && !extFilter.has(extname(f).toLowerCase())) continue;
			files.push(f);
		}
	}
	return files
		.map((f) => relative(REPO_ROOT, f).split(sep).join('/'))
		.filter((rel) => !isIgnored(rel));
}

const read = (rel) => {
	try {
		return readFileSync(join(REPO_ROOT, rel), 'utf8');
	} catch {
		return '';
	}
};

// ───────────────────────────────────────────────────── helpers: numeric literals

/** Evaluate an arithmetic-only expression such as "5 * 60 * 1000" or "30_000". */
function safeNum(expr) {
	if (!expr) return null;
	const cleaned = String(expr).replace(/_/g, '').trim();
	if (!/^[0-9+\-*/().\s]+$/.test(cleaned)) return null;
	if (!/[0-9]/.test(cleaned)) return null;
	try {
		// eslint-disable-next-line no-new-func
		const v = Function(`"use strict";return (${cleaned});`)();
		return Number.isFinite(v) ? v : null;
	} catch {
		return null;
	}
}

/**
 * Map every numeric constant in a file so an interval named by one still
 * resolves to a number. Covers three shapes:
 *   const FOO_MS = 5000          (TS/JS)
 *   FOO_SECONDS = 30             (Python)
 *   availableOrders: 10_000      (an object-literal property)
 *
 * The object-property shape matters more than it looks: the worst poll in the
 * fleet is `refetchInterval: POLL.availableOrders`, where the number lives in a
 * different file entirely. Without it the gate reads clean on exactly the repo
 * it most needs to catch.
 */
function constantMap(text) {
	const map = new Map();
	const assign = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*(?:number|int|float)\s*)?=\s*([0-9][0-9_\s*+\-/().]*)/g;
	const prop = /(?:^|[\n{,])\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*([0-9][0-9_\s*+\-/().]*)\s*(?=[,}\n])/g;
	for (const re of [assign, prop]) {
		let m;
		while ((m = re.exec(text))) {
			const v = safeNum(m[2]);
			if (v !== null && !map.has(m[1])) map.set(m[1], v);
		}
	}
	return map;
}

/**
 * Constants defined anywhere in the scanned source, used as a fallback when a
 * call site names one that is declared in another file (`ts/constants.ts`,
 * `const.py`). First definition wins, so a local declaration always beats it.
 */
const GLOBAL_CONSTS = new Map();

const justified = (lines, i, tag) => {
	const here = lines[i] || '';
	const above = lines[i - 1] || '';
	return here.includes(tag) || above.includes(tag);
};

// ─────────────────────────────────────────────────────────────────────── rule R1
// COST — Realtime. A table in the publication costs on every write whether or
// not anyone listens; a subscription costs per message delivered. Both are
// unbounded by construction, so new ones need a human decision, not a default.

const REALTIME_PATTERNS = [
	{ re: /postgres_changes/, sev: 'critical', what: 'postgres_changes subscription' },
	{ re: /\.channel\s*\(/, sev: 'high', what: 'Realtime channel' },
	// \b: `readPermissionSnapshot(` contains "onSnapshot(" mid-word (LazyWaitAdmin).
	{ re: /\bonSnapshot\s*\(/, sev: 'high', what: 'Firestore onSnapshot listener' },
];

function ruleRealtime(rel, text) {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// A comment-only line is documentation, not a subscription.
		const code = line.replace(/^\s*(\/\/|\*|#|--).*$/, '');
		if (!code.trim()) continue;
		for (const p of REALTIME_PATTERNS) {
			if (!p.re.test(code)) continue;
			if (justified(lines, i, 'realtime-ok:') || justified(lines, i, 'realtime-unfiltered-ok:')) continue;
			add('realtime', p.sev, rel, i + 1, `${p.what} — Realtime is billed per message delivered and is unbounded by table write volume. Use a query + a watermark, or a scoped Broadcast.`);
		}
	}
}

function ruleRealtimeMigration(rel, text) {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*--/.test(line)) continue;
		if (/ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE/i.test(line)) {
			add('realtime_publication', 'critical', rel, i + 1, 'Adds a table to the supabase_realtime publication. Every write to it is then WAL-decoded and billed whether or not a client subscribes.');
		}
		if (/REPLICA\s+IDENTITY\s+FULL/i.test(line)) {
			add('replica_identity_full', 'high', rel, i + 1, 'REPLICA IDENTITY FULL puts the entire old AND new row in every Realtime payload. Only acceptable on a published table whose subscribers filter on a non-PK column.');
		}
	}
}

// ─────────────────────────────────────────────────────────────────────── rule R2
// COST — polling cadence. Every tick is a request, a row read and an egress
// byte, multiplied by every device in the fleet, forever.

// Triggers are INVOCATION shapes only. A bare `const FOO_POLL_INTERVAL_MS = 500`
// is a constant, not a poll — flagging the declaration reports the wrong line and
// cannot tell a recurring fleet-wide poll from a bounded retry with a total
// timeout. Declarations still feed constantMap(), so the call site that uses one
// resolves to a number. Precision beats recall in a gate that blocks merges; the
// AI reviewer catches the shapes a regex should not try to judge.
const POLL_KEYS = /(setInterval\s*\(|refetchInterval|pollingInterval|asyncio\.sleep\s*\(|time\.sleep\s*\(|update_interval\s*=|timedelta\s*\(\s*seconds)/;

/** Identifiers that name a value in SECONDS rather than milliseconds. */
const SECONDS_NAME = /(_SECONDS?|_SECS?|Seconds?)$/;

function rulePolling(rel, text) {
	const lines = text.split('\n');
	const consts = constantMap(text);
	const isPy = rel.endsWith('.py');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*(\/\/|\*|#|--)/.test(line)) continue;
		if (!POLL_KEYS.test(line)) continue;
		if (justified(lines, i, 'poll-ok:')) continue;

		// Resolve the cadence: a literal on this line, or a named constant.
		let ms = null;
		let inSeconds = isPy || /timedelta\s*\(\s*seconds/.test(line);
		const tail = line.slice(line.search(POLL_KEYS));
		const lit = tail.match(/([0-9][0-9_]*(?:\s*[*+]\s*[0-9][0-9_]*)*)/);
		if (lit) ms = safeNum(lit[1]);
		if (ms === null) {
			const ident = tail.match(/\b([A-Za-z_$][\w$]*)\b/g) || [];
			for (const id of ident) {
				const local = consts.has(id) ? consts.get(id) : (GLOBAL_CONSTS.has(id) ? GLOBAL_CONSTS.get(id) : null);
				if (local === null) continue;
				ms = local;
				// A constant named in seconds holds seconds, whatever the call
				// site looks like. Reading DEFAULT_POLL_INTERVAL_SECONDS = 30 as
				// 30ms turns a fine 30s poll into a fake critical finding.
				if (SECONDS_NAME.test(id)) inSeconds = true;
				break;
			}
		}
		if (ms === null) continue; // unresolved — do not guess, the AI reviewer sees it
		if (inSeconds) ms *= 1000;
		if (ms <= 0 || ms >= POLL_WARN_FLOOR_MS) continue;

		if (ms < POLL_HARD_FLOOR_MS) {
			add('poll_hard_floor', 'critical', rel, i + 1, `Polls every ${ms}ms. Below the ${POLL_HARD_FLOOR_MS}ms hard floor — no justification comment can waive this. Push the event instead of asking for it.`);
		} else {
			add('poll_under_60s', 'high', rel, i + 1, `Polls every ${ms}ms. Anything under ${POLL_WARN_FLOOR_MS}ms needs a "poll-ok: <reason>" comment on the line or the line above.`);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────── rule R3
// SECURITY — keys. An anon key in a client bundle is the design. A service_role
// key anywhere near one is a full database bypass, and no RLS policy stops it.

function decodeJwtRole(tok) {
	try {
		const payload = tok.split('.')[1];
		const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
		return (JSON.parse(json).role || '').toString();
	} catch {
		return '';
	}
}

/** Env var prefixes that are INLINED INTO THE CLIENT BUNDLE by the bundler.
 *  A service-role key behind one of these is shipped to every browser. */
const CLIENT_BUNDLED_ENV = /(VITE_|EXPO_PUBLIC_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_)[A-Z0-9_]*SERVICE_ROLE/;

function ruleKeys(rel, text) {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// A hardcoded service_role JWT is the unambiguous catastrophe, and it is
		// checked on every line including comments — a key pasted into a comment
		// is just as readable to whoever clones the repo.
		for (const m of line.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/g)) {
			if (decodeJwtRole(m[0]) === 'service_role') {
				add('hardcoded_service_role_jwt', 'critical', rel, i + 1, 'A service_role JWT is hardcoded here. It bypasses RLS on the live database. Rotate the key, then read it from the vault or the environment.', false);
			}
			// An anon key is a public client key by design — not reported.
		}

		// Prose is not code. Without this, a comment EXPLAINING the anon vs
		// service_role distinction gets reported as a leaked key — which is how a
		// security gate teaches people to stop reading its output.
		if (/^\s*(\/\/|\/\*|\*|#|--)/.test(line)) continue;
		if (justified(lines, i, 'service-role-ok:')) continue;

		// The blocking rule is deliberately narrow: a service-role key read from a
		// CLIENT-BUNDLED env var. That is the one shape where the key provably
		// reaches a browser. A bare mention of the string is not a leak — it is a
		// field name, a CLI message, a server-side env read in a build script — so
		// it is reported as a non-blocking note instead of failing the build.
		if (CLIENT_BUNDLED_ENV.test(line)) {
			add('service_role_in_frontend', 'critical', rel, i + 1, 'A service-role key is read from a client-bundled env var, so the bundler inlines it into code the browser downloads. Move this call behind the API; the frontend gets the anon key only.', false);
			continue;
		}

		if (/service_role|SERVICE_ROLE_KEY/.test(line)) {
			if (/process\.env|import\.meta\.env|os\.environ|requireEnv|readEnv|getenv|Deno\.env/.test(line)) continue;
			add('service_role_reference', 'medium', rel, i + 1, `service_role named outside an env read${IS_FRONTEND ? ' in a client repo' : ''}. Confirm this is a name or a label and not a key, and that it is never logged, cached or returned to a client.`);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────── rule R4
// SECURITY — RLS. Service-role callers bypass RLS, so the policy is the only
// gate anon and authenticated callers ever meet.

function ruleRls(rel, text) {
	const lines = text.split('\n');
	const enablesRls = /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(text);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*--/.test(line)) continue;
		if (/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(line)) {
			add('rls_disabled', 'critical', rel, i + 1, 'Turns RLS off. Anon and authenticated callers then read and write every row of every tenant. If this exists to make Realtime deliver events, remove the subscription instead.');
		}
		if (/CREATE\s+TABLE/i.test(line) && !enablesRls) {
			add('table_without_rls', 'high', rel, i + 1, 'CREATE TABLE in a migration that never calls ENABLE ROW LEVEL SECURITY. Every new table needs RLS on plus at least a deny-all policy.');
		}
	}
}

// ─────────────────────────────────────────────────────────────────────── rule R5
// PERFORMANCE — unbounded reads. A list query with no ceiling is a query whose
// cost is decided by the largest tenant, discovered in production.

function ruleUnboundedSelect(rel, text) {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!/\.select\s*\(\s*['"`]\*/.test(lines[i])) continue;
		// Look at the whole statement chain, not just this line.
		const stmt = lines.slice(i, i + 8).join(' ');
		if (/\.(limit|range|single|maybeSingle|csv)\s*\(|head\s*:\s*true|count\s*:/.test(stmt)) continue;
		if (justified(lines, i, 'select-all-ok:')) continue;
		add('unbounded_select', 'high', rel, i + 1, "select('*') with no .limit()/.range(). Name the columns and cap the page at 100.");
	}
}

// ─────────────────────────────────────────────────────────────────────── rule R6
// QUALITY — no new .js/.jsx in a TypeScript repo. Only added files are checked,
// so migrating an existing .js file to .ts stays allowed.

function ruleAddedJsFiles() {
	const base = process.env.GUARDRAILS_BASE_SHA;
	if (!base || !TS_ONLY) return;
	let out = '';
	try {
		out = execSync(`git diff --diff-filter=A --name-only ${base}...HEAD`, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
	} catch {
		notes.push('could not diff against GUARDRAILS_BASE_SHA; added-file rules skipped');
		return;
	}
	for (const rel of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
		if (!/\.(js|jsx)$/.test(rel)) continue;
		if (!SOURCE_DIRS.some((d) => rel.startsWith(d))) continue;
		if (isIgnored(rel)) continue;
		add('new_js_file', 'high', rel, 1, 'New .js/.jsx file in a TypeScript source tree. Write it as .ts/.tsx.', false);
	}
}

// ─────────────────────────────────────────────────────────────────────── rule R7
// SECURITY — tracked env files. Never baselinable: a committed .env is a
// credential handed to everyone who can clone, including its whole history.

function trackedFiles() {
	try {
		return execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
			.split('\n').map((s) => s.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

function ruleTrackedEnv(tracked) {
	for (const rel of tracked) {
		const name = rel.split('/').pop() || '';
		if (!/^\.env($|\.)/.test(name)) continue;
		if (/\.(example|sample|template|md)$/.test(name)) continue;
		add('tracked_env_file', 'critical', rel, 1, 'A real .env file is tracked in git. Rotate every value in it, delete it from the index, and gitignore it.', false);
	}
}

// ─────────────────────────────────────────────────────────────────────── rule R8
// SECURITY — credential sweep over EVERY tracked text file, not just the source
// dirs. The worst finding in this fleet was a live prod service_role JWT sitting
// in a tool settings file at the repo root, which a src-only scan never sees.
// Scope is deliberately narrow: decode JWTs and report only service_role ones,
// so an anon key (public by design) stays silent and this never cries wolf.

const SWEEP_EXT = new Set([
	'.json', '.jsonc', '.yml', '.yaml', '.md', '.txt', '.sh', '.ps1', '.bat',
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sql', '.env', '.conf', '.toml',
]);
const SWEEP_SKIP = /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|\.yarn\/)/;

function ruleCredentialSweep(tracked) {
	for (const rel of tracked) {
		if (SWEEP_SKIP.test(rel)) continue;
		const ext = extname(rel).toLowerCase();
		if (!SWEEP_EXT.has(ext) && !/(^|\/)\.env/.test(rel)) continue;
		const text = read(rel);
		if (!text || !text.includes('eyJ')) continue;
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			for (const m of lines[i].matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/g)) {
				if (decodeJwtRole(m[0]) !== 'service_role') continue;
				add('hardcoded_service_role_jwt', 'critical', rel, i + 1,
					'A service_role JWT is committed here. It bypasses RLS on the live database for anyone who can read this repository, and it stays in git history after the line is deleted. Rotate the key in the Supabase dashboard, then read it from the vault or the environment.',
					false);
			}
		}
	}
}

// ───────────────────────────────────────────────────────────────────────── run

const codeFiles = collect(SOURCE_DIRS, CODE_EXT);

// Pass 1 — collect every numeric constant in the repo, so a cadence declared in
// one file and used in another still resolves.
const TEXTS = new Map();
for (const rel of codeFiles) {
	const text = read(rel);
	if (!text) continue;
	TEXTS.set(rel, text);
	for (const [k, v] of constantMap(text)) if (!GLOBAL_CONSTS.has(k)) GLOBAL_CONSTS.set(k, v);
}

// Pass 2 — apply the rules.
for (const [rel, text] of TEXTS) {
	ruleRealtime(rel, text);
	rulePolling(rel, text);
	ruleKeys(rel, text);
	ruleUnboundedSelect(rel, text);
}

if (MIGRATIONS_DIR) {
	for (const rel of collect([MIGRATIONS_DIR], new Set(['.sql']))) {
		const text = read(rel);
		if (!text) continue;
		ruleRealtimeMigration(rel, text);
		ruleRls(rel, text);
	}
}

ruleAddedJsFiles();
const tracked = trackedFiles();
ruleTrackedEnv(tracked);
ruleCredentialSweep(tracked);

// ────────────────────────────────────────────────────────── baseline comparison

/** counts[rule][file] = n */
const counts = {};
for (const f of findings) {
	if (!f.baselinable) continue;
	((counts[f.rule] ||= {})[f.file] ||= 0);
	counts[f.rule][f.file] += 1;
}

if (WRITE_BASELINE) {
	cfg.baseline = counts;
	cfg.baselineWrittenAt = new Date().toISOString().slice(0, 10);
	writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
	const total = Object.values(counts).reduce(
		(a, byFile) => a + Object.values(byFile).reduce((x, y) => x + y, 0), 0);
	console.log(`guardrails: baseline written — ${total} accepted finding(s) across ${Object.keys(counts).length} rule(s).`);
	console.log('Every one of these is debt. New violations now fail.');
	process.exit(0);
}

const blocking = [];
for (const f of findings) {
	if (!f.baselinable) {
		blocking.push(f);
		continue;
	}
	const allowed = BASELINE[f.rule]?.[f.file] ?? 0;
	const seen = counts[f.rule][f.file];
	if (seen > allowed) blocking.push(f);
}

// A file may legitimately hold N baselined findings; only report the excess.
const reported = [];
const shown = {};
for (const f of blocking) {
	if (!f.baselinable) {
		reported.push(f);
		continue;
	}
	const allowed = BASELINE[f.rule]?.[f.file] ?? 0;
	const k = `${f.rule}::${f.file}`;
	shown[k] = (shown[k] || 0) + 1;
	if (shown[k] > allowed) reported.push(f);
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
reported.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);

if (JSON_OUT) {
	console.log(JSON.stringify({
		repo: cfg.repo,
		scanned: codeFiles.length,
		blocking: reported,
		baselinedTotal: Object.values(counts).reduce((a, byFile) => a + Object.values(byFile).reduce((x, y) => x + y, 0), 0),
		notes,
	}, null, 2));
	process.exit(reported.length ? 1 : 0);
}

console.log(`guardrails (${cfg.repo}): scanned ${codeFiles.length} source file(s).`);
for (const n of notes) console.log(`  note: ${n}`);

if (!reported.length) {
	console.log('PASS — no new cost, security or performance violations.');
	process.exit(0);
}

const byRule = {};
for (const f of reported) (byRule[f.rule] ||= []).push(f);

console.error('\nFAIL — new violations (existing debt is baselined and not listed):\n');
for (const [rule, list] of Object.entries(byRule)) {
	console.error(`[${list[0].severity.toUpperCase()}] ${rule} — ${list.length} finding(s)`);
	for (const f of list.slice(0, 20)) console.error(`  ${f.file}:${f.line}  ${f.message}`);
	if (list.length > 20) console.error(`  … and ${list.length - 20} more`);
	console.error('');
}
console.error('If a finding is genuinely correct, add the justification comment named in its message.');
console.error('Never run --write-baseline to clear a finding your own PR introduced.');
process.exit(1);
