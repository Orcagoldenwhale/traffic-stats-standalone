import express from 'express';
import { readdir, readFile, writeFile, unlink, mkdir, rename, appendFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, 'saved_sessions');
const DATA_FILE = join(__dirname, 'saved_sessions', '_current_data.json');
const CHESSBOARD_FILE = join(__dirname, 'saved_sessions', '_chessboard.json');
const ASSETS_FILE = join(__dirname, 'saved_sessions', '_assets.json');
const TRAFFIC_FILE = join(__dirname, 'saved_sessions', '_traffic.json');
const TRAFFIC_DATA_FILE = join(__dirname, 'saved_sessions', '_traffic_data.json');
const TRAFFIC_ADMIN_FILE = join(__dirname, 'saved_sessions', '_traffic_admin.json');
const TRAFFIC_ADMIN_DATA_FILE = join(__dirname, 'saved_sessions', '_traffic_admin_data.json');
const TRAFFIC_DATA_SNAPSHOT_FILE = join(__dirname, 'saved_sessions', '_traffic_data_snapshot.json');
const TRAFFIC_ADMIN_DATA_SNAPSHOT_FILE = join(__dirname, 'saved_sessions', '_traffic_admin_data_snapshot.json');

// Ensure saved_sessions directory exists
if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
}

// --- Backup System ---
const BACKUPS_DIR = join(SESSIONS_DIR, 'backups');
const MAX_BACKUPS_PER_FILE = 20;

if (!existsSync(BACKUPS_DIR)) {
    await mkdir(BACKUPS_DIR, { recursive: true });
}

/**
 * Creates a timestamped backup of a file before overwriting.
 * Automatically prunes old backups to keep only the last MAX_BACKUPS_PER_FILE.
 * @param {string} filePath - Absolute path to the file to backup
 */
async function createBackup(filePath) {
    try {
        if (!existsSync(filePath)) return; // Nothing to backup

        const fileName = filePath.split('/').pop().replace('.json', '');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `${fileName}__${timestamp}.json`;
        const backupPath = join(BACKUPS_DIR, backupName);

        // Copy current file to backup
        const content = await readFile(filePath, 'utf-8');
        await writeFile(backupPath, content, 'utf-8');
        console.log(`[Backup] Created: ${backupName}`);

        // Prune old backups for this file (keep last MAX_BACKUPS_PER_FILE)
        const allFiles = await readdir(BACKUPS_DIR);
        const thisFileBackups = allFiles
            .filter(f => f.startsWith(fileName + '__') && f.endsWith('.json'))
            .sort()
            .reverse(); // newest first

        if (thisFileBackups.length > MAX_BACKUPS_PER_FILE) {
            const toDelete = thisFileBackups.slice(MAX_BACKUPS_PER_FILE);
            for (const old of toDelete) {
                await unlink(join(BACKUPS_DIR, old));
                console.log(`[Backup] Pruned old: ${old}`);
            }
        }
    } catch (e) {
        console.error(`[Backup] Error creating backup for ${filePath}:`, e.message);
        // Never block the main write if backup fails
    }
}

// --- Audit Log (append-only JSONL) ---
const AUDIT_LOG_FILE = join(SESSIONS_DIR, '_audit.log');
const MAX_AUDIT_SIZE = 2 * 1024 * 1024; // 2 MB per file
const MAX_AUDIT_ARCHIVES = 3;
let auditWriteCount = 0;

async function auditLog(action, target, summary, req) {
    try {
        const entry = JSON.stringify({
            ts: new Date().toISOString(),
            action,
            target,
            ip: req?.ip || req?.connection?.remoteAddress || 'unknown',
            summary
        }) + '\n';
        await appendFile(AUDIT_LOG_FILE, entry, 'utf-8');

        if (++auditWriteCount % 50 === 0) {
            try {
                const s = await stat(AUDIT_LOG_FILE);
                if (s.size >= MAX_AUDIT_SIZE) {
                    for (let i = MAX_AUDIT_ARCHIVES - 1; i >= 1; i--) {
                        const src = AUDIT_LOG_FILE + '.' + i;
                        const dst = AUDIT_LOG_FILE + '.' + (i + 1);
                        if (existsSync(src)) await rename(src, dst);
                    }
                    await rename(AUDIT_LOG_FILE, AUDIT_LOG_FILE + '.1');
                    console.log('[Audit] Log rotated');
                }
            } catch { /* rotation failure is non-critical */ }
        }
    } catch (e) {
        console.error('[Audit] Failed to write audit log:', e.message);
    }
}

// --- Telegram Alerts ---
const TG_BOT_TOKEN = '8641196023:AAEJmgZVKAtS6Pwpzu9NF0wMPljAROjUVA0';
const TG_CHAT_ID = '-5144925546';

async function sendTelegramAlert(message) {
    try {
        await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        console.log('[Telegram] Alert sent');
    } catch (e) {
        console.error('[Telegram] Failed:', e.message);
    }
}

async function checkCostAlerts(configs, allCampaignsMap, source) {
    for (const config of configs) {
        const threshold = parseFloat(config.costAlert);
        if (!threshold || threshold <= 0) continue;
        for (const [key, camp] of Object.entries(allCampaignsMap)) {
            if (camp.customName !== config.name) continue;
            const cost = camp.stats?.allTime?.cost || 0;
            if (cost >= threshold) {
                await sendTelegramAlert(
                    `🔔 <b>Превышение расходов!</b>\n\n` +
                    `📊 ${source === 'admin' ? 'Traffic Admin' : 'Traffic Stats'}\n` +
                    `🏷 <b>${config.name}</b> → ${camp.name}\n` +
                    `💰 Расходы: <b>$${cost.toFixed(2)}</b>\n` +
                    `⚠️ Лимит: $${threshold.toFixed(2)}\n\n` +
                    `Отключите будильник чтобы остановить.`
                );
            }
        }
    }
}

// Порог трат для индикатора «нерабочего» ключа (allTime, USD).
const KEYWORD_ALERT_THRESHOLD = 15;

function _normalizeKw(s) {
    return (s || '').toString().trim().toLowerCase();
}

// Алерт: для кампаний с выбранным «рабочим» ключом проверяет остальные ключи.
// Если у кого-то allTime cost > порога — присылает ОДНО сообщение на кампанию
// со списком таких ключей. Дедупликации нет — алерт повторяется каждый цикл.
async function checkKeywordAlerts(configs, allCampaignsMap, source) {
    for (const config of configs) {
        const primary = _normalizeKw(config.primaryKeyword);
        if (!primary) continue;
        // Собираем нерабочие ключи с превышением для всех кампаний этого customName
        const offending = []; // { campaign, kwText, cost, adGroup }
        for (const [key, camp] of Object.entries(allCampaignsMap)) {
            if (camp.customName !== config.name) continue;
            const kws = Array.isArray(camp.keywords) ? camp.keywords : [];
            for (const kw of kws) {
                const txt = _normalizeKw(kw && kw.text);
                if (!txt) continue;
                if (txt === primary) continue;
                // PAUSED/REMOVED/пустые статусы не учитываем — алертим только активные ключи
                const status = (kw && kw.status ? String(kw.status) : '').trim().toUpperCase();
                if (status !== 'ENABLED') continue;
                const cost = parseFloat(kw && kw.cost) || 0;
                if (cost > KEYWORD_ALERT_THRESHOLD) {
                    offending.push({ campaign: camp.name, kwText: kw.text, cost, adGroup: kw.adGroup || '' });
                }
            }
        }
        if (offending.length === 0) continue;
        offending.sort((a, b) => b.cost - a.cost);
        const linesLimit = 10;
        const linesShown = offending.slice(0, linesLimit).map(o => `• «${o.kwText}» — $${o.cost.toFixed(2)}${o.adGroup ? ` <i>(${o.adGroup})</i>` : ''}`);
        const more = offending.length > linesLimit ? `\n…и ещё ${offending.length - linesLimit}` : '';
        await sendTelegramAlert(
            `🟡 <b>Нерабочий ключ со спендом > $${KEYWORD_ALERT_THRESHOLD}</b>\n\n` +
            `📊 ${source === 'admin' ? 'Traffic Admin' : 'Traffic Stats'}\n` +
            `🏷 <b>${config.name}</b>\n` +
            `⭐ Рабочий ключ: <b>${config.primaryKeyword}</b>\n\n` +
            `${linesShown.join('\n')}${more}`
        );
    }
}

// --- Per-file Mutex (prevents concurrent read-modify-write races) ---
const _fileLocks = new Map();

async function withFileLock(filePath, fn) {
    const key = filePath;
    while (_fileLocks.has(key)) {
        await _fileLocks.get(key);
    }
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    _fileLocks.set(key, promise);
    try {
        return await fn();
    } finally {
        _fileLocks.delete(key);
        resolve();
    }
}

// --- Path Traversal Protection ---
function safeName(name) {
    if (!name || typeof name !== 'string') return null;
    const clean = name.replace(/[^a-zA-Z0-9_\-\.]/g, '');
    if (!clean || clean.includes('..') || clean.startsWith('.')) return null;
    return clean;
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve static frontend files
const DIST_DIR = join(__dirname, 'dist');
const PUBLIC_DIR = join(__dirname, 'public');

app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }
    next();
});

if (existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
}
app.use(express.static(PUBLIC_DIR));

// --- Sync Timestamps ---
let timestamps = { data: Date.now(), chessboard: Date.now(), assets: Date.now(), traffic: Date.now(), traffic_data: Date.now(), traffic_admin: Date.now(), traffic_admin_data: Date.now() };

app.get('/api/status', (req, res) => {
    res.json(timestamps);
});

// --- Backup API ---

// GET list all available backups
app.get('/api/backups', async (req, res) => {
    try {
        if (!existsSync(BACKUPS_DIR)) return res.json([]);
        const files = await readdir(BACKUPS_DIR);
        const backups = [];
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            const parts = f.replace('.json', '').split('__');
            const dataType = parts[0]; // e.g. _chessboard
            const timestamp = parts[1] ? parts[1].replace(/-/g, (m, i) => i < 13 ? '-' : i === 13 ? 'T' : i < 19 ? ':' : '.') : '';
            const stat = existsSync(join(BACKUPS_DIR, f)) ? (await readFile(join(BACKUPS_DIR, f), 'utf-8')).length : 0;
            backups.push({ file: f, dataType, timestamp, sizeBytes: stat });
        }
        // Sort newest first
        backups.sort((a, b) => b.file.localeCompare(a.file));
        res.json(backups);
    } catch (e) {
        console.error('[Backup] Error listing backups:', e.message);
        res.json([]);
    }
});

