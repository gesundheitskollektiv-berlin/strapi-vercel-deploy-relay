import crypto from 'node:crypto';

const UPLOAD_FILE_UID = 'plugin::upload.file';

const HOOKS = {
	kipra: 'VERCEL_DEPLOY_HOOK_KIPRA',
	geko: 'VERCEL_DEPLOY_HOOK_GEKO',
	alpra: 'VERCEL_DEPLOY_HOOK_ALPRA'
};

const SITES = Object.keys(HOOKS);
const CONTENT_UID = new RegExp(`^api::(${SITES.join('|')})-`);
const MEDIA_ROOT = new RegExp(`^(${SITES.join('|')})(\\/|$)`, 'i');

function isTruthy(v) {
	return /^1|true|yes$/i.test(String(v ?? '').trim());
}

function sha12(s) {
	return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
}

function timingSafeEqualStr(a, b) {
	try {
		const ba = Buffer.from(a, 'utf8');
		const bb = Buffer.from(b, 'utf8');
		if (ba.length !== bb.length) return false;
		return crypto.timingSafeEqual(ba, bb);
	} catch {
		return false;
	}
}

function header(headers, nameLower) {
	if (!headers || typeof headers !== 'object') return '';
	const h = /** @type {Record<string, unknown>} */ (headers);
	let raw = h[nameLower];
	if (raw === undefined) {
		for (const key of Object.keys(h)) {
			if (key.toLowerCase() === nameLower) {
				raw = h[key];
				break;
			}
		}
	}
	const v = Array.isArray(raw) ? raw[0] : raw;
	return typeof v === 'string' ? v.trim() : '';
}

function extractCredentials(headers) {
	if (!headers || typeof headers !== 'object') return [];
	/** @type {{ source: string; value: string }[]} */
	const out = [];
	const authorization = header(headers, 'authorization');
	if (authorization.toLowerCase().startsWith('bearer ')) {
		const t = authorization.slice(7).trim();
		if (t) out.push({ source: 'authorization-bearer', value: t });
	}
	for (const name of ['relayer-shared-secret', 'x-relayer-shared-secret']) {
		const v = header(headers, name);
		if (v) out.push({ source: name, value: v });
	}
	return out;
}

function buildAuthDebug(headers, expected) {
	const h = headers && typeof headers === 'object' ? /** @type {Record<string, unknown>} */ (headers) : {};
	const headerNames = Object.keys(h);
	const candidates = extractCredentials(headers).map(({ source, value }) => ({
		source,
		length: value.length,
		sha12: sha12(value)
	}));
	return {
		headerNames,
		candidates,
		expected: { length: expected.length, sha12: sha12(expected) }
	};
}

/**
 * @param {{ headers?: Record<string, unknown> }} req
 * @returns {{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }}
 */
function authorize(req) {
	if (isTruthy(process.env.RELAYER_SKIP_AUTH)) {
		console.warn('[strapi-deploy] RELAYER_SKIP_AUTH is set — authentication disabled (testing only)');
		return { ok: true };
	}
	const expected = String(process.env.RELAYER_SHARED_SECRET ?? '').trim();
	if (!expected) {
		console.error('[strapi-deploy] RELAYER_SHARED_SECRET is not set');
		return { ok: false, status: 500, body: { error: 'Server misconfiguration' } };
	}
	const hdr =
		req.headers && typeof req.headers === 'object'
			? /** @type {Record<string, unknown>} */ (req.headers)
			: undefined;
	for (const { value } of extractCredentials(hdr)) {
		if (timingSafeEqualStr(value, expected)) {
			if (isTruthy(process.env.RELAYER_DEBUG_AUTH)) {
				console.warn('[strapi-deploy] auth ok', buildAuthDebug(hdr, expected));
			}
			return { ok: true };
		}
	}
	const debug = isTruthy(process.env.RELAYER_DEBUG_AUTH) ? buildAuthDebug(hdr, expected) : null;
	if (debug) console.warn('[strapi-deploy] auth failed', debug);
	return {
		ok: false,
		status: 401,
		body: debug ? { error: 'Unauthorized', debug } : { error: 'Unauthorized' }
	};
}

/** @param {unknown} body */
function parseJsonBody(body) {
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch {
			return null;
		}
	}
	if (!body || typeof body !== 'object') return null;
	return /** @type {Record<string, unknown>} */ (body);
}

