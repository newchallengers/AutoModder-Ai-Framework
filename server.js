'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────
const CFG = {
    port:              parseInt(process.env.PORT || '3010', 10),
    publicBase:        process.env.PUBLIC_BASE_URL || 'http://localhost:3010',
    storageRoot:       process.env.STORAGE_ROOT   || path.join(__dirname, 'storage'),
    meshyKeyFile:      process.env.MESHY_KEY_FILE  || path.join(os.homedir(), '.config/modder-meshy.key'),
    geminiKeyFile:     process.env.GEMINI_KEY_FILE || path.join(os.homedir(), '.config/modder-gemini.key'),
};

const dirs = {
    uploads:  path.join(CFG.storageRoot, 'uploads'),
    fbx:      path.join(CFG.storageRoot, 'fbx'),
    state:    path.join(CFG.storageRoot, 'state'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

function readKey(p) {
    try { return fs.readFileSync(p, 'utf8').trim() || null; }
    catch (_) { return null; }
}
const MESHY_KEY  = readKey(CFG.meshyKeyFile);
const GEMINI_KEY = readKey(CFG.geminiKeyFile);
if (!MESHY_KEY)  console.warn('[warn] no Meshy key at ' + CFG.meshyKeyFile);
if (!GEMINI_KEY) console.warn('[warn] no Gemini key at ' + CFG.geminiKeyFile);

// ─── Promo codes ─────────────────────────────────────────────────────
// Server-side allowlist of shareable codes that let a caller consume
// N free /modder/generate runs (which are the paid step — Meshy + Gemini).
// Codes are NEVER embedded in the frontend or repo; they live in a
// deploy-only file. Format:
//   { "SOMEPHRASE": { "remaining": 5 }, ... }
// Case-insensitive. Consumption count is persisted separately so hot
// edits to the allowlist don't reset usage. Absent file = no free
// generates; the endpoint returns 402 with a friendly message.
const PROMO_CODES_FILE = process.env.PROMO_CODES_FILE
    || path.join(os.homedir(), '.config/modder-promo-codes.json');
const PROMO_USED_PATH  = path.join(dirs.state, 'promo-used.json');
let promoAllowlist = {};   // { "CODE": { remaining: N } }
let promoUsed      = {};   // { "CODE": N }
function loadPromoAllowlist() {
    try {
        const raw = JSON.parse(fs.readFileSync(PROMO_CODES_FILE, 'utf8'));
        const norm = {};
        for (const k of Object.keys(raw)) norm[k.trim().toUpperCase()] = raw[k];
        promoAllowlist = norm;
        console.log('[promo] loaded ' + Object.keys(norm).length + ' code(s) from ' + PROMO_CODES_FILE);
    } catch (e) { promoAllowlist = {}; if (e.code !== 'ENOENT') console.warn('[promo] load fail: ' + e.message); }
}
function loadPromoUsed() {
    try { promoUsed = JSON.parse(fs.readFileSync(PROMO_USED_PATH, 'utf8')) || {}; }
    catch (_) { promoUsed = {}; }
}
function savePromoUsed() {
    try { fs.writeFileSync(PROMO_USED_PATH, JSON.stringify(promoUsed, null, 2)); }
    catch (e) { console.warn('[promo] save used fail: ' + e.message); }
}
loadPromoAllowlist();
loadPromoUsed();
function promoNormalize(code) { return String(code || '').trim().toUpperCase(); }
function promoRemaining(code) {
    const c = promoNormalize(code);
    if (!promoAllowlist[c]) return null;   // unknown code
    const cap = Math.max(0, parseInt(promoAllowlist[c].remaining || 0, 10));
    const used = Math.max(0, parseInt(promoUsed[c] || 0, 10));
    return Math.max(0, cap - used);
}
function promoConsume(code) {
    const c = promoNormalize(code);
    if (!promoAllowlist[c]) return false;
    if (promoRemaining(c) <= 0) return false;
    promoUsed[c] = (promoUsed[c] || 0) + 1;
    savePromoUsed();
    console.log('[promo] consumed 1 from ' + c + ' (used=' + promoUsed[c] + ')');
    return true;
}

// ─── Logging ─────────────────────────────────────────────────────────
const LOG_MAX = 400;
const ringBuf = [];
function log(tag, msg) {
    const line = new Date().toISOString() + '  [' + tag + '] ' + msg;
    ringBuf.push(line);
    while (ringBuf.length > LOG_MAX) ringBuf.shift();
    console.log(line);
}

// ─── State ───────────────────────────────────────────────────────────
const STATE_PATH = path.join(dirs.state, 'anims.json');
let state = { rigs: {} };  // rigTaskId → { fbxUrl, fbxLocalPath,  }
try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || state; } catch (_) {}
function saveState() {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
    catch (e) { log('boot', 'save state fail: ' + e.message); }
}

// ─── Small helpers ───────────────────────────────────────────────────
function safeId(s, max = 100) {
    return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, max);
}
function extractRigTaskIdFromUrl(url) {
    const m = /\/tasks\/([0-9a-f-]{20,})\//i.exec(url || '');
    return m ? m[1] : null;
}