// POST restore a specific backup
app.post('/api/backups/restore', async (req, res) => {
    try {
        const { file } = req.body;
        if (!file) return res.status(400).json({ error: 'Backup filename is required' });
        const cleanFile = safeName(file);
        if (!cleanFile) return res.status(400).json({ error: 'Invalid backup filename' });

        const backupPath = join(BACKUPS_DIR, cleanFile);
        if (!existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });

        // Determine target file from backup name
        const dataType = cleanFile.split('__')[0];
        const targetMap = {
            '_current_data': DATA_FILE,
            '_chessboard': CHESSBOARD_FILE,
            '_assets': ASSETS_FILE,
            '_traffic': TRAFFIC_FILE,
            '_traffic_admin': TRAFFIC_ADMIN_FILE
        };

        const targetFile = targetMap[dataType];
        if (!targetFile) return res.status(400).json({ error: `Unknown data type: ${dataType}` });

        // Before restoring, backup the CURRENT state (so restore is reversible!)
        await createBackup(targetFile);

        // Atomic restore: read backup → write to tmp → rename to target
        const backupContent = await readFile(backupPath, 'utf-8');
        // Validate JSON
        JSON.parse(backupContent);

        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = targetFile + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, backupContent, 'utf-8');
        await rename(tmpFile, targetFile);

        // Update timestamp so all tabs refresh
        const tsKey = dataType.replace('_current_data', 'data').replace('_', '');
        if (timestamps[tsKey] !== undefined) {
            timestamps[tsKey] = Date.now();
        }

        console.log(`[Backup] ✅ Restored ${cleanFile} → ${targetFile}`);
        auditLog('RESTORE', dataType, `backup=${cleanFile}`, req);
        res.json({ ok: true, restored: cleanFile, target: dataType });
    } catch (e) {
        console.error('[Backup] Error restoring:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- Current Data (active workspace) ---

// GET current data
app.get('/api/data', async (req, res) => {
    try {
        if (!existsSync(DATA_FILE)) return res.json(null);
        const data = JSON.parse(await readFile(DATA_FILE, 'utf-8'));
        res.json(data);
    } catch (e) {
        console.error('[Server] Error reading data:', e.message);
        res.json(null);
    }
});

// POST save current data
app.post('/api/data', async (req, res) => {
    try {
        const clientVersion = parseInt(req.query.version || '0', 10);
        if (clientVersion > 0 && clientVersion < timestamps.data) {
            return res.status(409).json({ error: 'Conflict: Data modified in another tab' });
        }
        await createBackup(DATA_FILE);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = DATA_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(req.body, null, 2), 'utf-8');
        await rename(tmpFile, DATA_FILE);
        timestamps.data = Date.now();
        auditLog('SAVE', 'data', `version=${timestamps.data}`, req);
        res.json({ ok: true, version: timestamps.data });
    } catch (e) {
        console.error('[Server] Error saving data:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE current data
app.delete('/api/data', async (req, res) => {
    try {
        if (existsSync(DATA_FILE)) await unlink(DATA_FILE);
        auditLog('DELETE', 'data', '', req);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Sessions (saved analyses) ---

// GET all sessions
app.get('/api/sessions', async (req, res) => {
    try {
        if (!existsSync(SESSIONS_DIR)) return res.json([]);
        const files = await readdir(SESSIONS_DIR);
        const sessions = [];
        for (const f of files) {
            if (!f.endsWith('.json') || f.startsWith('_')) continue;
            try {
                const content = JSON.parse(await readFile(join(SESSIONS_DIR, f), 'utf-8'));
                sessions.push(content);
            } catch { /* skip corrupt files */ }
        }
        res.json(sessions);
    } catch (e) {
        console.error('[Server] Error listing sessions:', e.message);
        res.json([]);
    }
});

// POST save/update session
app.post('/api/sessions', async (req, res) => {
    try {
        const session = req.body;
        if (!session.id) return res.status(400).json({ error: 'Missing session id' });
        const cleanId = safeName(session.id);
        if (!cleanId) return res.status(400).json({ error: 'Invalid session id' });
        const filePath = join(SESSIONS_DIR, `${cleanId}.json`);
        await createBackup(filePath);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = filePath + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(session, null, 2), 'utf-8');
        await rename(tmpFile, filePath);
        auditLog('SAVE', 'session', `id=${session.id}`, req);
        res.json({ ok: true });
    } catch (e) {
        console.error('[Server] Error saving session:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE session
app.delete('/api/sessions/:id', async (req, res) => {
    try {
        const cleanId = safeName(req.params.id);
        if (!cleanId) return res.status(400).json({ error: 'Invalid session id' });
        const filepath = join(SESSIONS_DIR, `${cleanId}.json`);
        if (existsSync(filepath)) await unlink(filepath);
        auditLog('DELETE', 'session', `id=${req.params.id}`, req);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Chessboard (Traffic Grid) ---

// GET chessboard data
app.get('/api/chessboard', async (req, res) => {
    try {
        if (!existsSync(CHESSBOARD_FILE)) return res.json([]);
        const data = JSON.parse(await readFile(CHESSBOARD_FILE, 'utf-8'));
        res.json(data);
    } catch (e) {
        console.error('[Server] Error reading chessboard:', e.message);
        res.json([]);
    }
});

// POST save chessboard data (atomic write)
app.post('/api/chessboard', async (req, res) => {
    try {
        const clientVersion = parseInt(req.query.version || '0', 10);
        if (clientVersion > 0 && clientVersion < timestamps.chessboard) {
            return res.status(409).json({ error: 'Conflict: Chessboard modified in another tab' });
        }
        if (!Array.isArray(req.body)) {
            return res.status(400).json({ error: 'Data must be an array' });
        }
        // Atomic write: write to temp file, then rename
        await createBackup(CHESSBOARD_FILE);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = CHESSBOARD_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(req.body, null, 2), 'utf-8');
        await rename(tmpFile, CHESSBOARD_FILE);
        timestamps.chessboard = Date.now();
        auditLog('SAVE', 'chessboard', `${req.body.length} items`, req);
        res.json({ ok: true, version: timestamps.chessboard });
    } catch (e) {
        console.error('[Server] Error saving chessboard:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE chessboard data
app.delete('/api/chessboard', async (req, res) => {
    try {
        if (existsSync(CHESSBOARD_FILE)) await unlink(CHESSBOARD_FILE);
        auditLog('DELETE', 'chessboard', '', req);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Asset Manager ---

// GET assets data
app.get('/api/assets', async (req, res) => {
    try {
        if (!existsSync(ASSETS_FILE)) return res.json({ landings: [], accounts: [] });
        const data = JSON.parse(await readFile(ASSETS_FILE, 'utf-8'));
        res.json(data);
    } catch (e) {
        console.error('[Server] Error reading assets:', e.message);
        res.json({ landings: [], accounts: [] });
    }
});

// POST save assets data (atomic write)
app.post('/api/assets', async (req, res) => {
    try {
        const clientVersion = parseInt(req.query.version || '0', 10);
        if (clientVersion > 0 && clientVersion < timestamps.assets) {
            return res.status(409).json({ error: 'Conflict: Assets modified in another tab' });
        }
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Data must be an object' });
        }
        // Atomic write: write to temp file, then rename
        await createBackup(ASSETS_FILE);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = ASSETS_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(req.body, null, 2), 'utf-8');
        await rename(tmpFile, ASSETS_FILE);
        timestamps.assets = Date.now();
        auditLog('SAVE', 'assets', `keys=${Object.keys(req.body).join(',')}`, req);
        res.json({ ok: true, version: timestamps.assets });
    } catch (e) {
        console.error('[Server] Error saving assets:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE assets data
app.delete('/api/assets', async (req, res) => {
    try {
        if (existsSync(ASSETS_FILE)) await unlink(ASSETS_FILE);
        auditLog('DELETE', 'assets', '', req);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Traffic Config Manager ---

// GET traffic data
app.get('/api/traffic', async (req, res) => {
    try {
        if (!existsSync(TRAFFIC_FILE)) return res.json([]);
        const data = JSON.parse(await readFile(TRAFFIC_FILE, 'utf-8'));
        res.json(data);
    } catch (e) {
        console.error('[Server] Error reading traffic config:', e.message);
        res.json([]);
    }
});

// POST save traffic data (atomic write)
app.post('/api/traffic', async (req, res) => {
    try {
        const clientVersion = parseInt(req.query.version || '0', 10);
        if (clientVersion > 0 && clientVersion < timestamps.traffic) {
            return res.status(409).json({ error: 'Conflict: Traffic configuration modified in another tab' });
        }
        if (!Array.isArray(req.body)) {
            return res.status(400).json({ error: 'Data must be an array' });
        }
        await withFileLock(TRAFFIC_FILE, async () => {
            await createBackup(TRAFFIC_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(req.body, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_FILE);
            timestamps.traffic = Date.now();
        });
        auditLog('SAVE', 'traffic', `${req.body.length} configs`, req);
        res.json({ ok: true, version: timestamps.traffic });
        refreshTrafficData().catch(e => console.error('[Server] Auto-refresh failed:', e));
    } catch (e) {
        console.error('[Server] Error saving traffic config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE single traffic campaign
app.delete('/api/traffic/:name', async (req, res) => {
    try {
        const campaignToDelete = req.params.name;
        await withFileLock(TRAFFIC_FILE, async () => {
            if (!existsSync(TRAFFIC_FILE)) throw Object.assign(new Error('Config file not found'), { status: 404 });
            const data = await readFile(TRAFFIC_FILE, 'utf-8');
            let configs = JSON.parse(data);
            const initialLength = configs.length;
            configs = configs.filter(c => c.name !== campaignToDelete);
            if (configs.length === initialLength) throw Object.assign(new Error('Campaign not found'), { status: 404 });
            await createBackup(TRAFFIC_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(configs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_FILE);
            timestamps.traffic = Date.now();
        });
        auditLog('DELETE', 'traffic', `campaign=${campaignToDelete}`, req);
        res.json({ ok: true, version: timestamps.traffic });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error deleting traffic config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// PATCH single traffic campaign properties
app.patch('/api/traffic/:name', async (req, res) => {
    try {
        const campaignToUpdate = req.params.name;
        const ALLOWED_PATCH_FIELDS = ['comment', 'customStatus', 'siteUrl', 'costAlert', 'campTask', 'campTimer', 'primaryKeyword'];
        const updates = {};
        for (const key of ALLOWED_PATCH_FIELDS) {
            if (req.body[key] !== undefined) {
                const val = req.body[key];
                if (typeof val === 'string' && val.length > 2000) return res.status(400).json({ error: `Field ${key} too long` });
                updates[key] = val;
            }
        }
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No allowed fields provided' });
        }

        await withFileLock(TRAFFIC_FILE, async () => {
            if (!existsSync(TRAFFIC_FILE)) throw Object.assign(new Error('Config file not found'), { status: 404 });
            const data = await readFile(TRAFFIC_FILE, 'utf-8');
            let configs = JSON.parse(data);
            let found = false;
            configs = configs.map(c => {
                if (c.name === campaignToUpdate) { found = true; return { ...c, ...updates }; }
                return c;
            });
            if (!found) throw Object.assign(new Error('Campaign not found'), { status: 404 });
            await createBackup(TRAFFIC_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(configs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_FILE);
            timestamps.traffic = Date.now();
        });

        auditLog('PATCH', 'traffic', `campaign=${campaignToUpdate} fields=${Object.keys(updates).join(',')}`, req);

        try {
            await withFileLock(TRAFFIC_DATA_FILE, async () => {
                if (!existsSync(TRAFFIC_DATA_FILE)) return;
                const cacheRaw = await readFile(TRAFFIC_DATA_FILE, 'utf-8');
                const cache = JSON.parse(cacheRaw);
                if (cache.data) {
                    let cacheChanged = false;
                    for (const [key, camp] of Object.entries(cache.data)) {
                        if (camp.customName === campaignToUpdate) { Object.assign(camp, updates); cacheChanged = true; }
                    }
                    if (cacheChanged) {
                        const ctmpId = Date.now() + Math.random().toString(36).slice(2);
                        const ctmpFile = TRAFFIC_DATA_FILE + '.' + ctmpId + '.tmp';
                        await writeFile(ctmpFile, JSON.stringify(cache), 'utf-8');
                        await rename(ctmpFile, TRAFFIC_DATA_FILE);
                        timestamps.traffic_data = Date.now();
                    }
                }
            });
        } catch (cacheErr) {
            console.error('[Server] Non-critical: failed to update cache inline:', cacheErr.message);
        }

        if (updates.costAlert && parseFloat(updates.costAlert) > 0) {
            try {
                const cacheRaw = await readFile(TRAFFIC_DATA_FILE, 'utf-8');
                const cache = JSON.parse(cacheRaw);
                if (cache.data) {
                    const threshold = parseFloat(updates.costAlert);
                    for (const [key, camp] of Object.entries(cache.data)) {
                        if (camp.customName !== campaignToUpdate) continue;
                        const cost = camp.stats?.allTime?.cost || 0;
                        if (cost >= threshold) {
                            sendTelegramAlert(
                                `🔔 <b>Превышение расходов!</b>\n\n` +
                                `📊 Traffic Stats\n` +
                                `🏷 <b>${campaignToUpdate}</b> → ${camp.name}\n` +
                                `💰 Расходы: <b>$${cost.toFixed(2)}</b>\n` +
                                `⚠️ Лимит: $${threshold.toFixed(2)}\n\n` +
                                `Будильник активирован — условие уже выполнено!`
                            );
                        }
                    }
                }
            } catch (alertErr) { console.error('[Server] Immediate alert check failed:', alertErr.message); }
        }

        res.json({ ok: true });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error updating traffic config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// PUT edit traffic campaign (name + url)
app.put('/api/traffic/:name/edit', async (req, res) => {
    try {
        const oldName = req.params.name;
        const { newName, newUrl, newSiteUrl } = req.body;
        if (!newName || !newUrl) return res.status(400).json({ error: 'newName and newUrl are required' });
        await withFileLock(TRAFFIC_FILE, async () => {
            if (!existsSync(TRAFFIC_FILE)) throw Object.assign(new Error('Config file not found'), { status: 404 });
            const data = await readFile(TRAFFIC_FILE, 'utf-8');
            let configs = JSON.parse(data);
            let found = false;
            configs = configs.map(c => {
                if (c.name === oldName) { found = true; return { ...c, name: newName, url: newUrl, siteUrl: newSiteUrl !== undefined ? newSiteUrl : (c.siteUrl || '') }; }
                return c;
            });
            if (!found) throw Object.assign(new Error('Campaign not found'), { status: 404 });
            await createBackup(TRAFFIC_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(configs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_FILE);
            timestamps.traffic = Date.now();
        });
        auditLog('EDIT', 'traffic', `old=${oldName} new=${newName}`, req);
        res.json({ ok: true });
        refreshTrafficData({ onlyCampaignName: newName }).catch(e => console.error('[Server] Auto-refresh after edit failed:', e));
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error editing traffic config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// PUT replace traffic config order
app.put('/api/traffic/reorder', async (req, res) => {
    try {
        const newOrderNames = req.body.names;
        if (!Array.isArray(newOrderNames)) return res.status(400).json({ error: 'Expected names array' });
        await withFileLock(TRAFFIC_FILE, async () => {
            if (!existsSync(TRAFFIC_FILE)) throw Object.assign(new Error('Config file not found'), { status: 404 });
            const data = await readFile(TRAFFIC_FILE, 'utf-8');
            const configs = JSON.parse(data);
            const seen = new Set();
            const newConfigs = [];
            for (const name of newOrderNames) { if (seen.has(name)) continue; seen.add(name); const found = configs.find(c => c.name === name); if (found) newConfigs.push(found); }
            for (const c of configs) { if (!seen.has(c.name)) newConfigs.push(c); }
            await createBackup(TRAFFIC_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(newConfigs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_FILE);
            timestamps.traffic = Date.now();
        });
        auditLog('REORDER', 'traffic', `${newOrderNames.length} items`, req);
        res.json({ ok: true });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error reordering traffic configs:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Beacon fallback for reorder (sendBeacon sends POST, not PUT)
app.post('/api/traffic/reorder-beacon', async (req, res) => {
    try {
        const newOrderNames = req.body.names;
        if (!Array.isArray(newOrderNames)) return res.status(400).end();
        await withFileLock(TRAFFIC_FILE, async () => {
            if (!existsSync(TRAFFIC_FILE)) throw new Error('not found');
            const data = await readFile(TRAFFIC_FILE, 'utf-8');
            const configs = JSON.parse(data);
            const seen = new Set();
            const newConfigs = [];
            for (const name of newOrderNames) { if (seen.has(name)) continue; seen.add(name); const found = configs.find(c => c.name === name); if (found) newConfigs.push(found); }
            for (const c of configs) { if (!seen.has(c.name)) newConfigs.push(c); }
            await createBackup(TRAFFIC_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(newConfigs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_FILE);
            timestamps.traffic = Date.now();
        });
        auditLog('REORDER-BEACON', 'traffic', `${newOrderNames.length} items`, req);
        res.status(200).end();
    } catch (e) {
        console.error('[Server] Error reordering (beacon):', e.message);
        res.status(500).end();
    }
});

// --- Move campaign from Traffic Stats to Traffic Admin ---
app.post('/api/traffic/move-to-admin', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Campaign name is required' });

        // Lock BOTH files to prevent races; always lock in consistent order to avoid deadlocks
        await withFileLock(TRAFFIC_FILE, async () => {
            await withFileLock(TRAFFIC_ADMIN_FILE, async () => {
                if (!existsSync(TRAFFIC_FILE)) throw Object.assign(new Error('Traffic config not found'), { status: 404 });
                const trafficRaw = await readFile(TRAFFIC_FILE, 'utf-8');
                let trafficConfigs = JSON.parse(trafficRaw);
                const campaign = trafficConfigs.find(c => c.name === name);
                if (!campaign) throw Object.assign(new Error('Campaign not found in Traffic Stats'), { status: 404 });

                let adminConfigs = [];
                if (existsSync(TRAFFIC_ADMIN_FILE)) {
                    adminConfigs = JSON.parse(await readFile(TRAFFIC_ADMIN_FILE, 'utf-8'));
                }
                if (adminConfigs.some(c => c.name === name)) throw Object.assign(new Error('Campaign already exists in Traffic Admin'), { status: 409 });

                trafficConfigs = trafficConfigs.filter(c => c.name !== name);
                adminConfigs.push({ ...campaign, movedAt: new Date().toISOString() });

                await createBackup(TRAFFIC_FILE);
                await createBackup(TRAFFIC_ADMIN_FILE);

                // Write admin first (adding), then traffic (removing) — if admin write fails, traffic is unchanged
                const tmpId2 = Date.now() + Math.random().toString(36).slice(2);
                const tmpFile2 = TRAFFIC_ADMIN_FILE + '.' + tmpId2 + '.tmp';
                await writeFile(tmpFile2, JSON.stringify(adminConfigs, null, 2), 'utf-8');
                await rename(tmpFile2, TRAFFIC_ADMIN_FILE);

                const tmpId1 = Date.now() + Math.random().toString(36).slice(2);
                const tmpFile1 = TRAFFIC_FILE + '.' + tmpId1 + '.tmp';
                await writeFile(tmpFile1, JSON.stringify(trafficConfigs, null, 2), 'utf-8');
                await rename(tmpFile1, TRAFFIC_FILE);

                timestamps.traffic = Date.now();
                timestamps.traffic_admin = Date.now();
            });
        });

        auditLog('MOVE-TO-ADMIN', 'traffic', `campaign=${name}`, req);
        res.json({ ok: true });
        refreshTrafficAdminData({ onlyCampaignName: name }).catch(e => console.error('[Server] Admin auto-refresh after move failed:', e));
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error moving campaign to admin:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- Traffic Admin Config Manager (independent from Traffic Stats) ---

app.get('/api/traffic-admin', async (req, res) => {
    try {
        if (!existsSync(TRAFFIC_ADMIN_FILE)) return res.json([]);
        const data = JSON.parse(await readFile(TRAFFIC_ADMIN_FILE, 'utf-8'));
        res.json(data);
    } catch (e) {
        console.error('[Server] Error reading traffic-admin config:', e.message);
        res.json([]);
    }
});

app.post('/api/traffic-admin', async (req, res) => {
    try {
        const clientVersion = parseInt(req.query.version || '0', 10);
        if (clientVersion > 0 && clientVersion < timestamps.traffic_admin) {
            return res.status(409).json({ error: 'Conflict: Traffic Admin configuration modified in another tab' });
        }
        if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Data must be an array' });
        await withFileLock(TRAFFIC_ADMIN_FILE, async () => {
            await createBackup(TRAFFIC_ADMIN_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_ADMIN_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(req.body, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_ADMIN_FILE);
            timestamps.traffic_admin = Date.now();
        });
        auditLog('SAVE', 'traffic-admin', `${req.body.length} configs`, req);
        res.json({ ok: true, version: timestamps.traffic_admin });
        refreshTrafficAdminData().catch(e => console.error('[Server] Admin auto-refresh failed:', e));
    } catch (e) {
        console.error('[Server] Error saving traffic-admin config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/traffic-admin/:name', async (req, res) => {
    try {
        const campaignToDelete = req.params.name;
        await withFileLock(TRAFFIC_ADMIN_FILE, async () => {
            if (!existsSync(TRAFFIC_ADMIN_FILE)) throw Object.assign(new Error('Config file not found'), { status: 404 });
            const data = await readFile(TRAFFIC_ADMIN_FILE, 'utf-8');
            let configs = JSON.parse(data);
            const initialLength = configs.length;
            configs = configs.filter(c => c.name !== campaignToDelete);
            if (configs.length === initialLength) throw Object.assign(new Error('Campaign not found'), { status: 404 });
            await createBackup(TRAFFIC_ADMIN_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_ADMIN_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(configs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_ADMIN_FILE);
            timestamps.traffic_admin = Date.now();
        });
        auditLog('DELETE', 'traffic-admin', `campaign=${campaignToDelete}`, req);
        res.json({ ok: true, version: timestamps.traffic_admin });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error deleting traffic-admin config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/traffic-admin/:name', async (req, res) => {
    try {
        const campaignToUpdate = req.params.name;
        const ALLOWED_PATCH_FIELDS = ['comment', 'customStatus', 'siteUrl', 'costAlert', 'campTask', 'campTimer', 'primaryKeyword'];
        const updates = {};
        for (const key of ALLOWED_PATCH_FIELDS) {
            if (req.body[key] !== undefined) {
                const val = req.body[key];
                if (typeof val === 'string' && val.length > 2000) return res.status(400).json({ error: `Field ${key} too long` });
                updates[key] = val;
            }
        }
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No allowed fields provided' });

        await withFileLock(TRAFFIC_ADMIN_FILE, async () => {
            if (!existsSync(TRAFFIC_ADMIN_FILE)) throw Object.assign(new Error('Config file not found'), { status: 404 });
            const data = await readFile(TRAFFIC_ADMIN_FILE, 'utf-8');
            let configs = JSON.parse(data);
            let found = false;
            configs = configs.map(c => {
                if (c.name === campaignToUpdate) { found = true; return { ...c, ...updates }; }
                return c;
            });
            if (!found) throw Object.assign(new Error('Campaign not found'), { status: 404 });
            await createBackup(TRAFFIC_ADMIN_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_ADMIN_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(configs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_ADMIN_FILE);
            timestamps.traffic_admin = Date.now();
        });

        auditLog('PATCH', 'traffic-admin', `campaign=${campaignToUpdate} fields=${Object.keys(updates).join(',')}`, req);

        try {
            await withFileLock(TRAFFIC_ADMIN_DATA_FILE, async () => {
                if (!existsSync(TRAFFIC_ADMIN_DATA_FILE)) return;
                const cacheRaw = await readFile(TRAFFIC_ADMIN_DATA_FILE, 'utf-8');
                const cache = JSON.parse(cacheRaw);
                if (cache.data) {
                    let cacheChanged = false;
                    for (const [key, camp] of Object.entries(cache.data)) {
                        if (camp.customName === campaignToUpdate) { Object.assign(camp, updates); cacheChanged = true; }
                    }
                    if (cacheChanged) {
                        const ctmpId = Date.now() + Math.random().toString(36).slice(2);
                        const ctmpFile = TRAFFIC_ADMIN_DATA_FILE + '.' + ctmpId + '.tmp';
                        await writeFile(ctmpFile, JSON.stringify(cache), 'utf-8');
                        await rename(ctmpFile, TRAFFIC_ADMIN_DATA_FILE);
                        timestamps.traffic_admin_data = Date.now();
                    }
                }
            });
        } catch (cacheErr) {
            console.error('[Server] Non-critical: failed to update admin cache inline:', cacheErr.message);
        }

        if (updates.costAlert && parseFloat(updates.costAlert) > 0) {
            try {
                const cacheRaw = await readFile(TRAFFIC_ADMIN_DATA_FILE, 'utf-8');
                const cache = JSON.parse(cacheRaw);
                if (cache.data) {
                    const threshold = parseFloat(updates.costAlert);
                    for (const [key, camp] of Object.entries(cache.data)) {
                        if (camp.customName !== campaignToUpdate) continue;
                        const cost = camp.stats?.allTime?.cost || 0;
                        if (cost >= threshold) {
                            sendTelegramAlert(
                                `🔔 <b>Превышение расходов!</b>\n\n` +
                                `📊 Traffic Admin\n` +
                                `🏷 <b>${campaignToUpdate}</b> → ${camp.name}\n` +
                                `💰 Расходы: <b>$${cost.toFixed(2)}</b>\n` +
                                `⚠️ Лимит: $${threshold.toFixed(2)}\n\n` +
                                `Будильник активирован — условие уже выполнено!`
                            );
                        }
                    }
                }
            } catch (alertErr) { console.error('[Server] Immediate admin alert check failed:', alertErr.message); }
        }

        res.json({ ok: true });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error updating traffic-admin config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/traffic-admin/:name/edit', async (req, res) => {
    try {
        const oldName = req.params.name;
        const { newName, newUrl, newSiteUrl } = req.body;
        if (!newName || !newUrl) return res.status(400).json({ error: 'newName and newUrl are required' });
        await withFileLock(TRAFFIC_ADMIN_FILE, async () => {
            if (!existsSync(TRAFFIC_ADMIN_FILE)) throw Object.assign(new Error('Config file not found'), { status: 404 });
            const data = await readFile(TRAFFIC_ADMIN_FILE, 'utf-8');
            let configs = JSON.parse(data);
            let found = false;
            configs = configs.map(c => {
                if (c.name === oldName) { found = true; return { ...c, name: newName, url: newUrl, siteUrl: newSiteUrl !== undefined ? newSiteUrl : (c.siteUrl || '') }; }
                return c;
            });
            if (!found) throw Object.assign(new Error('Campaign not found'), { status: 404 });
            await createBackup(TRAFFIC_ADMIN_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_ADMIN_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(configs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_ADMIN_FILE);
            timestamps.traffic_admin = Date.now();
        });
        auditLog('EDIT', 'traffic-admin', `old=${oldName} new=${newName}`, req);
        res.json({ ok: true });
        refreshTrafficAdminData({ onlyCampaignName: newName }).catch(e => console.error('[Server] Admin auto-refresh after edit failed:', e));
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error editing traffic-admin config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/traffic-admin/reorder', async (req, res) => {
    try {
        const newOrderNames = req.body.names;
        if (!Array.isArray(newOrderNames)) return res.status(400).json({ error: 'Expected names array' });
        await withFileLock(TRAFFIC_ADMIN_FILE, async () => {
            if (!existsSync(TRAFFIC_ADMIN_FILE)) throw Object.assign(new Error('Config file not found'), { status: 404 });
            const data = await readFile(TRAFFIC_ADMIN_FILE, 'utf-8');
            const configs = JSON.parse(data);
            const seen = new Set();
            const newConfigs = [];
            for (const name of newOrderNames) { if (seen.has(name)) continue; seen.add(name); const found = configs.find(c => c.name === name); if (found) newConfigs.push(found); }
            for (const c of configs) { if (!seen.has(c.name)) newConfigs.push(c); }
            await createBackup(TRAFFIC_ADMIN_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_ADMIN_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(newConfigs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_ADMIN_FILE);
            timestamps.traffic_admin = Date.now();
        });
        auditLog('REORDER', 'traffic-admin', `${newOrderNames.length} items`, req);
        res.json({ ok: true });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        console.error('[Server] Error reordering traffic-admin configs:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/traffic-admin/reorder-beacon', async (req, res) => {
    try {
        const newOrderNames = req.body.names;
        if (!Array.isArray(newOrderNames)) return res.status(400).end();
        await withFileLock(TRAFFIC_ADMIN_FILE, async () => {
            if (!existsSync(TRAFFIC_ADMIN_FILE)) throw new Error('not found');
            const data = await readFile(TRAFFIC_ADMIN_FILE, 'utf-8');
            const configs = JSON.parse(data);
            const seen = new Set();
            const newConfigs = [];
            for (const name of newOrderNames) { if (seen.has(name)) continue; seen.add(name); const found = configs.find(c => c.name === name); if (found) newConfigs.push(found); }
            for (const c of configs) { if (!seen.has(c.name)) newConfigs.push(c); }
            await createBackup(TRAFFIC_ADMIN_FILE);
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = TRAFFIC_ADMIN_FILE + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(newConfigs, null, 2), 'utf-8');
            await rename(tmpFile, TRAFFIC_ADMIN_FILE);
            timestamps.traffic_admin = Date.now();
        });
        auditLog('REORDER-BEACON', 'traffic-admin', `${newOrderNames.length} items`, req);
        res.status(200).end();
    } catch (e) {
        console.error('[Server] Error reordering traffic-admin (beacon):', e.message);
        res.status(500).end();
    }
});

app.post('/api/traffic-admin/refresh', async (req, res) => {
    auditLog('REFRESH', 'traffic_admin_data', 'manual', req);
    res.json({ success: true, started: true });
    refreshTrafficAdminData().catch(e => console.error('[Server] Manual admin refresh failed:', e.message));
});

app.get('/api/traffic-admin/today-analytics', async (req, res) => {
    try {
        const mode = req.query.mode === 'yesterday' ? 'yesterday' : 'today';
        const text = await buildTodayAnalytics({ mode });
        res.json({ success: true, mode, text, generatedAt: new Date().toISOString() });
    } catch (e) {
        console.error('[Server] today-analytics failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Ручной запуск сохранения дневного отчёта (полезно для тестов и бэкфилла)
app.post('/api/traffic-admin/today-analytics/save', async (req, res) => {
    try {
        await saveDailyAnalytics();
        res.json({ success: true });
    } catch (e) {
        console.error('[Server] daily analytics save failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Список всех сохранённых дневных отчётов аналитики (today_analytics_YYYY-MM-DD.txt)
app.get('/api/traffic-admin/today-analytics/list', async (req, res) => {
    try {
        if (!existsSync(ANALYTICS_DIR)) return res.json({ success: true, files: [] });
        const names = await readdir(ANALYTICS_DIR);
        const items = [];
        for (const n of names) {
            const m = /^today_analytics_(\d{4}-\d{2}-\d{2})\.txt$/.exec(n);
            if (!m) continue;
            const fp = join(ANALYTICS_DIR, n);
            try {
                const st = await stat(fp);
                items.push({ date: m[1], size: st.size, mtime: st.mtimeMs });
            } catch {}
        }
        items.sort((a, b) => b.date.localeCompare(a.date));
        res.json({ success: true, files: items });
    } catch (e) {
        console.error('[Server] today-analytics/list failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Содержимое сохранённого файла аналитики за указанную дату
app.get('/api/traffic-admin/today-analytics/file', async (req, res) => {
    try {
        const date = String(req.query.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date format (expected YYYY-MM-DD)' });
        const fp = join(ANALYTICS_DIR, `today_analytics_${date}.txt`);
        // Защита от path traversal: имя строится из валидированной даты, но дополнительно проверим, что файл лежит внутри ANALYTICS_DIR.
        if (!fp.startsWith(ANALYTICS_DIR)) return res.status(400).json({ error: 'Bad path' });
        if (!existsSync(fp)) return res.status(404).json({ error: 'File not found for this date' });
        const text = await readFile(fp, 'utf-8');
        const st = await stat(fp);
        res.json({ success: true, date, mtime: st.mtimeMs, text });
    } catch (e) {
        console.error('[Server] today-analytics/file failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/traffic-admin/:name/refresh', async (req, res) => {
    try {
        const campaignName = req.params.name;
        auditLog('REFRESH', 'traffic_admin_data', `single:${campaignName}`, req);
        await refreshTrafficAdminData({ onlyCampaignName: campaignName });
        res.json({ success: true });
    } catch (e) {
        console.error('[Server] Single admin refresh failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/traffic-admin-data', async (req, res) => {
    try {
        if (!existsSync(TRAFFIC_ADMIN_DATA_FILE)) return res.json({ success: true, data: {} });
        const raw = await readFile(TRAFFIC_ADMIN_DATA_FILE, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.send(withImpressionsStale(raw));
    } catch (e) {
        console.error('[Server] Error reading traffic-admin-data cache:', e.message);
        res.json({ success: true, data: {} });
    }
});

// --- Google Sheets Proxy ---

function parseCSV(text) {
    const lines = text.split('\n');
    return lines.filter(l => l.trim().length > 0).map(line => {
        const arr = [];
        let quote = false;
        let col = '';
        for (let c = 0; c < line.length; c++) {
            let cc = line[c], nc = line[c + 1];
            if (cc === '"' && quote && nc === '"') { col += cc; ++c; continue; }
            if (cc === '"') { quote = !quote; continue; }
            if (cc === ',' && !quote) { arr.push(col); col = ''; continue; }
            col += cc;
        }
        arr.push(col);
        return arr.map(s => s.trim().replace(/^"|"$/g, ''));
    });
}

async function fetchWithTimeout(url, timeoutMs = 30000, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            return res;
        } catch (e) {
            clearTimeout(timer);
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                continue;
            }
            throw e;
        }
    }
}

// Универсальный парсер дат из Google Sheets (Info / Метаданные).
// Принимает строку в разных форматах (Google локали, ISO, с/без leading-zero)
// и возвращает валидный ISO UTC или null, если формат не распознан.
function parseSheetDate(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;

    const pad2 = (x) => String(x).padStart(2, '0');

    // 1) ISO: yyyy-MM-dd[ T]H:mm:ss[.fff][Z|+hh:mm] — самый частый кейс из NEW/Info/Метаданные
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
        const [, y, mo, d, h, mi, se, tz] = m;
        const iso = `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${mi}:${se}${tz ? (tz === 'Z' ? 'Z' : tz) : 'Z'}`;
        const t = Date.parse(iso);
        return isNaN(t) ? null : new Date(t).toISOString();
    }

    // 2) Русская локаль Google Sheets: dd.MM.yyyy H:mm:ss
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/);
    if (m) {
        const [, d, mo, y, h, mi, se] = m;
        const iso = `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${mi}:${se}Z`;
        const t = Date.parse(iso);
        return isNaN(t) ? null : new Date(t).toISOString();
    }

    // 3) Американская локаль: M/d/yyyy H:mm:ss (на случай разных настроек таблицы)
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/);
    if (m) {
        const [, mo, d, y, h, mi, se] = m;
        const iso = `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${mi}:${se}Z`;
        const t = Date.parse(iso);
        return isNaN(t) ? null : new Date(t).toISOString();
    }

    // 4) Последняя попытка — нативный Date.parse (ISO-подобные варианты)
    const t = Date.parse(s);
    if (!isNaN(t)) return new Date(t).toISOString();

    return null;
}

// --- Currency Conversion ---
let _exchangeRates = {};
let _ratesLastFetch = 0;
const RATES_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getExchangeRates() {
    if (Date.now() - _ratesLastFetch < RATES_CACHE_MS && Object.keys(_exchangeRates).length > 0) {
        return _exchangeRates;
    }
    try {
        const res = await fetchWithTimeout('https://open.er-api.com/v6/latest/USD', 10000, 1);
        if (res.ok) {
            const data = await res.json();
            if (data.rates) {
                _exchangeRates = data.rates;
                _ratesLastFetch = Date.now();
                console.log(`[Rates] Updated ${Object.keys(_exchangeRates).length} exchange rates`);
            }
        }
    } catch (e) {
        console.error('[Rates] Failed to fetch exchange rates:', e.message);
    }
    return _exchangeRates;
}

function convertToUSD(amount, currency) {
    if (!currency || currency === 'USD' || !amount) return amount;
    const rate = _exchangeRates[currency];
    if (!rate) return amount;
    return Math.round((amount / rate) * 100) / 100;
}

// --- Background Sheet Poller ---
let _refreshLock = false;

// Порог индикатора «Показы не меняются» (часов).
// Вся логика индикатора серверная: при отдаче API сервер проставляет каждой
// кампании поле impressionsStale = (сейчас - impressionsSince) > порог.
const IMPRESSIONS_STALE_HOURS = 5;
const IMPRESSIONS_STALE_MS = IMPRESSIONS_STALE_HOURS * 60 * 60 * 1000;

function withImpressionsStale(rawJson) {
    try {
        const obj = JSON.parse(rawJson);
        const root = obj && obj.data ? obj.data : null;
        if (!root) return rawJson;
        const now = Date.now();
        for (const k of Object.keys(root)) {
            const camp = root[k];
            if (!camp || typeof camp !== 'object') continue;
            const since = camp.impressionsSince ? new Date(camp.impressionsSince).getTime() : NaN;
            camp.impressionsStale = !isNaN(since) && (now - since) > IMPRESSIONS_STALE_MS;
        }
        return JSON.stringify(obj);
    } catch (e) {
        return rawJson;
    }
}

// === Today Analytics (live campaigns from both dashboards) =================
const _GEO_CODE_MAP = {
    BE: 'Бельгия', ES: 'Испания', BY: 'Беларусь', DE: 'Германия',
    PL: 'Польша', IT: 'Италия', FR: 'Франция', GR: 'Греция',
    AU: 'Австралия', AT: 'Австрия', NL: 'Нидерланды'
};
const _GEO_COMPOSITES = {
    'гермиспиталфранц': 'Микс DE/ES/IT/FR',
    'гермиспиталфранцбел': 'Микс DE/ES/IT/FR/BY'
};
const _GEO_TYPO_MAP = { 'исапния': 'Испания' };
const _GEO_SERVICE_TOKENS = new Set(['ключ', 'new', 'англ', 'en', 'ads']);

function _extractGeo(customName) {
    const name = (customName || '').trim();
    const cyr = (name.match(/[А-Яа-яЁё]+/g) || []).filter(t => !_GEO_SERVICE_TOKENS.has(t.toLowerCase()));
    if (cyr.length) {
        const last = cyr[cyr.length - 1].toLowerCase();
        if (_GEO_COMPOSITES[last]) return _GEO_COMPOSITES[last];
        if (cyr.length >= 2 && cyr[cyr.length - 2].toLowerCase() === 'южная' && last === 'корея') return 'Южная Корея';
        if (_GEO_TYPO_MAP[last]) return _GEO_TYPO_MAP[last];
        const w = cyr[cyr.length - 1];
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }
    const m1 = name.match(/\b([A-Z]{2})\s*$/);
    if (m1) return _GEO_CODE_MAP[m1[1]] || `${m1[1]} (код)`;
    const m2 = name.match(/^([A-Z]{2})[A-Za-z]/);
    if (m2) return _GEO_CODE_MAP[m2[1]] || `${m2[1]} (по префиксу)`;
    return '— не определено —';
}

function _fmtInt(n) { return Number(n || 0).toLocaleString('ru-RU').replace(/\u00a0|,/g, ' '); }
function _fmtMoney(n) { return Number(n || 0).toFixed(2); }
function _padRight(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function _padLeft(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

async function buildTodayAnalytics(options = {}) {
    const mode = options.mode === 'yesterday' ? 'yesterday' : 'today';
    const files = mode === 'yesterday'
        ? [TRAFFIC_DATA_SNAPSHOT_FILE, TRAFFIC_ADMIN_DATA_SNAPSHOT_FILE]
        : [TRAFFIC_DATA_FILE, TRAFFIC_ADMIN_DATA_FILE];
    const sources = [];
    let snapshotAt = null;
    for (const f of files) {
        if (!existsSync(f)) continue;
        try {
            const raw = await readFile(f, 'utf-8');
            const obj = JSON.parse(raw);
            sources.push(obj.data || {});
            if (mode === 'yesterday' && obj.snapshotAt && !snapshotAt) snapshotAt = obj.snapshotAt;
        } catch (e) {
            console.warn('[Analytics] Failed to read', f, e.message);
        }
    }

    const live = [];
    for (const blob of sources) {
        for (const v of Object.values(blob)) {
            if ((v.customStatus || '').toLowerCase() !== 'live') continue;
            const todayImpr = ((v.stats || {}).today || {}).impressions || 0;
            if (todayImpr <= 0) continue;
            live.push(v);
        }
    }

    const byGeo = new Map();
    for (const v of live) {
        const geo = _extractGeo(v.customName || v.name || '');
        const t = (v.stats || {}).today || {};
        if (!byGeo.has(geo)) byGeo.set(geo, { campaigns: new Set(), impressions: 0, clicks: 0, cost: 0 });
        const a = byGeo.get(geo);
        a.campaigns.add(v.customName);
        a.impressions += parseInt(t.impressions, 10) || 0;
        a.clicks += parseInt(t.clicks, 10) || 0;
        a.cost += parseFloat(t.cost) || 0;
    }

    const queryAgg = new Map();
    const geoQueryAgg = new Map();
    for (const v of live) {
        const geo = _extractGeo(v.customName || v.name || '');
        if (!geoQueryAgg.has(geo)) geoQueryAgg.set(geo, new Map());
        const gMap = geoQueryAgg.get(geo);
        for (const q of (v.queries || [])) {
            const text = (q.text || '').trim();
            if (!text) continue;
            if (!queryAgg.has(text)) queryAgg.set(text, { impressions: 0, clicks: 0, cost: 0, campaigns: new Set() });
            const qa = queryAgg.get(text);
            qa.impressions += parseInt(q.impressions, 10) || 0;
            qa.clicks += parseInt(q.clicks, 10) || 0;
            qa.cost += parseFloat(q.cost) || 0;
            qa.campaigns.add(v.customName);
            if (!gMap.has(text)) gMap.set(text, { impressions: 0, clicks: 0, cost: 0, campaigns: new Set() });
            const gqa = gMap.get(text);
            gqa.impressions += parseInt(q.impressions, 10) || 0;
            gqa.clicks += parseInt(q.clicks, 10) || 0;
            gqa.cost += parseFloat(q.cost) || 0;
            gqa.campaigns.add(v.customName);
        }
    }

    const totalImpr = [...byGeo.values()].reduce((s, x) => s + x.impressions, 0);
    const totalClicks = [...byGeo.values()].reduce((s, x) => s + x.clicks, 0);
    const totalCost = [...byGeo.values()].reduce((s, x) => s + x.cost, 0);

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const lines = [];
    if (mode === 'yesterday') {
        const snapStr = snapshotAt ? new Date(snapshotAt).toLocaleString('ru-RU') : '—';
        lines.push(`АНАЛИТИКА ЗА ВЧЕРА — сформировано ${stamp} (снапшот: ${snapStr})`);
        lines.push('Источник: live-кампании из снапшотов Traffic Stats + Traffic Admin (today.impressions > 0)');
    } else {
        lines.push(`АНАЛИТИКА ЗА СЕГОДНЯ — ${stamp}`);
        lines.push('Источник: live-кампании из Traffic Stats + Traffic Admin (today.impressions > 0)');
    }
    lines.push('='.repeat(72));
    lines.push('');

    lines.push('1. ОБЩАЯ СВОДКА');
    lines.push('-'.repeat(72));
    lines.push(`  Всего кампаний крутилось сегодня: ${live.length}`);
    lines.push(`  Общие показы:  ${_fmtInt(totalImpr)}`);
    lines.push(`  Общие клики:   ${_fmtInt(totalClicks)}`);
    lines.push(`  Общий спенд:   $${_fmtMoney(totalCost)}`);
    lines.push(`  Всего поисковых запросов (уникальных): ${queryAgg.size}`);
    lines.push('');

    lines.push('2. РАЗБИВКА ПО ГЕО');
    lines.push('-'.repeat(72));
    lines.push(`  ${_padRight('Гео', 32)} ${_padLeft('Камп.', 6)} ${_padLeft('Показы', 10)} ${_padLeft('Клики', 8)} ${_padLeft('Спенд $', 10)}`);
    const geoSorted = [...byGeo.entries()].sort((a, b) => b[1].impressions - a[1].impressions);
    for (const [geo, agg] of geoSorted) {
        lines.push(`  ${_padRight(geo, 32)} ${_padLeft(agg.campaigns.size, 6)} ${_padLeft(_fmtInt(agg.impressions), 10)} ${_padLeft(_fmtInt(agg.clicks), 8)} ${_padLeft(_fmtMoney(agg.cost), 10)}`);
    }
    lines.push('');

    lines.push('3. ТОП-20 ПОИСКОВЫХ ЗАПРОСОВ ЗА СЕГОДНЯ (по показам)');
    lines.push('-'.repeat(72));
    lines.push(`  ${_padLeft('#', 3)} ${_padLeft('Показы', 8)} ${_padLeft('Клики', 7)} ${_padLeft('Спенд $', 9)}  ${_padLeft('Камп.', 5)}  Запрос`);
    const top20 = [...queryAgg.entries()].sort((a, b) => b[1].impressions - a[1].impressions).slice(0, 20);
    let idx = 0;
    for (const [text, qa] of top20) {
        idx += 1;
        const t = text.length <= 60 ? text : text.slice(0, 57) + '...';
        lines.push(`  ${_padLeft(idx, 3)} ${_padLeft(_fmtInt(qa.impressions), 8)} ${_padLeft(_fmtInt(qa.clicks), 7)} ${_padLeft(_fmtMoney(qa.cost), 9)}  ${_padLeft(qa.campaigns.size, 5)}  ${t}`);
    }
    lines.push('');

    lines.push('4. ТОП-5 ЗАПРОСОВ ПО ГЕО');
    lines.push('-'.repeat(72));
    for (const [geo, agg] of geoSorted) {
        const gMap = geoQueryAgg.get(geo);
        if (!gMap || gMap.size === 0) continue;
        lines.push('');
        lines.push(`  ▸ ${geo}  (кампаний: ${agg.campaigns.size}, показы: ${_fmtInt(agg.impressions)}, клики: ${_fmtInt(agg.clicks)}, спенд: $${_fmtMoney(agg.cost)})`);
        const top5 = [...gMap.entries()].sort((a, b) => b[1].impressions - a[1].impressions).slice(0, 5);
        let i = 0;
        for (const [text, qa] of top5) {
            i += 1;
            const t = text.length <= 60 ? text : text.slice(0, 57) + '...';
            lines.push(`      ${i}. ${_padLeft(_fmtInt(qa.impressions), 5)} показ. / ${_padLeft(_fmtInt(qa.clicks), 4)} кл. / $${_padLeft(_fmtMoney(qa.cost), 7)} (${qa.campaigns.size} камп.)  «${t}»`);
        }
    }
    lines.push('');
    lines.push(`(Всего уникальных поисковых запросов сегодня: ${queryAgg.size})`);

    return lines.join('\n') + '\n';
}

async function refreshTrafficData(options = {}) {
    const { onlyCampaignName = null } = options;
    if (onlyCampaignName) {
        const waitStart = Date.now();
        while (_refreshLock && (Date.now() - waitStart) < 5 * 60 * 1000) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    if (_refreshLock) {
        console.log('[Worker] Refresh already in progress, skipping.');
        return;
    }
    _refreshLock = true;
    console.log(`[Worker] Starting background refresh of Traffic Data${onlyCampaignName ? ` (single: ${onlyCampaignName})` : ''} from Google Sheets...`);
    try {
        let configs = [];
        if (existsSync(TRAFFIC_FILE)) {
            configs = JSON.parse(await readFile(TRAFFIC_FILE, 'utf-8'));
        }

        let targetConfigs = configs;
        let allCampaignsMap = {};
        let previousMap = {};
        // Загружаем предыдущий кэш, чтобы сохранять impressionsSince между обновлениями
        if (existsSync(TRAFFIC_DATA_FILE)) {
            try {
                const cachedRaw = await readFile(TRAFFIC_DATA_FILE, 'utf-8');
                const cached = JSON.parse(cachedRaw);
                previousMap = cached.data || {};
            } catch (e) { /* ignore broken cache */ }
        }
        // Всегда стартуем с предыдущего кэша. Это защищает от потери записей
        // при transient-сбоях Google Sheets (timeout / rate-limit / пустой ответ):
        // старые записи каждого customName удаляются ТОЛЬКО перед записью новых
        // (внутри цикла, и только при успешном fetch).
        allCampaignsMap = { ...previousMap };
        if (onlyCampaignName) {
            targetConfigs = configs.filter(c => c.name === onlyCampaignName);
            if (!targetConfigs.length) {
                console.warn(`[Worker] Single refresh requested for unknown campaign: ${onlyCampaignName}`);
                return;
            }
        }

        const rates = await getExchangeRates();

        for (const config of targetConfigs) {
            if (config.customStatus === 'ban') {
                continue;
            }
            try {
                const { url, name: customName } = config;
                if (!url) continue;

                const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
                if (!match) continue;
                const sheetId = match[1];
                const campaigns = {};

                // 0. Fetch Info sheet to get currency + updated_at
                let sheetCurrency = 'USD';
                let infoUpdatedAt = null;
                try {
                    const infoUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=Info`;
                    const infoRes = await fetchWithTimeout(infoUrl, 10000, 0);
                    if (infoRes.ok) {
                        const infoText = await infoRes.text();
                        if (!infoText.startsWith('<html')) {
                            const infoData = parseCSV(infoText);
                            const hdr = infoData[0] || [];
                            const currIdx = hdr.findIndex(h => h.toLowerCase() === 'currency');
                            if (currIdx !== -1 && infoData.length > 1 && infoData[1][currIdx]) {
                                sheetCurrency = infoData[1][currIdx].trim().toUpperCase();
                            }
                            const updIdx = hdr.findIndex(h => h.toLowerCase() === 'updated_at');
                            if (updIdx !== -1 && infoData.length > 1 && infoData[1][updIdx]) {
                                infoUpdatedAt = parseSheetDate(infoData[1][updIdx]);
                            }
                        }
                    }
                } catch (e) { /* No Info sheet — assume USD */ }

                // 1. Fetch Campaign Stats sheet
                const statsUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Статистика_Кампаний')}`;
                const statsRes = await fetchWithTimeout(statsUrl);
                if (statsRes.ok) {
                    const statsText = await statsRes.text();
                    if (!statsText.startsWith('<html')) {
                        const statsData = parseCSV(statsText);
                        for (let i = 1; i < statsData.length; i++) {
                            const row = statsData[i];
                            if (row.length < 6) continue;
                            const campName = row[0], statusStr = row[1], period = row[2], impStr = row[3], clicksStr = row[4], costStr = row[5];
                            if (!campName || campName === 'Кампания') continue;

                            if (!campaigns[campName]) {
                                campaigns[campName] = {
                                    name: campName,
                                    customName: customName || campName,
                                    url: url,
                                    status: statusStr === 'ENABLED' ? 'ACTIVE' : statusStr === 'PAUSED' ? 'PAUSED' : statusStr === 'REMOVED' ? 'REMOVED' : 'LIMITED',
                                    stats: { today: { impressions: 0, clicks: 0, cost: 0 }, allTime: { impressions: 0, clicks: 0, cost: 0 } },
                                    queries: []
                                };
                            }
                            if (period === 'Сегодня') {
                                campaigns[campName].stats.today.impressions += parseInt(impStr, 10) || 0;
                                campaigns[campName].stats.today.clicks += parseInt(clicksStr, 10) || 0;
                                campaigns[campName].stats.today.cost += parseFloat(costStr.replace(',', '.')) || 0;
                            } else if (period === 'Все время') {
                                campaigns[campName].stats.allTime.impressions += parseInt(impStr, 10) || 0;
                                campaigns[campName].stats.allTime.clicks += parseInt(clicksStr, 10) || 0;
                                campaigns[campName].stats.allTime.cost += parseFloat(costStr.replace(',', '.')) || 0;
                            }
                        }
                    }
                }

                // 2. Fetch Search Terms sheet
                const termsUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Поисковые_запросы_Сегодня')}`;
                const termsRes = await fetchWithTimeout(termsUrl);
                if (termsRes.ok) {
                    const termsText = await termsRes.text();
                    if (!termsText.startsWith('<html')) {
                        const termsData = parseCSV(termsText);
                        for (let i = 1; i < termsData.length; i++) {
                            const row = termsData[i];
                            if (row.length < 6) continue;
                            const term = row[0], campName = row[1], adGroup = row[2], impStr = row[3], clicksStr = row[4], costStr = row[5];
                            if (!campName || !term || term === 'Поисковый запрос') continue;

                            if (!campaigns[campName]) {
                                campaigns[campName] = {
                                    name: campName,
                                    stats: { today: { impressions: 0, clicks: 0, cost: 0 }, allTime: { impressions: 0, clicks: 0, cost: 0 } },
                                    queries: []
                                };
                            }

                            campaigns[campName].queries.push({
                                id: Math.random().toString(36).substr(2, 9),
                                text: term,
                                impressions: parseInt(impStr, 10) || 0,
                                clicks: parseInt(clicksStr, 10) || 0,
                                cost: parseFloat(costStr.replace(',', '.')) || 0,
                                adGroup
                            });
                        }
                    }
                }

                // 3. Fetch Keywords sheet (optional — only exists in new script)
                try {
                    const kwUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Рабочие_Ключи')}`;
                    const kwRes = await fetchWithTimeout(kwUrl);
                    if (kwRes.ok) {
                        const kwText = await kwRes.text();
                        if (!kwText.startsWith('<html')) {
                            const kwData = parseCSV(kwText);
                            for (let i = 1; i < kwData.length; i++) {
                                const row = kwData[i];
                                if (row.length < 7) continue;
                                const keyword = row[0], kwStatus = row[1], campName = row[2], adGroup = row[3], impStr = row[4], clicksStr = row[5], costStr = row[6];
                                if (!campName || !keyword || keyword === 'Ключевое слово') continue;
                                if (!campaigns[campName]) {
                                    campaigns[campName] = { name: campName, stats: { today: { impressions: 0, clicks: 0, cost: 0 }, allTime: { impressions: 0, clicks: 0, cost: 0 } }, queries: [], keywords: [], adTexts: [] };
                                }
                                if (!campaigns[campName].keywords) campaigns[campName].keywords = [];
                                campaigns[campName].keywords.push({
                                    id: Math.random().toString(36).substr(2, 9),
                                    text: keyword, status: kwStatus, adGroup,
                                    impressions: parseInt(impStr, 10) || 0,
                                    clicks: parseInt(clicksStr, 10) || 0,
                                    cost: parseFloat(costStr.replace(',', '.')) || 0
                                });
                            }
                        }
                    }
                } catch (e) { /* Sheet doesn't exist in old scripts — safe to ignore */ }

                // 4. Fetch Ad Texts sheet (optional — only exists in new script)
                try {
                    const adUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Тексты_Объявлений')}`;
                    const adRes = await fetchWithTimeout(adUrl);
                    if (adRes.ok) {
                        const adText = await adRes.text();
                        if (!adText.startsWith('<html')) {
                            const adData = parseCSV(adText);
                            for (let i = 1; i < adData.length; i++) {
                                const row = adData[i];
                                if (row.length < 8) continue;
                                const campName = row[0], adGroup = row[1], adType = row[2], headlines = row[3], descriptions = row[4], impStr = row[5], clicksStr = row[6], costStr = row[7];
                                if (!campName || campName === 'Кампания') continue;
                                if (!campaigns[campName]) {
                                    campaigns[campName] = { name: campName, stats: { today: { impressions: 0, clicks: 0, cost: 0 }, allTime: { impressions: 0, clicks: 0, cost: 0 } }, queries: [], keywords: [], adTexts: [] };
                                }
                                if (!campaigns[campName].adTexts) campaigns[campName].adTexts = [];
                                campaigns[campName].adTexts.push({
                                    id: Math.random().toString(36).substr(2, 9),
                                    adGroup, type: adType, headlines, descriptions,
                                    impressions: parseInt(impStr, 10) || 0,
                                    clicks: parseInt(clicksStr, 10) || 0,
                                    cost: parseFloat(costStr.replace(',', '.')) || 0
                                });
                            }
                        }
                    }
                } catch (e) { /* Sheet doesn't exist in old scripts — safe to ignore */ }

                // 5. Fetch Metadata sheet
                let sheetLastUpdated = null;
                try {
                    const metaUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Метаданные')}`;
                    const metaRes = await fetchWithTimeout(metaUrl);
                    if (metaRes.ok) {
                        const metaText = await metaRes.text();
                        if (!metaText.startsWith('<html')) {
                            const metaData = parseCSV(metaText);
                            let rawDate = null;
                            // Support horizontal (new) structure
                            const headerIdx = metaData[0] ? metaData[0].findIndex(h => h === 'updated_at' || h === 'Последнее обновление') : -1;
                            if (headerIdx !== -1 && metaData.length > 1) {
                                rawDate = metaData[1][headerIdx];
                            } else {
                                // Support vertical (old) structure
                                for (let i = 1; i < metaData.length; i++) {
                                    if (metaData[i][0] === 'Последнее обновление' && metaData[i][1]) {
                                        rawDate = metaData[i][1];
                                    }
                                }
                            }
                            sheetLastUpdated = parseSheetDate(rawDate);
                        }
                    }
                } catch (e) {
                    // Ignore missing metadata
                }

                const readAt = new Date().toISOString();
                // Старые записи этого customName удаляем ТОЛЬКО если fetch вернул
                // хоть какие-то кампании. При пустом ответе (Google rate-limit / timeout)
                // прежние данные сохранятся, и кампания не «исчезнет» из UI.
                if (Object.keys(campaigns).length > 0) {
                    for (const key of Object.keys(allCampaignsMap)) {
                        if (allCampaignsMap[key] && allCampaignsMap[key].customName === config.name) {
                            delete allCampaignsMap[key];
                        }
                    }
                }
                for (const [campName, camp] of Object.entries(campaigns)) {
                    // Fallback: if today stats are zero but queries exist, compute from queries
                    if (camp.stats.today.impressions === 0 && camp.stats.today.clicks === 0 && camp.queries && camp.queries.length > 0) {
                        let qImp = 0, qClk = 0, qCost = 0;
                        for (const q of camp.queries) { qImp += q.impressions; qClk += q.clicks; qCost += q.cost; }
                        if (qImp > 0) {
                            camp.stats.today.impressions = qImp;
                            camp.stats.today.clicks = qClk;
                            camp.stats.today.cost = qCost;
                        }
                    }
                    if (sheetCurrency !== 'USD' && _exchangeRates[sheetCurrency]) {
                        camp.stats.today.cost = convertToUSD(camp.stats.today.cost, sheetCurrency);
                        camp.stats.allTime.cost = convertToUSD(camp.stats.allTime.cost, sheetCurrency);
                        if (camp.queries) camp.queries.forEach(q => { q.cost = convertToUSD(q.cost, sheetCurrency); });
                        if (camp.keywords) camp.keywords.forEach(k => { k.cost = convertToUSD(k.cost, sheetCurrency); });
                        if (camp.adTexts) camp.adTexts.forEach(a => { a.cost = convertToUSD(a.cost, sheetCurrency); });
                        camp.currency = sheetCurrency;
                    }
                    camp.sheetLastUpdated = sheetLastUpdated || infoUpdatedAt;
                    camp.lastReadAt = readAt;
                    camp.url = config.url;
                    camp.customName = config.name;
                    camp.comment = config.comment || '';
                    camp.customStatus = config.customStatus || 'warmup';
                    camp.siteUrl = config.siteUrl || '';
                    camp.addedAt = config.addedAt || '';
                    camp.costAlert = config.costAlert || 0;
                    camp.campTask = config.campTask || '';
                    camp.campTimer = config.campTimer || 0;
                    camp.primaryKeyword = config.primaryKeyword || '';
                    const globalKey = `${config.name}_${campName}`;
                    // Счётчик «показы не меняются»: если impressions за сегодня те же,
                    // что и в предыдущем кэше — сохраняем старый impressionsSince,
                    // иначе ставим текущее время.
                    const prev = previousMap[globalKey];
                    const prevImp = prev && prev.stats && prev.stats.today ? prev.stats.today.impressions : undefined;
                    if (prev && prev.impressionsSince && prevImp === camp.stats.today.impressions) {
                        camp.impressionsSince = prev.impressionsSince;
                    } else {
                        camp.impressionsSince = readAt;
                    }
                    allCampaignsMap[globalKey] = camp;
                }
                
            } catch (urlErr) {
                console.error(`[Worker] Error fetching Google Sheet ${config.url}:`, urlErr.message);
            }
        }

        // Глобальный refresh: убираем «осиротевшие» записи (configов с такими customName уже нет).
        // Для single-refresh не делаем — он не должен трогать чужие записи.
        if (!onlyCampaignName) {
            const configNamesSet = new Set(configs.map(c => c.name));
            for (const key of Object.keys(allCampaignsMap)) {
                const cn = allCampaignsMap[key] && allCampaignsMap[key].customName;
                if (!cn || !configNamesSet.has(cn)) {
                    delete allCampaignsMap[key];
                }
            }
        }

        // Atomic write to cache file
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = TRAFFIC_DATA_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify({ success: true, data: allCampaignsMap }), 'utf-8');
        await rename(tmpFile, TRAFFIC_DATA_FILE);
        timestamps.traffic_data = Date.now();
        console.log(`[Worker] Traffic Data refreshed successfully. ${Object.keys(allCampaignsMap).length} campaigns cached.`);
        if (!onlyCampaignName) {
            await checkCostAlerts(configs, allCampaignsMap, 'stats').catch(e => console.error('[Worker] Alert check failed:', e.message));
            await checkKeywordAlerts(configs, allCampaignsMap, 'stats').catch(e => console.error('[Worker] Keyword alert check failed:', e.message));
        }
    } catch (e) {
        console.error('[Worker] Fatal error refreshing Traffic Data:', e);
    } finally {
        _refreshLock = false;
    }
}

// --- Background Sheet Poller for Admin ---
let _refreshAdminLock = false;

async function refreshTrafficAdminData(options = {}) {
    const { onlyCampaignName = null } = options;
    if (onlyCampaignName) {
        const waitStart = Date.now();
        while (_refreshAdminLock && (Date.now() - waitStart) < 5 * 60 * 1000) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    if (_refreshAdminLock) {
        console.log('[Worker-Admin] Refresh already in progress, skipping.');
        return;
    }
    _refreshAdminLock = true;
    console.log(`[Worker-Admin] Starting background refresh of Admin Traffic Data${onlyCampaignName ? ` (single: ${onlyCampaignName})` : ''} from Google Sheets...`);
    try {
        let configs = [];
        if (existsSync(TRAFFIC_ADMIN_FILE)) {
            configs = JSON.parse(await readFile(TRAFFIC_ADMIN_FILE, 'utf-8'));
        }

        let targetConfigs = configs;
        let allCampaignsMap = {};
        let previousMap = {};
        if (existsSync(TRAFFIC_ADMIN_DATA_FILE)) {
            try {
                const cachedRaw = await readFile(TRAFFIC_ADMIN_DATA_FILE, 'utf-8');
                const cached = JSON.parse(cachedRaw);
                previousMap = cached.data || {};
            } catch (e) { /* ignore */ }
        }
        // Всегда стартуем с предыдущего кэша. Это защищает от потери записей
        // при transient-сбоях Google Sheets (timeout / rate-limit / пустой ответ):
        // старые записи каждого customName удаляются ТОЛЬКО перед записью новых
        // (внутри цикла, и только при успешном fetch).
        allCampaignsMap = { ...previousMap };
        if (onlyCampaignName) {
            targetConfigs = configs.filter(c => c.name === onlyCampaignName);
            if (!targetConfigs.length) {
                console.warn(`[Worker-Admin] Single refresh requested for unknown campaign: ${onlyCampaignName}`);
                return;
            }
        }

        const rates = await getExchangeRates();
        for (const config of targetConfigs) {
            if (config.customStatus === 'ban') {
                continue;
            }
            try {
                const { url, name: customName } = config;
                if (!url) continue;
                const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
                if (!match) continue;
                const sheetId = match[1];
                const campaigns = {};

                // 0. Fetch Info sheet to get currency + updated_at
                let sheetCurrency = 'USD';
                let infoUpdatedAt = null;
                try {
                    const infoUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=Info`;
                    const infoRes = await fetchWithTimeout(infoUrl, 10000, 0);
                    if (infoRes.ok) {
                        const infoText = await infoRes.text();
                        if (!infoText.startsWith('<html')) {
                            const infoData = parseCSV(infoText);
                            const hdr = infoData[0] || [];
                            const currIdx = hdr.findIndex(h => h.toLowerCase() === 'currency');
                            if (currIdx !== -1 && infoData.length > 1 && infoData[1][currIdx]) {
                                sheetCurrency = infoData[1][currIdx].trim().toUpperCase();
                            }
                            const updIdx = hdr.findIndex(h => h.toLowerCase() === 'updated_at');
                            if (updIdx !== -1 && infoData.length > 1 && infoData[1][updIdx]) {
                                infoUpdatedAt = parseSheetDate(infoData[1][updIdx]);
                            }
                        }
                    }
                } catch (e) { /* No Info sheet — assume USD */ }

                const statsUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Статистика_Кампаний')}`;
                const statsRes = await fetchWithTimeout(statsUrl);
                if (statsRes.ok) {
                    const statsText = await statsRes.text();
                    if (!statsText.startsWith('<html')) {
                        const statsData = parseCSV(statsText);
                        for (let i = 1; i < statsData.length; i++) {
                            const row = statsData[i];
                            if (row.length < 6) continue;
                            const campName = row[0], statusStr = row[1], period = row[2], impStr = row[3], clicksStr = row[4], costStr = row[5];
                            if (!campName || campName === 'Кампания') continue;
                            if (!campaigns[campName]) {
                                campaigns[campName] = {
                                    name: campName, customName: customName || campName, url: url,
                                    status: statusStr === 'ENABLED' ? 'ACTIVE' : statusStr === 'PAUSED' ? 'PAUSED' : statusStr === 'REMOVED' ? 'REMOVED' : 'LIMITED',
                                    stats: { today: { impressions: 0, clicks: 0, cost: 0 }, allTime: { impressions: 0, clicks: 0, cost: 0 } },
                                    queries: []
                                };
                            }
                            if (period === 'Сегодня') {
                                campaigns[campName].stats.today.impressions += parseInt(impStr, 10) || 0;
                                campaigns[campName].stats.today.clicks += parseInt(clicksStr, 10) || 0;
                                campaigns[campName].stats.today.cost += parseFloat(costStr.replace(',', '.')) || 0;
                            } else if (period === 'Все время') {
                                campaigns[campName].stats.allTime.impressions += parseInt(impStr, 10) || 0;
                                campaigns[campName].stats.allTime.clicks += parseInt(clicksStr, 10) || 0;
                                campaigns[campName].stats.allTime.cost += parseFloat(costStr.replace(',', '.')) || 0;
                            }
                        }
                    }
                }

                const termsUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Поисковые_запросы_Сегодня')}`;
                const termsRes = await fetchWithTimeout(termsUrl);
                if (termsRes.ok) {
                    const termsText = await termsRes.text();
                    if (!termsText.startsWith('<html')) {
                        const termsData = parseCSV(termsText);
                        for (let i = 1; i < termsData.length; i++) {
                            const row = termsData[i];
                            if (row.length < 6) continue;
                            const term = row[0], campName = row[1], adGroup = row[2], impStr = row[3], clicksStr = row[4], costStr = row[5];
                            if (!campName || !term || term === 'Поисковый запрос') continue;
                            if (!campaigns[campName]) {
                                campaigns[campName] = { name: campName, stats: { today: { impressions: 0, clicks: 0, cost: 0 }, allTime: { impressions: 0, clicks: 0, cost: 0 } }, queries: [] };
                            }
                            campaigns[campName].queries.push({ id: Math.random().toString(36).substr(2, 9), text: term, impressions: parseInt(impStr, 10) || 0, clicks: parseInt(clicksStr, 10) || 0, cost: parseFloat(costStr.replace(',', '.')) || 0, adGroup });
                        }
                    }
                }

                try {
                    const kwUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Рабочие_Ключи')}`;
                    const kwRes = await fetchWithTimeout(kwUrl);
                    if (kwRes.ok) {
                        const kwText = await kwRes.text();
                        if (!kwText.startsWith('<html')) {
                            const kwData = parseCSV(kwText);
                            for (let i = 1; i < kwData.length; i++) {
                                const row = kwData[i];
                                if (row.length < 7) continue;
                                const keyword = row[0], kwStatus = row[1], campName = row[2], adGroup = row[3], impStr = row[4], clicksStr = row[5], costStr = row[6];
                                if (!campName || !keyword || keyword === 'Ключевое слово') continue;
                                if (!campaigns[campName]) { campaigns[campName] = { name: campName, stats: { today: { impressions: 0, clicks: 0, cost: 0 }, allTime: { impressions: 0, clicks: 0, cost: 0 } }, queries: [], keywords: [], adTexts: [] }; }
                                if (!campaigns[campName].keywords) campaigns[campName].keywords = [];
                                campaigns[campName].keywords.push({ id: Math.random().toString(36).substr(2, 9), text: keyword, status: kwStatus, adGroup, impressions: parseInt(impStr, 10) || 0, clicks: parseInt(clicksStr, 10) || 0, cost: parseFloat(costStr.replace(',', '.')) || 0 });
                            }
                        }
                    }
                } catch (e) { }

                try {
                    const adUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Тексты_Объявлений')}`;
                    const adRes = await fetchWithTimeout(adUrl);
                    if (adRes.ok) {
                        const adText = await adRes.text();
                        if (!adText.startsWith('<html')) {
                            const adData = parseCSV(adText);
                            for (let i = 1; i < adData.length; i++) {
                                const row = adData[i];
                                if (row.length < 8) continue;
                                const campName = row[0], adGroup = row[1], adType = row[2], headlines = row[3], descriptions = row[4], impStr = row[5], clicksStr = row[6], costStr = row[7];
                                if (!campName || campName === 'Кампания') continue;
                                if (!campaigns[campName]) { campaigns[campName] = { name: campName, stats: { today: { impressions: 0, clicks: 0, cost: 0 }, allTime: { impressions: 0, clicks: 0, cost: 0 } }, queries: [], keywords: [], adTexts: [] }; }
                                if (!campaigns[campName].adTexts) campaigns[campName].adTexts = [];
                                campaigns[campName].adTexts.push({ id: Math.random().toString(36).substr(2, 9), adGroup, type: adType, headlines, descriptions, impressions: parseInt(impStr, 10) || 0, clicks: parseInt(clicksStr, 10) || 0, cost: parseFloat(costStr.replace(',', '.')) || 0 });
                            }
                        }
                    }
                } catch (e) { }

                let sheetLastUpdated = null;
                try {
                    const metaUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Метаданные')}`;
                    const metaRes = await fetchWithTimeout(metaUrl);
                    if (metaRes.ok) {
                        const metaText = await metaRes.text();
                        if (!metaText.startsWith('<html')) {
                            const metaData = parseCSV(metaText);
                            let rawDate = null;
                            const headerIdx = metaData[0] ? metaData[0].findIndex(h => h === 'updated_at' || h === 'Последнее обновление') : -1;
                            if (headerIdx !== -1 && metaData.length > 1) { rawDate = metaData[1][headerIdx]; }
                            else { for (let i = 1; i < metaData.length; i++) { if (metaData[i][0] === 'Последнее обновление' && metaData[i][1]) rawDate = metaData[i][1]; } }
                            sheetLastUpdated = parseSheetDate(rawDate);
                        }
                    }
                } catch (e) { }

                const readAt = new Date().toISOString();
                // Старые записи этого customName удаляем ТОЛЬКО если fetch вернул
                // хоть какие-то кампании. При пустом ответе (Google rate-limit / timeout)
                // прежние данные сохранятся, и кампания не «исчезнет» из UI.
                if (Object.keys(campaigns).length > 0) {
                    for (const key of Object.keys(allCampaignsMap)) {
                        if (allCampaignsMap[key] && allCampaignsMap[key].customName === config.name) {
                            delete allCampaignsMap[key];
                        }
                    }
                }
                for (const [campName, camp] of Object.entries(campaigns)) {
                    if (camp.stats.today.impressions === 0 && camp.stats.today.clicks === 0 && camp.queries && camp.queries.length > 0) {
                        let qImp = 0, qClk = 0, qCost = 0;
                        for (const q of camp.queries) { qImp += q.impressions; qClk += q.clicks; qCost += q.cost; }
                        if (qImp > 0) {
                            camp.stats.today.impressions = qImp;
                            camp.stats.today.clicks = qClk;
                            camp.stats.today.cost = qCost;
                        }
                    }
                    if (sheetCurrency !== 'USD' && _exchangeRates[sheetCurrency]) {
                        camp.stats.today.cost = convertToUSD(camp.stats.today.cost, sheetCurrency);
                        camp.stats.allTime.cost = convertToUSD(camp.stats.allTime.cost, sheetCurrency);
                        if (camp.queries) camp.queries.forEach(q => { q.cost = convertToUSD(q.cost, sheetCurrency); });
                        if (camp.keywords) camp.keywords.forEach(k => { k.cost = convertToUSD(k.cost, sheetCurrency); });
                        if (camp.adTexts) camp.adTexts.forEach(a => { a.cost = convertToUSD(a.cost, sheetCurrency); });
                        camp.currency = sheetCurrency;
                    }
                    camp.sheetLastUpdated = sheetLastUpdated || infoUpdatedAt;
                    camp.lastReadAt = readAt;
                    camp.url = config.url;
                    camp.customName = config.name;
                    camp.comment = config.comment || '';
                    camp.customStatus = config.customStatus || 'warmup';
                    camp.siteUrl = config.siteUrl || '';
                    camp.addedAt = config.addedAt || '';
                    camp.costAlert = config.costAlert || 0;
                    camp.campTask = config.campTask || '';
                    camp.campTimer = config.campTimer || 0;
                    camp.primaryKeyword = config.primaryKeyword || '';
                    const globalKey = `${config.name}_${campName}`;
                    const prev = previousMap[globalKey];
                    const prevImp = prev && prev.stats && prev.stats.today ? prev.stats.today.impressions : undefined;
                    if (prev && prev.impressionsSince && prevImp === camp.stats.today.impressions) {
                        camp.impressionsSince = prev.impressionsSince;
                    } else {
                        camp.impressionsSince = readAt;
                    }
                    allCampaignsMap[globalKey] = camp;
                }
            } catch (urlErr) {
                console.error(`[Worker-Admin] Error fetching Google Sheet ${config.url}:`, urlErr.message);
            }
        }

        // Глобальный refresh: убираем «осиротевшие» записи (configов с такими customName уже нет).
        if (!onlyCampaignName) {
            const configNamesSet = new Set(configs.map(c => c.name));
            for (const key of Object.keys(allCampaignsMap)) {
                const cn = allCampaignsMap[key] && allCampaignsMap[key].customName;
                if (!cn || !configNamesSet.has(cn)) {
                    delete allCampaignsMap[key];
                }
            }
        }

        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = TRAFFIC_ADMIN_DATA_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify({ success: true, data: allCampaignsMap }), 'utf-8');
        await rename(tmpFile, TRAFFIC_ADMIN_DATA_FILE);
        timestamps.traffic_admin_data = Date.now();
        console.log(`[Worker-Admin] Traffic Admin Data refreshed successfully. ${Object.keys(allCampaignsMap).length} campaigns cached.`);
        if (!onlyCampaignName) {
            await checkCostAlerts(configs, allCampaignsMap, 'admin').catch(e => console.error('[Worker-Admin] Alert check failed:', e.message));
            await checkKeywordAlerts(configs, allCampaignsMap, 'admin').catch(e => console.error('[Worker-Admin] Keyword alert check failed:', e.message));
        }
    } catch (e) {
        console.error('[Worker-Admin] Fatal error refreshing Traffic Admin Data:', e);
    } finally {
        _refreshAdminLock = false;
    }
}

// --- Daily Snapshot (saves "yesterday" data at 21:50 user time, UTC+1) ---
const SNAPSHOT_HOUR = 21;
const SNAPSHOT_MINUTE = 50;
const SNAPSHOT_TZ_OFFSET = 1;
let _lastSnapshotDate = '';

async function saveDataSnapshot() {
    const ts = new Date().toISOString();
    try {
        for (const [src, dst] of [[TRAFFIC_DATA_FILE, TRAFFIC_DATA_SNAPSHOT_FILE], [TRAFFIC_ADMIN_DATA_FILE, TRAFFIC_ADMIN_DATA_SNAPSHOT_FILE]]) {
            if (!existsSync(src)) continue;
            const raw = await readFile(src, 'utf-8');
            const parsed = JSON.parse(raw);
            parsed.snapshotAt = ts;
            const tmpId = Date.now() + Math.random().toString(36).slice(2);
            const tmpFile = dst + '.' + tmpId + '.tmp';
            await writeFile(tmpFile, JSON.stringify(parsed), 'utf-8');
            await rename(tmpFile, dst);
        }
        console.log(`[Snapshot] Daily snapshot saved at ${ts}`);
    } catch (e) {
        console.error('[Snapshot] Failed to save:', e.message);
    }
}

setInterval(() => {
    const now = new Date();
    const localH = (now.getUTCHours() + SNAPSHOT_TZ_OFFSET) % 24;
    const localM = now.getUTCMinutes();
    const dateStr = now.toISOString().slice(0, 10);
    if (localH === SNAPSHOT_HOUR && localM === SNAPSHOT_MINUTE && _lastSnapshotDate !== dateStr) {
        _lastSnapshotDate = dateStr;
        saveDataSnapshot();
    }
}, 60000);

// --- Daily Analytics Save (21:55 UTC+1, бессрочное хранение) ---
const ANALYTICS_DIR = join(__dirname, 'saved_sessions', 'analytics');
const ANALYTICS_HOUR = 21;
const ANALYTICS_MINUTE = 55;
let _lastAnalyticsDate = '';

async function saveDailyAnalytics() {
    try {
        if (!existsSync(ANALYTICS_DIR)) {
            await mkdir(ANALYTICS_DIR, { recursive: true });
        }
        // Дата по локальному (UTC+1) дню — чтобы файл соответствовал «дню в Google Ads»
        const now = new Date();
        const localMs = now.getTime() + SNAPSHOT_TZ_OFFSET * 60 * 60 * 1000;
        const localDate = new Date(localMs);
        const yyyy = localDate.getUTCFullYear();
        const mm = String(localDate.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(localDate.getUTCDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;
        const filePath = join(ANALYTICS_DIR, `today_analytics_${dateStr}.txt`);
        if (existsSync(filePath)) {
            console.log(`[Analytics] Daily file already exists, skip: ${filePath}`);
            return;
        }
        const text = await buildTodayAnalytics({ mode: 'today' });
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = filePath + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, text, 'utf-8');
        await rename(tmpFile, filePath);
        console.log(`[Analytics] Daily analytics saved: ${filePath}`);
    } catch (e) {
        console.error('[Analytics] Failed to save daily file:', e.message);
    }
}

setInterval(() => {
    const now = new Date();
    const localH = (now.getUTCHours() + SNAPSHOT_TZ_OFFSET) % 24;
    const localM = now.getUTCMinutes();
    const dateStr = now.toISOString().slice(0, 10);
    if (localH === ANALYTICS_HOUR && localM === ANALYTICS_MINUTE && _lastAnalyticsDate !== dateStr) {
        _lastAnalyticsDate = dateStr;
        saveDailyAnalytics();
    }
}, 60000);

// Sequential refresh: stats first, then admin — avoids overloading Google API
async function refreshAll() {
    await refreshTrafficData();
    await refreshTrafficAdminData();
}

// Однократный ремонт кэша при старте: перепарсить sheetLastUpdated через parseSheetDate.
// Нужен, чтобы уже сохранённые «битые» значения (например '2026-04-23 9:11:00Z')
// стали валидным ISO без ожидания следующего цикла чтения Google Sheets.
async function repairCachedDates(filePath) {
    try {
        if (!existsSync(filePath)) return;
        const raw = await readFile(filePath, 'utf-8');
        const obj = JSON.parse(raw);
        const root = (obj && typeof obj === 'object' && obj.data) ? obj.data : obj;
        let changed = 0, total = 0;
        for (const [, v] of Object.entries(root)) {
            if (!v || typeof v !== 'object' || !('sheetLastUpdated' in v)) continue;
            total++;
            const orig = v.sheetLastUpdated;
            if (!orig) continue;
            // Если уже валидная ISO-строка — ничего не делаем
            const t = Date.parse(orig);
            if (!isNaN(t) && typeof orig === 'string' && orig.includes('T')) continue;
            const fixed = parseSheetDate(orig);
            if (fixed !== orig) {
                v.sheetLastUpdated = fixed;
                changed++;
            }
        }
        if (changed > 0) {
            const tmp = filePath + '.repair.tmp';
            await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
            await rename(tmp, filePath);
            console.log(`[Repair] ${filePath}: fixed ${changed}/${total} sheetLastUpdated entries`);
        }
    } catch (e) {
        console.error('[Repair] Failed for', filePath, e.message);
    }
}
(async () => {
    await repairCachedDates(TRAFFIC_DATA_FILE);
    await repairCachedDates(TRAFFIC_ADMIN_DATA_FILE);
})();

setTimeout(refreshAll, 3000);
setInterval(refreshAll, 60 * 60 * 1000);

// POST manually force refresh all traffic data
app.post('/api/traffic/refresh', async (req, res) => {
    auditLog('REFRESH', 'traffic_data', 'manual', req);
    res.json({ success: true, started: true });
    refreshTrafficData().catch(e => console.error('[Server] Manual refresh failed:', e.message));
});

app.post('/api/traffic/:name/refresh', async (req, res) => {
    try {
        const campaignName = req.params.name;
        auditLog('REFRESH', 'traffic_data', `single:${campaignName}`, req);
        await refreshTrafficData({ onlyCampaignName: campaignName });
        res.json({ success: true });
    } catch (e) {
        console.error('[Server] Single refresh failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET cached traffic data
app.get('/api/traffic-data', async (req, res) => {
    try {
        if (!existsSync(TRAFFIC_DATA_FILE)) {
            return res.json({ success: true, data: {} });
        }
        const raw = await readFile(TRAFFIC_DATA_FILE, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.send(withImpressionsStale(raw));
    } catch (e) {
        console.error('[Server] Error reading traffic-data cache:', e.message);
        res.json({ success: true, data: {} });
    }
});

// --- Snapshot API ---
app.get('/api/traffic-data-snapshot', async (req, res) => {
    try {
        if (!existsSync(TRAFFIC_DATA_SNAPSHOT_FILE)) return res.json({ success: false, data: {}, snapshotAt: null });
        const raw = await readFile(TRAFFIC_DATA_SNAPSHOT_FILE, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.send(withImpressionsStale(raw));
    } catch (e) {
        res.json({ success: false, data: {}, snapshotAt: null });
    }
});

app.get('/api/traffic-admin-data-snapshot', async (req, res) => {
    try {
        if (!existsSync(TRAFFIC_ADMIN_DATA_SNAPSHOT_FILE)) return res.json({ success: false, data: {}, snapshotAt: null });
        const raw = await readFile(TRAFFIC_ADMIN_DATA_SNAPSHOT_FILE, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.send(withImpressionsStale(raw));
    } catch (e) {
        res.json({ success: false, data: {}, snapshotAt: null });
    }
});

app.post('/api/snapshot', async (req, res) => {
    try {
        await saveDataSnapshot();
        auditLog('SNAPSHOT', 'manual', 'Manual snapshot triggered', req);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Root redirect to traffic.html
app.get('/', (req, res) => {
    res.redirect('/traffic.html');
});

// SPA fallback: serve index.html for Vite-built apps
if (existsSync(DIST_DIR)) {
    app.get('*', (req, res) => {
        res.sendFile(join(DIST_DIR, 'index.html'));
    });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  📁 API Server: http://0.0.0.0:${PORT}`);
    console.log(`  💾 Данные сохраняются в: ${SESSIONS_DIR}\n`);
});
