import express from 'express';
import { readdir, readFile, writeFile, unlink, mkdir, rename } from 'fs/promises';
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

const app = express();
app.use(express.json({ limit: '100mb' }));

// Serve static frontend files in production
const DIST_DIR = join(__dirname, 'dist');
if (existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
}

// --- Sync Timestamps ---
let timestamps = { data: Date.now(), chessboard: Date.now(), assets: Date.now(), traffic: Date.now(), traffic_data: Date.now() };

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

        const backupPath = join(BACKUPS_DIR, file);
        if (!existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });

        // Determine target file from backup name
        const dataType = file.split('__')[0]; // e.g. _chessboard
        const targetMap = {
            '_current_data': DATA_FILE,
            '_chessboard': CHESSBOARD_FILE,
            '_assets': ASSETS_FILE,
            '_traffic': TRAFFIC_FILE
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

        console.log(`[Backup] ✅ Restored ${file} → ${targetFile}`);
        res.json({ ok: true, restored: file, target: dataType });
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
        const filePath = join(SESSIONS_DIR, `${session.id}.json`);
        await createBackup(filePath);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = filePath + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(session, null, 2), 'utf-8');
        await rename(tmpFile, filePath);
        res.json({ ok: true });
    } catch (e) {
        console.error('[Server] Error saving session:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE session
app.delete('/api/sessions/:id', async (req, res) => {
    try {
        const filepath = join(SESSIONS_DIR, `${req.params.id}.json`);
        if (existsSync(filepath)) await unlink(filepath);
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
        // Atomic write: write to temp file, then rename
        await createBackup(TRAFFIC_FILE);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(req.body, null, 2), 'utf-8');
        await rename(tmpFile, TRAFFIC_FILE);
        timestamps.traffic = Date.now();
        res.json({ ok: true, version: timestamps.traffic });
        
        // Trigger background refresh instantly for new campaigns
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
        if (!existsSync(TRAFFIC_FILE)) {
            return res.status(404).json({ error: 'Config file not found' });
        }
        const data = await readFile(TRAFFIC_FILE, 'utf-8');
        let configs = JSON.parse(data);
        
        const initialLength = configs.length;
        configs = configs.filter(c => c.name !== campaignToDelete);
        
        if (configs.length === initialLength) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        await createBackup(TRAFFIC_FILE);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(configs, null, 2), 'utf-8');
        await rename(tmpFile, TRAFFIC_FILE);
        timestamps.traffic = Date.now();
        res.json({ ok: true, version: timestamps.traffic });
        
        // Trigger background refresh instantly to update cache
        refreshTrafficData().catch(e => console.error('[Server] Auto-refresh failed:', e));
    } catch (e) {
        console.error('[Server] Error deleting traffic config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// PATCH single traffic campaign properties
app.patch('/api/traffic/:name', async (req, res) => {
    try {
        const campaignToUpdate = req.params.name;
        const updates = req.body;
        
        if (!existsSync(TRAFFIC_FILE)) {
            return res.status(404).json({ error: 'Config file not found' });
        }
        
        const data = await readFile(TRAFFIC_FILE, 'utf-8');
        let configs = JSON.parse(data);
        
        let found = false;
        configs = configs.map(c => {
            if (c.name === campaignToUpdate) {
                found = true;
                return { ...c, ...updates };
            }
            return c;
        });
        
        if (!found) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        await createBackup(TRAFFIC_FILE);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(configs, null, 2), 'utf-8');
        await rename(tmpFile, TRAFFIC_FILE);
        timestamps.traffic = Date.now();
        res.json({ ok: true });
        
        // Trigger background refresh instantly to update cache
        refreshTrafficData().catch(e => console.error('[Server] Auto-refresh failed:', e));
    } catch (e) {
        console.error('[Server] Error updating traffic config:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// PUT replace traffic config order
app.put('/api/traffic/reorder', async (req, res) => {
    try {
        const newOrderNames = req.body.names; // Array of names in new order
        if (!Array.isArray(newOrderNames)) {
            return res.status(400).json({ error: 'Expected names array' });
        }
        
        if (!existsSync(TRAFFIC_FILE)) {
            return res.status(404).json({ error: 'Config file not found' });
        }
        
        const data = await readFile(TRAFFIC_FILE, 'utf-8');
        const configs = JSON.parse(data);
        
        const newConfigs = [];
        // Extract configs matching the requested new order
        for (const name of newOrderNames) {
            const found = configs.find(c => c.name === name);
            if (found) newConfigs.push(found);
        }
        
        // Append any configs that might have been missing from the array to not lose data
        for (const c of configs) {
            if (!newOrderNames.includes(c.name)) {
                newConfigs.push(c);
            }
        }
        
        await createBackup(TRAFFIC_FILE);
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = TRAFFIC_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify(newConfigs, null, 2), 'utf-8');
        await rename(tmpFile, TRAFFIC_FILE);
        timestamps.traffic = Date.now();
        res.json({ ok: true });
        
        // Trigger background refresh
        refreshTrafficData().catch(e => console.error('[Server] Auto-refresh failed:', e));
    } catch (e) {
        console.error('[Server] Error reordering traffic configs:', e.message);
        res.status(500).json({ error: e.message });
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

// --- Background Sheet Poller ---
async function refreshTrafficData() {
    console.log('[Worker] Starting background refresh of Traffic Data from Google Sheets...');
    try {
        let configs = [];
        if (existsSync(TRAFFIC_FILE)) {
            configs = JSON.parse(await readFile(TRAFFIC_FILE, 'utf-8'));
        }
        
        const allCampaignsMap = {};
        
        for (const config of configs) {
            try {
                const { url, name: customName } = config;
                if (!url) continue;
                
                const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
                if (!match) continue;
                const sheetId = match[1];
                const campaigns = {};

                // 1. Fetch Campaign Stats sheet
                const statsUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Статистика_Кампаний')}`;
                const statsRes = await fetch(statsUrl);
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
                const termsRes = await fetch(termsUrl);
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

                // 3. Fetch Metadata sheet
                let sheetLastUpdated = null;
                try {
                    const metaUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Метаданные')}`;
                    const metaRes = await fetch(metaUrl);
                    if (metaRes.ok) {
                        const metaText = await metaRes.text();
                        if (!metaText.startsWith('<html')) {
                            const metaData = parseCSV(metaText);
                            // Support horizontal (new) structure
                            const headerIdx = metaData[0] ? metaData[0].findIndex(h => h === 'updated_at' || h === 'Последнее обновление') : -1;
                            if (headerIdx !== -1 && metaData.length > 1) {
                                sheetLastUpdated = metaData[1][headerIdx];
                            } else {
                                // Support vertical (old) structure
                                for (let i = 1; i < metaData.length; i++) {
                                    if (metaData[i][0] === 'Последнее обновление' && metaData[i][1]) {
                                        sheetLastUpdated = metaData[i][1];
                                    }
                                }
                            }
                            
                            // Normalize date format mapping to ISO8601 for robust parsing
                            if (sheetLastUpdated) {
                                if (sheetLastUpdated.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) {
                                    sheetLastUpdated = sheetLastUpdated.replace(' ', 'T');
                                } else if (sheetLastUpdated.match(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/)) {
                                    const [datePart, timePart] = sheetLastUpdated.split(' ');
                                    const [d, m, y] = datePart.split('.');
                                    sheetLastUpdated = `${y}-${m}-${d}T${timePart}`;
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Ignore missing metadata
                }

                // Map extra properties into final campaigns
                for (const [campName, camp] of Object.entries(campaigns)) {
                    camp.sheetLastUpdated = sheetLastUpdated;
                    camp.url = config.url;
                    camp.customName = config.name;
                    camp.comment = config.comment || '';
                    const globalKey = `${config.name}_${campName}`;
                    allCampaignsMap[globalKey] = camp;
                }
                
            } catch (urlErr) {
                console.error(`[Worker] Error fetching Google Sheet ${config.url}:`, urlErr.message);
            }
        }
        
        // Atomic write to cache file
        const tmpId = Date.now() + Math.random().toString(36).slice(2);
        const tmpFile = TRAFFIC_DATA_FILE + '.' + tmpId + '.tmp';
        await writeFile(tmpFile, JSON.stringify({ success: true, data: allCampaignsMap }), 'utf-8');
        await rename(tmpFile, TRAFFIC_DATA_FILE);
        timestamps.traffic_data = Date.now();
        console.log(`[Worker] Traffic Data refreshed successfully. ${Object.keys(allCampaignsMap).length} campaigns cached.`);
    } catch (e) {
        console.error('[Worker] Fatal error refreshing Traffic Data:', e);
    }
}

// Start background worker initially and every 60 minutes
setTimeout(refreshTrafficData, 3000);
setInterval(refreshTrafficData, 60 * 60 * 1000);

// POST manually force refresh all traffic data
app.post('/api/traffic/refresh', async (req, res) => {
    try {
        await refreshTrafficData();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET cached traffic data
app.get('/api/traffic-data', async (req, res) => {
    try {
        if (!existsSync(TRAFFIC_DATA_FILE)) {
            return res.json({ success: true, data: {} });
        }
        const data = await readFile(TRAFFIC_DATA_FILE, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SPA fallback: serve index.html for all non-API routes in production
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