// ─── Meshy: image-to-3d + rigging ────────────────────────────────────
async function meshyStartImage3d(publicImageUrl) {
    const r = await axios.post(
        'https://api.meshy.ai/openapi/v1/image-to-3d',
        {
            image_url: publicImageUrl,
            enable_pbr: false,
            should_texture: true,
            ...(process.env.MESHY_MODEL ? { ai_model: process.env.MESHY_MODEL } : {}),
        },
        {
            headers: { Authorization: 'Bearer ' + MESHY_KEY, 'Content-Type': 'application/json' },
            timeout: 60000,
            validateStatus: null,
        }
    );
    if (r.status >= 400) throw new Error('meshy image-to-3d ' + r.status + ': ' + JSON.stringify(r.data));
    const taskId = r.data && (r.data.result || r.data.id);
    if (!taskId) throw new Error('meshy image-to-3d returned no task id');
    return taskId;
}

async function meshyGetImageStatus(taskId) {
    const r = await axios.get(
        'https://api.meshy.ai/openapi/v1/image-to-3d/' + taskId,
        { headers: { Authorization: 'Bearer ' + MESHY_KEY }, timeout: 15000, validateStatus: null }
    );
    if (r.status >= 400) throw new Error('meshy image status ' + r.status);
    return r.data || {};
}

async function meshyStartRig(imageTaskId, imageGlbUrl) {
    const r = await axios.post(
        'https://api.meshy.ai/openapi/v1/rigging',
        { input_task_id: imageTaskId, model_url: imageGlbUrl },
        {
            headers: { Authorization: 'Bearer ' + MESHY_KEY, 'Content-Type': 'application/json' },
            timeout: 30000,
            validateStatus: null,
        }
    );
    if (r.status >= 400) throw new Error('meshy rigging ' + r.status + ': ' + JSON.stringify(r.data));
    const rigId = r.data && (r.data.result || r.data.id);
    if (!rigId) throw new Error('meshy rigging returned no task id');
    return rigId;
}

async function meshyGetRigStatus(rigId) {
    const r = await axios.get(
        'https://api.meshy.ai/openapi/v1/rigging/' + rigId,
        { headers: { Authorization: 'Bearer ' + MESHY_KEY }, timeout: 15000, validateStatus: null }
    );
    if (r.status >= 400) throw new Error('meshy rig status ' + r.status);
    return r.data || {};
}

// ─── Image preparation ─────────────────────────────
async function prepareImage(bytes, mime) {
    const prompt = readKey(process.env.IMAGE_PROMPT_FILE);
    const models = (process.env.IMAGE_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!prompt || !models.length) {
        throw new Error('Configure IMAGE_PROMPT_FILE and IMAGE_MODELS before generating images');
    }
    const b64 = bytes.toString('base64');
    for (const model of models) {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_KEY;
        const r = await axios.post(url, {
            contents: [{
                parts: [
                    { inlineData: { mimeType: mime, data: b64 } },
                    { text: prompt },
                ],
            }],
            generationConfig: { responseModalities: ['IMAGE'] },
        }, { timeout: 60000, validateStatus: null });
        if (r.status >= 400) { log('image', 'Provider response:' + ' HTTP ' + r.status); continue; }
        const parts = r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts;
        if (!parts) { log('image', 'Provider response:' + ' no parts'); continue; }
        const inline = parts.find(p => p.inlineData && p.inlineData.data);
        if (!inline) { log('image', 'Provider response:' + ' no inlineData'); continue; }
        return {
            bytes: Buffer.from(inline.inlineData.data, 'base64'),
            mime:  inline.inlineData.mimeType || 'image/png',
            model,
        };
    }
    throw new Error('Image preparation failed');
}

// ─── FBX auto-mirror ─────────────────────────────────────────────────
function fbxPath(rigId)   { return path.join(dirs.fbx, rigId + '.fbx'); }
function fbxHasLocal(rig) { try { return fs.statSync(fbxPath(rig)).size > 1024; } catch (_) { return false; } }
async function fbxMirror(rigId, remoteUrl) {
    if (fbxHasLocal(rigId)) return true;
    const r = await axios.get(remoteUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: null, maxContentLength: 100 * 1024 * 1024 });
    if (r.status >= 400 || !r.data) { log('fbx', rigId.slice(-6) + ' HTTP ' + r.status); return false; }
    fs.writeFileSync(fbxPath(rigId), Buffer.from(r.data));
    log('fbx', rigId.slice(-6) + ' saved ' + r.data.byteLength + 'B');
    return true;
}

