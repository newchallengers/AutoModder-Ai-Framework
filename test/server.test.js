const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');

test('frontend script parses and download action uses the model endpoint', () => {
    const html = fs.readFileSync(path.join(__dirname, '../frontend.html'), 'utf8');
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    const action = html.match(/window\.stepAction = function \(\) \{[\s\S]*?\n        };/)[0];
    const context = { window: {}, document: { getElementById: () => ({ textContent: 'Step 2' }) },
        currentRigId: 'test-rig', API: 'https://example.com', location: {} };
    vm.runInNewContext(action, context);
    context.window.stepAction();
    assert.equal(context.location.href, 'https://example.com/modder/fbx/test-rig');
});

test('generation, polling and download work through configured providers', async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-to-mod-test-'));
    const savedEnv = { ...process.env };
    process.env.STORAGE_ROOT = path.join(temp, 'storage');
    for (const name of ['MESHY_KEY_FILE', 'GEMINI_KEY_FILE']) {
        process.env[name] = path.join(temp, name);
        fs.writeFileSync(process.env[name], 'test-key');
    }
    process.env.IMAGE_PROMPT_FILE = path.join(temp, 'prompt');
    process.env.IMAGE_MODELS = 'test-image-model';
    process.env.PROMO_CODES_FILE = path.join(temp, 'allowances.json');
    fs.writeFileSync(process.env.PROMO_CODES_FILE, JSON.stringify({ TEST: { remaining: 2 } }));
    const axios = require('axios');
    const originalPost = axios.post, originalGet = axios.get;
    let calls = 0;
    axios.post = async (url, body) => {
        calls++;
        if (url.includes('generateContent')) {
            assert.equal(body.contents[0].parts[1].text, 'Test image instructions');
            return { status: 200, data: { candidates: [{ content: { parts: [{ inlineData: { data: 'dGVzdA==', mimeType: 'image/png' } }] } }] } };
        }
        if (url.endsWith('/image-to-3d')) return { status: 200, data: { result: 'test-image' } };
        if (url.endsWith('/rigging')) return { status: 200, data: { result: 'test-rig' } };
        throw Error('Unexpected external request');
    };
    axios.get = async url => {
        calls++;
        if (url.endsWith('/image-to-3d/test-image')) return { status: 200, data: { status: 'SUCCEEDED', model_urls: { glb: 'https://assets.meshy.ai/test.glb' } } };
        if (url.endsWith('/rigging/test-rig')) return { status: 200, data: { status: 'SUCCEEDED', result: {
            rigged_character_glb_url: 'https://assets.meshy.ai/test.glb', rigged_character_fbx_url: 'https://assets.meshy.ai/test.fbx',
        } } };
        if (url.endsWith('/test.fbx')) return { status: 200, data: Buffer.alloc(2048, 1) };
        throw Error('Unexpected external request');
    };
    const app = require('../server');
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        axios.post = originalPost; axios.get = originalGet;
        process.env = savedEnv;
        fs.rmSync(temp, { recursive: true, force: true });
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Promo-Code': 'TEST' }, body: JSON.stringify(body) });
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await (await fetch(base + '/modder/health')).json()).generation_configured, false);
    assert.equal((await post('/modder/generate', { image: 'data:image/png;base64,dGVzdA==' })).status, 503);
    assert.equal(calls, 0);
    fs.writeFileSync(process.env.IMAGE_PROMPT_FILE, 'Test image instructions');
    const generated = await (await post('/modder/generate', { image: 'data:image/png;base64,dGVzdA==' })).json();
    assert.equal(generated.task_id, 'test-image');
    const progress = await (await fetch(base + '/modder/status/test-image')).json();
    assert.equal(progress.status, 'SUCCEEDED');
    assert.equal(progress.rig_task_id, 'test-rig');
    const model = await fetch(base + '/modder/fbx/test-rig');
    assert.equal(model.status, 200);
    assert.equal((await model.arrayBuffer()).byteLength, 2048);
    assert.equal((await (await post('/modder/promo/check', { code: 'TEST' })).json()).remaining, 1);
    assert.equal((await fetch(base + '/modder/model?url=http://localhost/private')).status, 400);
});