/** @param {unknown} entry */
function folderPath(entry) {
	if (!entry || typeof entry !== 'object') return '';
	const o = /** @type {Record<string, unknown>} */ (entry);
	const segments = [];
	let node = o.folder;
	let guard = 0;
	while (node && typeof node === 'object' && guard++ < 64) {
		const f = /** @type {Record<string, unknown>} */ (node);
		let part = '';
		if (typeof f.name === 'string' && f.name.trim()) part = f.name.trim();
		else if (typeof f.slug === 'string' && f.slug.trim()) part = f.slug.trim();
		else if (typeof f.path === 'string' && f.path.trim()) {
			const bits = f.path.split('/').filter(Boolean);
			part = bits[bits.length - 1] ?? '';
		}
		if (part) segments.unshift(part.replace(/^\/+|\/+$/g, ''));
		node = f.parent;
	}
	return segments.join('/');
}

function hookUrlForSite(site) {
	const key = HOOKS[/** @type {keyof typeof HOOKS} */ (site)];
	const url = key ? process.env[key] : undefined;
	return typeof url === 'string' && url.trim() ? url.trim() : undefined;
}

/**
 * @param {string} uid
 * @param {unknown} entry
 */
function resolveSite(uid, entry) {
	if (typeof uid !== 'string' || !uid) {
		return { site: null, reason: 'missing_uid' };
	}

	const content = CONTENT_UID.exec(uid);
	if (content) {
		const site = content[1].toLowerCase();
		return { site, reason: 'content_type' };
	}

	if (uid === UPLOAD_FILE_UID) {
		const fp = folderPath(entry);
		const m = MEDIA_ROOT.exec(fp);
		if (m) {
			const site = m[1].toLowerCase();
			return { site, reason: 'media_folder', folderPath: fp };
		}
		return {
			site: null,
			reason: fp ? 'media_folder_unmatched' : 'media_no_folder_path',
			folderPath: fp || undefined
		};
	}

	return { site: null, reason: 'unknown_uid' };
}

/**
 * @param {string} site
 * @returns {Promise<{ ok: boolean; status: number; preview: string } | null>}
 */
async function triggerHook(site) {
	const hookUrl = hookUrlForSite(site);
	if (!hookUrl) return null;
	const upstream = await fetch(hookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{}'
	});
	const text = await upstream.text();
	const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
	return { ok: upstream.ok, status: upstream.status, preview };
}

/**
 * @param {{ method?: string; headers?: Record<string, unknown>; body?: unknown }} req
 * @param {{ status: (n: number) => { json: (j: unknown) => void }}} res
 */
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ error: 'Method Not Allowed' });
	}

	const auth = authorize(req);
	if (!auth.ok) {
		return res.status(auth.status).json(auth.body);
	}

	const body = parseJsonBody(req.body);
	if (!body) {
		return res.status(400).json({ error: 'Invalid JSON body' });
	}

	const { uid, entry } = body;
	const resolved = resolveSite(typeof uid === 'string' ? uid : '', entry);

	if (!resolved.site) {
		console.warn('[strapi-deploy] skipped', {
			uid,
			reason: resolved.reason,
			folderPath: resolved.folderPath
		});
		return res.status(200).json({
			ok: true,
			skipped: true,
			reason: resolved.reason,
			...(resolved.folderPath ? { folderPath: resolved.folderPath } : {})
		});
	}

	try {
		const upstream = await triggerHook(resolved.site);
		if (!upstream) {
			console.error('[strapi-deploy] missing env for site', resolved.site);
			return res.status(500).json({ error: `Missing deploy hook env for ${resolved.site}` });
		}
		if (!upstream.ok) {
			console.error('[strapi-deploy] hook failed', resolved.site, upstream.status, upstream.preview);
			return res.status(502).json({
				ok: false,
				site: resolved.site,
				reason: resolved.reason,
				hookStatus: upstream.status,
				hookBodyPreview: upstream.preview
			});
		}
		return res.status(200).json({
			ok: true,
			skipped: false,
			site: resolved.site,
			reason: resolved.reason,
			hookStatus: upstream.status
		});
	} catch (e) {
		console.error('[strapi-deploy] hook request error', e);
		return res.status(502).json({
			ok: false,
			site: resolved.site,
			reason: resolved.reason,
			error: e instanceof Error ? e.message : 'fetch failed'
		});
	}
}