// ─── Express app ─────────────────────────────────────────────────────
const app = express();

// Universal CORS — the modder frontend is served from a different origin.
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Promo-Code');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// Static public dirs — prepared images.
app.use('/public/uploads', express.static(dirs.uploads));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend.html')));

// ─── Ingest: photo upload ────────────────────────────────────────────
/**
 * POST /modder/generate
 * body: { image: "data:image/png;base64,..." }
 * Prepares the input image, uploads the extended PNG to public
 * disk, kicks off Meshy image-to-3d. Returns { task_id }.
 */
app.post('/modder/generate', express.json({ limit: '8mb' }), async (req, res) => {
    try {
        if (!MESHY_KEY || !GEMINI_KEY || !readKey(process.env.IMAGE_PROMPT_FILE) || !(process.env.IMAGE_MODELS || '').trim()) return res.status(503).json({ ok: false, error: 'server not configured' });
        // Promo gate — /generate is the paid step (Meshy + Gemini).
        // Client sends header X-Promo-Code (or body.promo_code) with a
        // valid, un-exhausted code. Consume one credit atomically before
        // any external API call; if it fails downstream we accept the
        // small cost of a wasted credit over the racier alternative.
        const promoCode = req.header('X-Promo-Code') || (req.body && req.body.promo_code) || '';
        const rem = promoRemaining(promoCode);
        if (rem === null || rem <= 0) {
            return res.status(402).json({ ok: false, error: 'promo_required',
                message: 'Pop in an access code to get started.' });
        }
        if (!promoConsume(promoCode)) {
            return res.status(402).json({ ok: false, error: 'promo_exhausted',
                message: 'That code is out of generations. Try another one.' });
        }
        const dataUrl = String((req.body && (req.body.image || req.body.image_data_url)) || '');
        const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(dataUrl);
        if (!m) return res.status(400).json({ ok: false, error: 'body.image must be a base64 data URL (image/png|jpeg|webp)' });
        const inputBytes = Buffer.from(m[2], 'base64');
        const inputMime  = m[1];
        log('gen', 'received ' + inputBytes.length + 'B mime=' + inputMime);

        // Image preparation
        const ext = await prepareImage(inputBytes, inputMime);
        log('gen', 'Image prepared: ' + ext.bytes.length + 'B');

        // Save extended PNG publicly so Meshy can fetch it
        const stamp = crypto.randomBytes(8).toString('hex');
        const fname = 'fullbody-' + stamp + '.png';
        const dst   = path.join(dirs.uploads, fname);
        fs.writeFileSync(dst, ext.bytes);
        const publicUrl = CFG.publicBase.replace(/\/$/, '') + '/public/uploads/' + fname;

        // Kick Meshy
        const taskId = await meshyStartImage3d(publicUrl);
        log('gen', 'meshy started task=' + taskId + ' src=' + publicUrl);
        res.json({ ok: true, task_id: taskId, extended_url: publicUrl });
    } catch (err) {
        log('gen', 'Image generation failed');
        res.status(502).json({ ok: false, error: 'Generation hit a snag. Check your provider setup and try again.' });
    }
});

/**
 * GET /modder/status/:taskId
 * Polls Meshy for image status; when done, auto-kicks rigging; when rig
 * done, mirrors FBX to /fbx/ and returns the character model URL. Response:
 * { ok, phase: 'image'|'rigging', status, progress, model_url|null, rig_task_id|null }
 */
