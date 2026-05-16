import crypto from 'node:crypto';

/** @typedef {'kipra'|'geko'|'alpra'} Site */

/** Strapi upload file content-type UID (confirm with a real webhook if this changes). */
const UPLOAD_FILE_UID = 'plugin::upload.file';

const CONTENT_UID_PREFIX = /^api::(kipra|geko|alpra)-/;

const MEDIA_ROOT_SEGMENT = /^(kipra|geko|alpra)(\/|$)/i;

const HOOK_BY_SITE = /** @type {const} */ ({
	kipra: 'VERCEL_DEPLOY_HOOK_KIPRA',
	geko: 'VERCEL_DEPLOY_HOOK_GEKO',
	alpra: 'VERCEL_DEPLOY_HOOK_ALPRA'
});

/** @param {string} a @param {string} b */
function timingSafeEqualString(a, b) {
	try {
		const ba = Buffer.from(a, 'utf8');
		const bb = Buffer.from(b, 'utf8');
		if (ba.length !== bb.length) return false;
		return crypto.timingSafeEqual(ba, bb);
	} catch {
		return false;
	}
}

/**
 * Join folder ancestry from webhook `entry.folder` (+ optional `parent` chain).
 * @param {unknown} entry
 * @returns {string}
 */
function folderPathFromEntry(entry) {
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

/**
 * @param {string} uid
 * @param {unknown} entry
 * @returns {{ site: Site | null, reason: string, folderPath?: string }}
 */
function resolveSite(uid, entry) {
	if (typeof uid !== 'string' || !uid) {
		return { site: null, reason: 'missing_uid' };
	}

	const content = CONTENT_UID_PREFIX.exec(uid);
	if (content) {
		const site = /** @type {Site} */ (content[1]);
		return { site, reason: 'content_type' };
	}

	if (uid === UPLOAD_FILE_UID) {
		const folderPath = folderPathFromEntry(entry);
		const m = MEDIA_ROOT_SEGMENT.exec(folderPath);
		if (m) {
			const site = /** @type {Site} */ (m[1].toLowerCase());
			return { site, reason: 'media_folder', folderPath };
		}
		return {
			site: null,
			reason: folderPath ? 'media_folder_unmatched' : 'media_no_folder_path',
			folderPath: folderPath || undefined
		};
	}

	return { site: null, reason: 'unknown_uid' };
}

/**
 * @param {Site} site
 * @returns {string | undefined}
 */
function hookUrlForSite(site) {
	const key = HOOK_BY_SITE[site];
	const url = key ? process.env[key] : undefined;
	return typeof url === 'string' && url.trim() ? url.trim() : undefined;
}

/**
 * @param {{ method?: string, headers?: Record<string, unknown>, body?: unknown }} req
 * @param {{ status: (n: number) => { json: (j: unknown) => void }}} res
 */
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ error: 'Method Not Allowed' });
	}

	const expectedSecret = process.env.RELAYER_SHARED_SECRET;
	if (!expectedSecret || !String(expectedSecret).trim()) {
		console.error('[strapi-deploy] RELAYER_SHARED_SECRET is not set');
		return res.status(500).json({ error: 'Server misconfiguration' });
	}

	const rawAuth = req.headers.authorization;
	const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
	const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!timingSafeEqualString(bearer, String(expectedSecret).trim())) {
		return res.status(401).json({ error: 'Unauthorized' });
	}

	let body = req.body;
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch {
			return res.status(400).json({ error: 'Invalid JSON body' });
		}
	}
	if (!body || typeof body !== 'object') {
		return res.status(400).json({ error: 'Invalid JSON body' });
	}

	const { uid } = /** @type {Record<string, unknown>} */ (body);
	const entry = /** @type {Record<string, unknown>} */ (body).entry;

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

	const hookUrl = hookUrlForSite(resolved.site);
	if (!hookUrl) {
		console.error('[strapi-deploy] missing env for site', resolved.site);
		return res.status(500).json({ error: `Missing deploy hook env for ${resolved.site}` });
	}

	try {
		const upstream = await fetch(hookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
		const text = await upstream.text();
		const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
		if (!upstream.ok) {
			console.error('[strapi-deploy] hook failed', resolved.site, upstream.status, preview);
			return res.status(502).json({
				ok: false,
				site: resolved.site,
				reason: resolved.reason,
				hookStatus: upstream.status,
				hookBodyPreview: preview
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