const rigLinks = {};   // imageTaskId → rigTaskId
const rigStarting = new Set();
app.get('/modder/status/:taskId', async (req, res) => {
    try {
        if (!MESHY_KEY) return res.status(503).json({ ok: false, error: 'no Meshy key' });
        const tid = safeId(req.params.taskId);
        if (!tid) return res.status(400).json({ ok: false, error: 'bad task id' });
        const img = await meshyGetImageStatus(tid);
        const iSt = img.status || '?';
        const iPg = typeof img.progress === 'number' ? img.progress : null;
        const iUrls = img.model_urls || {};
        if (iSt !== 'SUCCEEDED') {
            return res.json({ ok: true, phase: 'image', status: iSt === '?' ? null : iSt, progress: iPg == null ? null : Math.round(iPg * 0.5), model_url: null });
        }
        // Image done — start / find rigging
        let rigId = rigLinks[tid];
        if (!rigId && !rigStarting.has(tid)) {
            const glb = iUrls.glb;
            if (!glb) return res.json({ ok: true, phase: 'image', status: 'SUCCEEDED', progress: 100, model_url: null, task_error: 'no glb from Meshy' });
            rigStarting.add(tid);
            try {
                rigId = await meshyStartRig(tid, glb);
                rigLinks[tid] = rigId;
                log('status', 'rig kicked img=' + tid.slice(-6) + ' rig=' + rigId.slice(-6));
            } finally { rigStarting.delete(tid); }
        }
        if (!rigId) return res.json({ ok: true, phase: 'image', status: 'SUCCEEDED', progress: 50, model_url: null });

        const rig = await meshyGetRigStatus(rigId);
        const rSt = rig.status || '?';
        const rPg = typeof rig.progress === 'number' ? rig.progress : null;
        if (rSt === 'SUCCEEDED') {
            const rd = rig.result || {};
            const anim = rd.basic_animations || {};
            const model_url = (rd.rigged_character_glb_url) || anim.running_glb_url || anim.walking_glb_url || null;
            const fbx_url = rd.rigged_character_fbx_url || rd.fbx_url || (rd.model_urls && rd.model_urls.fbx) || null;
            if (fbx_url && !fbxHasLocal(rigId)) {
                fbxMirror(rigId, fbx_url).catch(e => log('status', 'fbx mirror fail ' + e.message));
            }
            return res.json({ ok: true, phase: 'rigging', status: 'SUCCEEDED', progress: 100, model_url, rig_task_id: rigId });
        }
        if (rSt === 'FAILED' || rSt === 'CANCELED') {
            return res.json({ ok: true, phase: 'rigging', status: rSt, progress: rPg, model_url: iUrls.glb || null, task_error: rig.task_error || rSt });
        }
        return res.json({ ok: true, phase: 'rigging', status: rSt === '?' ? null : rSt, progress: rPg == null ? 50 : (50 + Math.round(rPg * 0.5)), model_url: null, rig_task_id: rigId });
    } catch (err) {
        log('status', 'FAIL ' + err.message);
        res.status(502).json({ ok: false, error: err.message });
    }
});

// ─── Model proxy — dodges CORS on Meshy CDN ──────────────────────────
const ALLOWED_MODEL_HOSTS = /^https:\/\/(?:[a-z0-9-]+\.)*(?:meshy\.ai|amazonaws\.com|cloudfront\.net|googleapis\.com|googleusercontent\.com)\//i;
app.get('/modder/model', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || !ALLOWED_MODEL_HOSTS.test(url)) return res.status(400).json({ ok: false, error: 'bad url' });
    try {
        const r = await axios.get(url, { responseType: 'stream', timeout: 30000 });
        res.set('Content-Type', r.headers['content-type'] || 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=300');
        r.data.pipe(res);
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ─── FBX download ────────────────────────────────────────────────────
app.get('/modder/fbx/:rigTaskId', async (req, res) => {
    const rigId = safeId(req.params.rigTaskId);
    if (!rigId) return res.status(400).json({ ok: false, error: 'bad rig id' });
    if (!fbxHasLocal(rigId) && MESHY_KEY) {
        try {
            const rig = await meshyGetRigStatus(rigId);
            if (rig.status === 'SUCCEEDED') {
                const rd = rig.result || {};
                const fbxUrl = rd.rigged_character_fbx_url || rd.fbx_url || (rd.model_urls && rd.model_urls.fbx) || null;
                if (fbxUrl) await fbxMirror(rigId, fbxUrl);
            }
        } catch (_) {}
    }
    if (!fbxHasLocal(rigId)) return res.status(404).json({ ok: false, error: 'FBX not available' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="char-' + rigId.slice(-8) + '.fbx"');
    res.set('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(fbxPath(rigId)).pipe(res);
});


app.post('/modder/promo/check', express.json({ limit: '2kb' }), (req, res) => {
    const remaining = promoRemaining((req.body && req.body.code) || '');
    res.json({ ok: remaining > 0, remaining: remaining || 0 });
});
app.post('/modder/frontlog', express.json({ limit: '32kb' }), (req, res) => res.sendStatus(204));
app.get('/modder/health', (req, res) => res.json({
    ok: true,
    generation_configured: !!(MESHY_KEY && GEMINI_KEY && readKey(process.env.IMAGE_PROMPT_FILE) && (process.env.IMAGE_MODELS || '').trim()),
}));
app.use('/modder', (req, res) => res.status(404).json({ ok: false, error: 'Unknown endpoint' }));
if (require.main === module) {
    app.listen(CFG.port, '127.0.0.1', () => log('boot', 'Listening on 127.0.0.1:' + CFG.port));
}
module.exports = app;
