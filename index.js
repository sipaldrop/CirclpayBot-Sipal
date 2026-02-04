const axios = require('axios');
const chalk = require('chalk');
const Table = require('cli-table3');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { ethers } = require('ethers');
const http = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════
// CONFIGURATION (FLAT STRUCTURE - NO CONFIG.JSON)
// ═══════════════════════════════════════════════════════════
const config = {
    baseUrl: "https://circlpay.app/backend/api",
    walletUrl: "https://wallet.circlpay.app",
    privyAppId: "cmk8pawbj014rl10cyz2ook41",
    endpoints: {
        balances: "/user/balances",
        profile: "/user/profile",
        send: "/send",
        syncAllChain: "/balances/syncallchain",
        transactions: "/user/transactions",
        tasks: "/tasks"
    },
    txSettings: {
        blockchain_id: 4,
        is_native: true,
        token_address: null,
        amount: "0.000001",
        recipient: [
            "0x8581e167ebd2eD4eaD567BE553C69ded535cb817",
            "0x69D1f94Dc8fBDEE4A0C7bf9d7944792c1E9ea949",
            "0xe9886f6a2f6AA049806100e480F27B12AE68F14f",
            "0x45f947276Ac50BDDfD45F2b68b31718db03D7922",
            "0x0a2d0B1495B62AF3a907815ef674047D7457db2D",
            "0x241e1a6F26CD122d850704F3965d3B56cE47C8b7",
            "0x3aD08dB11A703383A370Eb4BB40b74Cf17AB614c",
            "0x594F2405E11ee0eF7D3856Be33351C32461AF9E4",
            "0xf4B213EC1400eba172844Ad3E32390Bff62189e3",
            "0x64785Be661B4B412B3a8EE7913f4e03da6Dd8Fca"
        ]
    },
    delays: {
        minDelayBetweenTx: 30000,
        maxDelayBetweenTx: 60000,
        minDelayBetweenAccounts: 5000,
        maxDelayBetweenAccounts: 15000,
        cycleCooldown: 300000
    },
    smartLogic: {
        targetPoints: 20,
        txBatchSize: 5
    },
    settings: {
        enableDummyTraffic: true,
        enableRandomOrder: true,
        enableProxy: true,
        ignoreLowBalance: true
    },
    autoRefill: {
        enabled: true,
        minBalance: 0.2,
        refillAmount: 1,
        polygonRpc: "https://polygon-rpc.com"
    }
};

// ═══════════════════════════════════════════════════════════
// UI & LOGGER HELPERS (DASHBOARD STYLE)
// ═══════════════════════════════════════════════════════════
function formatDuration(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
}

const state = {
    accounts: [],
    logs: [],
    isRunning: true
};

const LOG_LIMIT = 10;

function logToState(msg) {
    const timestamp = new Date().toLocaleTimeString();
    state.logs.push(`${chalk.gray(`[${timestamp}]`)} ${msg}`);
    if (state.logs.length > LOG_LIMIT) {
        state.logs.shift();
    }
}

const logger = {
    info: (msg, options = {}) => {
        const emoji = options.emoji || 'ℹ️ ';
        const context = options.context ? `[${options.context}]` : '';
        logToState(`${emoji} ${chalk.cyan(context.padEnd(12))} ${msg}`);
    },
    success: (msg, options = {}) => {
        const emoji = options.emoji || '✅';
        const context = options.context ? `[${options.context}]` : '';
        logToState(`${emoji} ${chalk.cyan(context.padEnd(12))} ${chalk.green(msg)}`);
    },
    warn: (msg, options = {}) => {
        const emoji = options.emoji || '⚠️ ';
        const context = options.context ? `[${options.context}]` : '';
        logToState(`${emoji} ${chalk.cyan(context.padEnd(12))} ${chalk.yellow(msg)}`);
    },
    error: (msg, options = {}) => {
        const emoji = options.emoji || '❌';
        const context = options.context ? `[${options.context}]` : '';
        logToState(`${emoji} ${chalk.cyan(context.padEnd(12))} ${chalk.red(msg)}`);
    }
};

function renderTable() {
    console.clear();

    // Banner
    console.log(chalk.blue(`
               / \\
              /   \\
             |  |  |
             |  |  |
              \\  \\
             |  |  |
             |  |  |
              \\   /
               \\ /
    `));
    console.log(chalk.bold.cyan('    ======SIPAL AIRDROP======'));
    console.log(chalk.bold.cyan('  =====SIPAL CIRCLPAY V1.0====='));
    console.log('');

    // Summary Table
    const table = new Table({
        head: ['Account', 'IP', 'Status', 'Last Run', 'Next Run', 'Activity'],
        colWidths: [12, 18, 12, 12, 12, 28],
        style: { head: ['cyan'], border: ['grey'] }
    });

    state.accounts.forEach(acc => {
        let statusText = acc.status;
        if (acc.status === 'SUCCESS') statusText = chalk.green(acc.status);
        else if (acc.status === 'FAILED') statusText = chalk.red(acc.status);
        else if (acc.status === 'PROCESSING') statusText = chalk.yellow(acc.status);
        else if (acc.status === 'WAITING') statusText = chalk.blue(acc.status);
        else if (acc.status === 'EXPIRED') statusText = chalk.redBright(acc.status);
        else if (acc.status === 'DONE') statusText = chalk.green(acc.status);
        else if (acc.status === 'SKIPPED') statusText = chalk.gray(acc.status);

        let nextRunStr = '-';
        if (acc.nextRun) {
            // User requested explicit Date & Time
            nextRunStr = new Date(acc.nextRun).toLocaleString('id-ID', {
                day: '2-digit', month: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
        } else if (acc.status === 'DONE' || acc.status === 'SUCCESS') {
            nextRunStr = 'Tomorrow';
        }

        let lastRunStr = '-';
        if (acc.lastRun) {
            lastRunStr = new Date(acc.lastRun).toLocaleString('id-ID', {
                day: '2-digit', month: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
        }

        table.push([
            `Account ${acc.index}`,
            chalk.magenta(acc.ip || 'Direct'),
            statusText,
            lastRunStr,
            nextRunStr,
            chalk.gray((acc.info || '').substring(0, 26))
        ]);
    });

    console.log(table.toString());

    // Logs Area
    console.log(chalk.yellow(' EXECUTION LOGS:'));
    state.logs.forEach(log => console.log(log));
    console.log(chalk.bold.cyan('='.repeat(94)));
}

// ═══════════════════════════════════════════════════════════
// LOAD ACCOUNTS & WALLET DB
// ═══════════════════════════════════════════════════════════
let accountsData = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));
let walletDb = {};
try {
    if (fs.existsSync('wallet_db.json')) {
        walletDb = JSON.parse(fs.readFileSync('wallet_db.json', 'utf8'));
    } else {
        fs.writeFileSync('wallet_db.json', '{}');
    }
} catch (e) {
    console.log(chalk.red(`[System] ⚠️ Failed to load wallet_db.json: ${e.message}`));
}

// Support both old (array) and new (object with masterWallet) structure
let accounts, masterWallet;
if (Array.isArray(accountsData)) {
    accounts = accountsData;
    masterWallet = null;
} else {
    accounts = accountsData.accounts || [];
    masterWallet = accountsData.masterWallet || null;
}

// Initialize state.accounts for Dashboard
accounts.forEach((acc, idx) => {
    state.accounts.push({
        index: idx + 1,
        id: acc.name || `Account${idx + 1}`,
        status: 'WAITING',
        nextRun: null,
        lastRun: null,
        info: 'Initializing...',
        ip: acc.proxy ? acc.proxy.split('@')[1]?.split(':')[0] || 'Proxy' : 'Direct'
    });
});

// Helper: Get Public IP (for accurate Dashboard display)
async function getPublicIp(proxy) {
    try {
        const agent = proxy ? new HttpsProxyAgent(proxy) : null;
        const response = await axios.get('https://api64.ipify.org?format=json', {
            httpsAgent: agent,
            proxy: false,
            timeout: 10000
        });
        if (response.data && response.data.ip) return response.data.ip;
        return null;
    } catch (e) {
        return null;
    }
}

// Global State
const MAX_RETRIES = 10;
const MAX_NETWORK_RETRIES = Infinity;
const RETRY_DELAY_MS = 2000;
const MAX_BACKOFF_MS = 120000;

// Banner (now uses Dashboard renderTable)
function displayBanner() {
    renderTable();
    logger.info(`Loaded ${accounts.length} account(s)`, { context: 'System', emoji: '📊' });
}

// Helper: Save Accounts
// Helper: Save Accounts (Safe Update)
function saveAccounts() {
    try {
        // 1. Read latest file from disk to capture any manual edits
        let currentFile = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));

        // 2. Determine structure
        let fileAccounts = [];
        let fileMaster = null;

        if (Array.isArray(currentFile)) {
            fileAccounts = currentFile;
        } else {
            fileAccounts = currentFile.accounts || [];
            fileMaster = currentFile.masterWallet || null;
        }

        // 3. Update ONLY the tokens for accounts we have in memory
        // This ensures we don't revert other fields if user edited them
        accounts.forEach((memAcc, idx) => {
            if (fileAccounts[idx]) {
                fileAccounts[idx].token = memAcc.token;
                fileAccounts[idx].refresh_token = memAcc.refresh_token;
            }
        });

        // 4. Construct data to save
        let dataToSave;
        if (Array.isArray(currentFile)) {
            dataToSave = fileAccounts;
        } else {
            dataToSave = {
                masterWallet: fileMaster,
                accounts: fileAccounts
            };
        }

        // 5. Write back
        fs.writeFileSync('accounts.json', JSON.stringify(dataToSave, null, 2));
    } catch (e) {
        console.log(chalk.red(`[System] ⚠️ Failed to save accounts.json: ${e.message}`));
    }
}

// Helper: Save Wallet DB
function saveWalletDb() {
    try {
        fs.writeFileSync('wallet_db.json', JSON.stringify(walletDb, null, 2));
    } catch (e) {
        console.log(chalk.red(`[System] ⚠️ Failed to save wallet_db.json: ${e.message}`));
    }
}

// Helper: Parse JWT Expiry
function getTokenExpiry(token) {
    try {
        if (!token) return null;
        const payloadBase64 = token.split('.')[1];
        if (!payloadBase64) return null;
        const decodedJson = Buffer.from(payloadBase64, 'base64').toString();
        const payload = JSON.parse(decodedJson);
        if (payload.exp) {
            return new Date(payload.exp * 1000);
        }
        return null;
    } catch (e) { return null; }
}

// Helper: Axios Instance Generator
function createApi(account) {
    const agent = account.proxy ? new HttpsProxyAgent(account.proxy) : null;

    if (!account.privy_ca_id) {
        throw new Error(`[${account.name || 'Account'}] MISSING 'privy_ca_id' in accounts.json! This is required to avoid Sybil detection.`);
    }

    // Calculate Origin from Wallet URL or default
    const origin = config.walletUrl || "https://wallet.circlpay.app";

    const headers = {
        'origin': origin,
        'referer': origin + "/",
        'privy-app-id': config.privyAppId,
        'privy-app-id': config.privyAppId,
        'privy-ca-id': account.privy_ca_id, // STRICT MODE: Must be in account
        'privy-client': 'react-auth:3.10.1', // Verified from HAR
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    };

    if (account.token) {
        headers['authorization'] = `Bearer ${account.token}`;
    }

    return axios.create({
        baseURL: config.baseUrl,
        timeout: 30000,
        headers: headers,
        httpsAgent: agent,
        proxy: false
    });
}

// ==================== PRIVY REFRESH LOGIC ====================
// ==================== PRIVY REFRESH LOGIC ====================
async function refreshPrivyToken(accountIndex, accountName, retryCount = 0) {
    const MAX_REFRESH_RETRIES = 5;

    console.log(chalk.blue(`[${accountName}] 🔄 Refreshing access token...${retryCount > 0 ? ` (Attempt ${retryCount + 1})` : ''}`));

    const account = accounts[accountIndex];
    if (!account.refresh_token) {
        console.log(chalk.red(`[${accountName}] ☠️ No refresh_token found! Cannot refresh.`));
        return false;
    }
    if (!account.token) {
        // Technically this is a warning, as Privy might not strictly need it if refresh_token works alone on some endpoints, 
        // but current logic uses it.
        console.log(chalk.red(`[${accountName}] ☠️ No old access_token (expired) found! Privy requires it to refresh.`));
        return false;
    }

    try {
        const agent = account.proxy ? new HttpsProxyAgent(account.proxy) : null;

        const refreshUrl = 'https://auth.privy.io/api/v1/sessions';

        const payload = {
            refresh_token: account.refresh_token,
        };

        const headers = {
            'origin': config.walletUrl || "https://wallet.circlpay.app",
            'privy-app-id': config.privyAppId,
            'privy-app-id': config.privyAppId,
            'privy-ca-id': account.privy_ca_id, // STRICT MODE
            'privy-client': 'react-auth:3.10.1',
            'content-type': 'application/json',
            'authorization': `Bearer ${account.token}`
        };

        const response = await axios.post(refreshUrl, payload, {
            headers,
            httpsAgent: agent,
            proxy: false,
            timeout: 30000
        });

        // Check for token in multiple possible field names
        const newToken = response.data.privy_access_token || response.data.token || response.data.session?.token;
        const newRefresh = response.data.refresh_token || response.data.session?.refresh_token;

        if (newToken) {
            console.log(chalk.green(`[${accountName}] ✅ Token Refreshed Successfully!`));

            accounts[accountIndex].token = newToken;
            if (newRefresh) {
                accounts[accountIndex].refresh_token = newRefresh;
            }

            saveAccounts();
            return true;
        } else if (response.data && response.data.session_update_action === "clear") {
            console.log(chalk.red(`[${accountName}] ❌ Refresh Token Expired/Revoked. Please login manually!`));
            return false;
        } else {
            console.log(chalk.red(`[${accountName}] ✗ Refresh response invalid: ${JSON.stringify(response.data).slice(0, 200)}...`));
            return false;
        }

    } catch (error) {
        const errorMsg = error.message.toLowerCase();
        const errorCode = error.code || '';

        // Comprehensive proxy/network error detection for refresh
        const isProxyNetworkError = [
            // Network errors
            'econnreset', 'etimedout', 'econnrefused', 'ehostunreach', 'enotfound',
            'enetunreach', 'epipe', 'econnaborted', 'eai_again',
            // Proxy errors
            'proxy', 'tunnel', 'socket hang up', 'socket disconnected',
            'socks', 'eproto', 'ssl', 'tls', 'certificate',
            // Server errors
            'bad gateway', 'gateway timeout', 'service unavailable',
            '502', '503', '504', '520', '521', '522', '523', '524'
        ].some(pattern => errorMsg.includes(pattern) || errorCode.toLowerCase().includes(pattern));

        // Also check HTTP status codes
        const status = error.response?.status;
        const isServerError = status >= 500 && status < 600;

        if ((isProxyNetworkError || isServerError) && retryCount < MAX_REFRESH_RETRIES) {
            const backoff = Math.min(RETRY_DELAY_MS * Math.pow(1.5, retryCount), 60000);
            const delay = backoff + (Math.random() * 2000);

            console.log(chalk.magenta(`[${accountName}] 🔌 Proxy/Network error during refresh: ${error.message}`));
            console.log(chalk.gray(`[${accountName}] 🔄 Retrying refresh in ${Math.round(delay / 1000)}s... (${retryCount + 1}/${MAX_REFRESH_RETRIES})`));

            await new Promise(r => setTimeout(r, delay));
            return refreshPrivyToken(accountIndex, accountName, retryCount + 1);
        }

        console.log(chalk.red(`[${accountName}] ✗ Refresh Failed: ${error.message}`));
        if (error.response) {
            console.log(chalk.red(`[${accountName}] Status: ${error.response.status}`));
            console.log(chalk.red(`[${accountName}] Data: ${JSON.stringify(error.response.data)}`));
        }
        return false;
    }
}

async function retryWithBackoff(fn, context = 'Operation', account = null, accountIndex = null) {
    let networkRetryCount = 0;
    let consecutiveProxyErrors = 0;

    while (true) {
        const isNetworkRetry = networkRetryCount > 0;
        const currentRetry = networkRetryCount;

        try {
            const result = await fn();

            if (result.success) {
                // Reset counters on success
                if (networkRetryCount > 0) {
                    console.log(chalk.green(`[${context}] ✅ Recovered after ${networkRetryCount} retries!`));
                }
                return result;
            }

            // HANDLE REFRESH TOKEN
            if (result.needsRefresh && account && account.refresh_token && accountIndex !== null) {
                const refreshResult = await refreshPrivyToken(accountIndex, context);
                if (refreshResult) {
                    console.log(chalk.green(`[${context}] Token refreshed! Re-initializing API for next steps...`));
                    return { success: false, tokenRefreshed: true, shouldRetryLoop: true };
                } else {
                    console.log(chalk.red(`[${context}] ☠️ Refresh Failed. Account is dead.`));
                    return { success: false, error: 'TOKEN_DEAD' };
                }
            } else if (result.needsRefresh) {
                return result;
            }

            // ================= ROBUST PROXY & NETWORK RETRY LOGIC =================
            if (result.isNetworkError || result.isProxyError) {
                networkRetryCount++;

                // Track consecutive proxy errors for escalating delays
                if (result.isProxyError) {
                    consecutiveProxyErrors++;
                } else {
                    consecutiveProxyErrors = 0;
                }

                // Calculate backoff: exponential with max cap
                // For proxy errors, use longer base delay
                const baseDelay = result.isProxyError ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;
                const exponentialDelay = baseDelay * Math.pow(1.5, Math.min(networkRetryCount, 15));
                const backoff = Math.min(exponentialDelay, MAX_BACKOFF_MS);

                // Add jitter (10-30% random variation)
                const jitter = backoff * (0.1 + Math.random() * 0.2);
                const delay = Math.round(backoff + jitter);

                // Extra delay for repeated proxy failures (likely dead proxy)
                let extraDelay = 0;
                if (consecutiveProxyErrors >= 3) {
                    extraDelay = 30000; // Extra 30s after 3 consecutive proxy errors
                    console.log(chalk.red(`[${context}] ⚠️ ${consecutiveProxyErrors} consecutive proxy errors! Proxy might be dead.`));
                }

                const totalDelay = delay + extraDelay;
                const delaySeconds = Math.round(totalDelay / 1000);

                // Logging levels based on retry count
                if (networkRetryCount <= 3) {
                    console.log(chalk.gray(`[${context}] 🔄 Retry ${networkRetryCount} in ${delaySeconds}s... (${result.isProxyError ? 'Proxy' : 'Network'} Error)`));
                } else if (networkRetryCount <= 10) {
                    console.log(chalk.yellow(`[${context}] 🔄 Retry ${networkRetryCount} in ${delaySeconds}s... (${result.isProxyError ? 'Proxy' : 'Network'} Error)`));
                } else if (networkRetryCount % 10 === 0) {
                    // Log every 10th retry after 10 to avoid spam
                    console.log(chalk.magenta(`[${context}] 🔄 Still retrying... (Attempt ${networkRetryCount}, waiting ${delaySeconds}s)`));
                }

                await new Promise(r => setTimeout(r, totalDelay));
                continue;
            }

            // Rate limited - special handling
            if (result.error === 'RATE_LIMITED') {
                const retryAfter = (result.retryAfter || 60) * 1000;
                console.log(chalk.yellow(`[${context}] ⏳ Rate limited, waiting ${result.retryAfter || 60}s...`));
                await new Promise(r => setTimeout(r, retryAfter));
                networkRetryCount++;
                continue;
            }

            // Non-network error after MAX_RETRIES attempts
            if (currentRetry >= MAX_RETRIES) {
                console.log(chalk.red(`[${context}] ❌ Max retries (${MAX_RETRIES}) exceeded for non-network error.`));
                return result;
            }

            // Non-recoverable error
            return result;

        } catch (fatalError) {
            networkRetryCount++;

            // Check if this is a proxy/network related crash
            const errorMsg = fatalError.message.toLowerCase();
            const isProxyRelated = [
                'proxy', 'tunnel', 'socket', 'econnreset', 'etimedout',
                'econnrefused', 'enotfound', 'epipe', 'econnaborted'
            ].some(pattern => errorMsg.includes(pattern));

            if (isProxyRelated) {
                consecutiveProxyErrors++;
            }

            const backoff = Math.min(RETRY_DELAY_MS * Math.pow(1.5, Math.min(networkRetryCount, 15)), MAX_BACKOFF_MS);
            const delay = Math.round(backoff + (Math.random() * 2000));

            console.log(chalk.red(`[${context}] 💥 Crash protected: ${fatalError.message}`));
            console.log(chalk.gray(`[${context}] 🔄 Recovering in ${Math.round(delay / 1000)}s... (Attempt ${networkRetryCount})`));

            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function getProfile(api, accountName) {
    try {
        const response = await api.get(config.endpoints.profile);
        const data = response.data;

        // DEBUG: Disabled for cleaner parallel logs
        // console.log(chalk.gray(`[DEBUG] Profile Response Keys: ${JSON.stringify(Object.keys(data))}`));
        // if (data.user) console.log(chalk.gray(`[DEBUG] User Keys: ${JSON.stringify(Object.keys(data.user))}`));

        // Correct structure validation based on probe: { user: { total_points: ... } }
        if (data.user) {
            let points = data.user.total_points || 0;

            // Extract Wallet Address (CORRECTED: directly from user object)
            let walletAddress = data.user.wallet_address || null;

            return { success: true, points: points, address: walletAddress };
        }

        // Fallback for previous assumptions if format varies
        if (data.status === 'ok' || data.success || data.data) {
            let points = data.data?.points || data.data?.totalPoints || data.data?.xp || 0;
            if (data.data?.user?.points) points = data.data.user.points;
            return { success: true, points: points };
        }

        return { success: false, error: 'Invalid profile format' };
    } catch (error) {
        // Don't throw, just return error
        return { success: false, error: error.message };
    }
}

async function getBalances(api, accountIndex, accountName) {
    try {
        // 1. Get Profile for Points
        const profileRes = await getProfile(api, accountName);
        const points = profileRes.success ? profileRes.points : "N/A";

        // 2. Get Balances for MATIC
        const response = await api.get(config.endpoints.balances);
        const data = response.data;

        let maticBalance = "0";

        if (data.status === 'ok' || data.success || data.data) {
            if (Array.isArray(data.data)) {
                // DEBUG: Print all symbols found
                // const symbols = data.data.map(b => `${b.symbol}: ${b.formatted_balance}`);
                // console.log(chalk.gray(`[${accountName}] Balances found: ${symbols.join(', ')}`));

                const matic = data.data.find(b => b.symbol === 'MATIC' || b.symbol === 'POL');
                if (matic) {
                    maticBalance = matic.formatted_balance;
                }
            }

            // LOGGING moved to Main Loop for On-Chain Priority
            // console.log(chalk.green(`[${accountName}] Points: ${points} | MATIC: ${maticBalance}`));

            return { success: true, data: data };
        }
        return { success: false, error: 'Invalid response format' };
    } catch (error) {
        return handleApiError(error, accountName, 'getBalances');
    }
}

async function syncAllChain(api, accountIndex, accountName) {
    try {
        // If config has syncAllChain endpoint
        if (config.endpoints.syncAllChain) {
            // Supported Methods: GET, HEAD. Switching to GET.
            const response = await api.get(config.endpoints.syncAllChain);
            return { success: true, data: response.data };
        }
        return { success: true };
    } catch (error) {
        return handleApiError(error, accountName, 'syncAllChain');
    }
}

function handleApiError(error, accountIndex, functionName) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    const errorCode = error.code || '';

    // accountIndex might be a number (0) or string "Acc 0" depending on usage, but usually int.
    // Let's formatting it.
    let label = `Acc ${accountIndex}`;
    if (typeof accountIndex === 'number') {
        label = `Acc ${accountIndex + 1}`; // User requested 1-based or Name. Name is hard to pass here without refactor.
    } else {
        label = accountIndex; // If context string passed
    }

    if (status === 401 || status === 403) {
        return { success: false, error: 'TOKEN_EXPIRED', needsRefresh: true };
    }
    if (status === 400 && JSON.stringify(error.response?.data).includes("missing_or_invalid_token")) {
        return { success: false, error: 'TOKEN_EXPIRED', needsRefresh: true };
    }

    if (status === 429) {
        const retryAfter = error.response?.headers['retry-after'] || 60;
        console.log(chalk.yellow(`[${label}] Rate limited. Waiting ${retryAfter}s...`));
        return { success: false, error: 'RATE_LIMITED', retryAfter: retryAfter, isNetworkError: true };
    }

    // ================= ROBUST PROXY & NETWORK ERROR DETECTION =================
    // Standard Network Errors
    const networkErrors = [
        'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND',
        'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN', 'ENOENT'
    ];

    // Proxy-Specific Errors (very comprehensive)
    const proxyErrors = [
        // Tunneling / HTTP CONNECT Errors
        'tunneling socket',
        'socket hang up',
        'EPROTO',
        'ERR_TLS_CERT_ALTNAME_INVALID',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'CERT_HAS_EXPIRED',
        'ERR_TLS_HANDSHAKE_TIMEOUT',

        // Proxy Authentication Errors
        '407', // Proxy Authentication Required
        'Proxy-Authorization',
        'proxy authentication required',
        'proxy auth',

        // SOCKS Proxy Errors
        'SOCKS',
        'socks5',
        'socks4',
        'socks connection',
        'SOCKS5 proxy rejected',

        // General Proxy Errors
        'Proxy connection',
        'proxy error',
        'Bad Gateway',
        'Gateway Timeout',
        'Service Unavailable',
        'upstream connect error',
        'connection reset by peer',
        'Client network socket disconnected',

        // SSL/TLS via Proxy
        'SSL routines',
        'wrong version number',
        'unsupported protocol',
        'no renegotiation',
        'http2 error',

        // Timeout Related
        'timeout of',
        'read ECONNRESET',
        'write ECONNRESET',
        'ESOCKETTIMEDOUT'
    ];

    // HTTP Status Codes that indicate proxy/network issues
    const proxyStatusCodes = [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530];

    // Combine message + errorCode for checking
    const fullErrorText = `${message} ${errorCode}`.toLowerCase();

    // Check Network Errors
    const isNetworkError = networkErrors.some(code =>
        message.includes(code) || errorCode === code
    );

    // Check Proxy Errors
    const isProxyError = proxyErrors.some(pattern =>
        fullErrorText.includes(pattern.toLowerCase())
    ) || proxyStatusCodes.includes(status);

    // Check HTTP 5xx range
    const isServerError = status >= 500 && status < 600;

    if (isProxyError) {
        console.log(chalk.magenta(`[${label}] 🔌 Proxy Error (${functionName}): ${message} (Status: ${status || 'N/A'})`));
        return { success: false, error: message, isNetworkError: true, isProxyError: true };
    }

    if (isNetworkError || isServerError) {
        console.log(chalk.yellow(`[${label}] ⚠️ Network Error (${functionName}): ${message} (Status: ${status || 'N/A'})`));
        return { success: false, error: message, isNetworkError: true };
    }

    console.log(chalk.red(`[${label}] ${functionName} failed: ${message}`));
    return { success: false, error: message };
}

// Helper: Get On-Chain Balance (Polygon)
async function getPolygonBalance(address, proxy) {
    const rpcs = [
        "https://polygon-rpc.com",
        "https://rpc-mainnet.matic.network",
        "https://polygon.llamarpc.com",
        "https://1rpc.io/matic",
        "https://rpc.ankr.com/polygon"
    ];

    const agent = proxy ? new HttpsProxyAgent(proxy) : null;

    for (const rpcUrl of rpcs) {
        try {
            const payload = {
                "jsonrpc": "2.0",
                "method": "eth_getBalance",
                "params": [address, "latest"],
                "id": 1
            };

            const response = await axios.post(rpcUrl, payload, {
                httpsAgent: agent,
                proxy: false,
                timeout: 5000
            });

            if (response.data && response.data.result) {
                const wei = parseInt(response.data.result, 16);
                const matic = wei / 1e18;
                return matic;
            }
        } catch (e) {
            continue;
        }
    }
    return -1;
}

// ==================== CIRCLPAY AUTO-REFILL LOGIC ====================
async function refillFromMaster(targetAddress, accountName) {
    if (!config.autoRefill || !config.autoRefill.enabled) {
        return false;
    }

    // Read private key from masterWallet (loaded from accounts.json)
    if (!masterWallet || !masterWallet.privateKey) {
        console.log(chalk.red(`[${accountName}] ⚠️ Auto-Refill: masterWallet not found in accounts.json!`));
        return false;
    }

    const privateKey = masterWallet.privateKey;
    if (privateKey === "YOUR_MASTER_WALLET_PRIVATE_KEY_HERE") {
        console.log(chalk.red(`[${accountName}] ⚠️ Auto-Refill: Master wallet private key not configured!`));
        return false;
    }

    try {
        const rpcUrl = config.autoRefill.polygonRpc || "https://polygon-rpc.com";
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(privateKey, provider);

        const refillAmount = config.autoRefill.refillAmount || 0.5;
        const amountWei = ethers.parseEther(refillAmount.toString());

        console.log(chalk.yellow(`[${accountName}] 💰 Auto-Refill: Sending ${refillAmount} MATIC from Master Wallet...`));

        const tx = await wallet.sendTransaction({
            to: targetAddress,
            value: amountWei
        });

        console.log(chalk.gray(`[${accountName}] ⏳ TX Hash: ${tx.hash}`));
        console.log(chalk.gray(`[${accountName}] ⏳ Waiting for confirmation...`));

        const receipt = await tx.wait();

        if (receipt.status === 1) {
            console.log(chalk.green(`[${accountName}] ✅ Auto-Refill Success! +${refillAmount} MATIC`));
            return true;
        } else {
            console.log(chalk.red(`[${accountName}] ❌ Auto-Refill TX Failed!`));
            return false;
        }
    } catch (error) {
        console.log(chalk.red(`[${accountName}] ❌ Auto-Refill Error: ${error.message}`));
        return false;
    }
}

// Helper: Get Next 7:30 AM WIB
function getNext730WIB() {
    const now = new Date();
    // WIB is UTC+7. 
    // Target: 07:30 WIB = 00:30 UTC.

    let nextRun = new Date(now);
    nextRun.setUTCHours(0, 30, 0, 0); // 00:30 UTC

    // If 00:30 UTC has passed for today, schedule for tomorrow
    if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
    }
    return nextRun;
}

async function sendTransaction(api, accountName) {
    try {
        // Pick Random Recipient if Array
        let recipient = config.txSettings.recipient;
        if (Array.isArray(recipient)) {
            recipient = recipient[Math.floor(Math.random() * recipient.length)];
        }

        const payload = {
            blockchain_id: config.txSettings.blockchain_id,
            is_native: config.txSettings.is_native,
            token_address: config.txSettings.token_address,
            amount: config.txSettings.amount,
            recipient: recipient
        };
        const response = await api.post(config.endpoints.send, payload);
        if (response.data && (response.data.status === 'ok' || response.data.success)) {
            console.log(chalk.green(`[${accountName}] 💸 Payment Sent!`));
            return { success: true };
        }
        return { success: false, error: 'Tx failed' };
    } catch (error) {
        return handleApiError(error, accountName, 'sendTransaction');
    }
}

// Global Stats Storage for Daily Summary
let dailyStats = [];

function submitDailyStat(stat) {
    dailyStats.push(stat);

    if (dailyStats.length >= accounts.length) {
        // Sort by name for consistency
        dailyStats.sort((a, b) => a.name.localeCompare(b.name));

        // --- GRAND SUMMARY (SIPAL STYLE) ---
        console.log('\n' + chalk.bold.cyan('================================================================================'));
        console.log(chalk.bold.cyan(`                          🤖 SIPAL CIRCLPAY BOT V1.0 🤖`));
        console.log(chalk.bold.cyan('================================================================================'));

        const table = new Table({
            head: [
                chalk.cyan('Account'),
                chalk.cyan('Points (Before)'),
                chalk.cyan('Points (After)'),
                chalk.cyan('MATIC Balance'),
                chalk.cyan('Next Run'),
                chalk.cyan('Next Refresh Token')
            ],
            colWidths: [15, 20, 20, 18, 15, 30],
            style: { head: ['cyan'], border: ['grey'] }
        });

        dailyStats.forEach(s => {
            table.push([
                chalk.white(s.name),
                chalk.yellow(s.pointsBefore),
                chalk.green(s.pointsAfter),
                chalk.cyan(s.matic),
                chalk.gray(s.nextRun),
                chalk.magenta(s.nextRefresh)
            ]);
        });

        console.log(table.toString());
        console.log(chalk.bold.cyan('================================================================================\n'));

        // Reset for next day
        dailyStats = [];
    }
}

// MAIN LOOP
(async () => {
    displayBanner();

    if (accounts.length === 0) {
        logger.error('No accounts found in accounts.json', { context: 'System' });
        return;
    }

    // Start Dashboard Refresh Interval (every 2 seconds)
    const dashboardInterval = setInterval(() => {
        if (state.isRunning) renderTable();
    }, 2000);

    // Global Loop
    while (true) {
        logger.info(`Starting daily cycle for ${accounts.length} accounts`, { context: 'System', emoji: '🚀' });

        // Clear stats for new day
        dailyStats = [];

        // Reset all account statuses
        state.accounts.forEach((acc, idx) => {
            acc.status = 'WAITING';
            acc.info = 'Queued...';
        });
        renderTable();

        // Process ALL accounts in parallel
        const accountPromises = accounts.map(async (account, index) => {
            const name = account.name || `Account${index + 1}`;

            // Update state for Dashboard
            state.accounts[index].status = 'PROCESSING';
            state.accounts[index].info = 'Starting...';

            // CHECK ACTIVE STATUS
            if (account.active === false) {
                state.accounts[index].status = 'SKIPPED';
                state.accounts[index].info = 'Inactive';
                logger.info(`Skipped (Inactive)`, { context: name, emoji: '⏩' });
                return;
            }

            // Check & Refresh Token if needed
            const exp = getTokenExpiry(accounts[index].token);
            if (exp) {
                const minsLeft = Math.round((exp - new Date()) / 60000);
                if (minsLeft < 30) {
                    state.accounts[index].info = 'Refreshing token...';
                    logger.warn(`Token expiring (${minsLeft}m), refreshing...`, { context: name, emoji: '🔄' });
                    await refreshPrivyToken(index, name);
                }
            }

            // CHECK DAILY LIMIT (DB)
            const today = new Date().toISOString().split('T')[0];
            if (walletDb[today] && walletDb[today][name] && walletDb[today][name].status === "DONE") {
                state.accounts[index].status = 'DONE';
                state.accounts[index].info = `Done (${walletDb[today][name].points} pts)`;
                logger.success(`Already DONE for today`, { context: name });
                submitDailyStat({
                    name: name,
                    pointsBefore: walletDb[today][name].points,
                    pointsAfter: walletDb[today][name].points,
                    matic: "N/A",
                    nextRun: "DONE",
                    nextRefresh: "Saved in DB"
                });
                return;
            }

            let api = createApi(accounts[index]);

            // Resolve IP for clearer display (User Request)
            if (state.accounts[index].ip.includes('Proxy') || state.accounts[index].ip.includes('Direct')) {
                // Try to resolve real IP in background to avoid blocking too much
                getPublicIp(accounts[index].proxy).then(ip => {
                    if (ip) state.accounts[index].ip = ip;
                });
            }

            state.accounts[index].info = 'Fetching profile...';
            logger.info(`Starting...`, { context: name, emoji: '🔹' });

            // 0. Initial Data
            let initialPoints = 0;
            let resProfile = await retryWithBackoff(() => getProfile(api, name), name, accounts[index], index);
            if (resProfile.success) initialPoints = parseFloat(resProfile.points) || 0;

            // 0.5 Sync Chain
            await retryWithBackoff(() => syncAllChain(api, index, name), name, accounts[index], index);

            // 1. Get Balances
            let res = await retryWithBackoff(() => getBalances(api, index, name), name, accounts[index], index);
            if (!res.success && res.error === 'TOKEN_DEAD') {
                state.accounts[index].status = 'EXPIRED';
                state.accounts[index].info = 'Token revoked';
                logger.error(`Token is dead/revoked`, { context: name });
                submitDailyStat({
                    name: name,
                    pointsBefore: initialPoints,
                    pointsAfter: "DEAD",
                    matic: "N/A",
                    nextRun: "STOPPED",
                    nextRefresh: "TOKEN REVOKED"
                });
                return;
            }



            // Check Low Balance
            let maticBalanceVal = 0;
            let usedOnChain = false;

            // Priority: Check On-Chain First
            state.accounts[index].info = 'Checking balance...';
            if (resProfile.success && resProfile.address) {
                logger.info(`Checking On-Chain (${resProfile.address.slice(0, 8)}...)`, { context: name, emoji: '🔍' });

                let onChainBal = await getPolygonBalance(resProfile.address, accounts[index].proxy);

                if (onChainBal < 0 && accounts[index].proxy) {
                    onChainBal = await getPolygonBalance(resProfile.address, null);
                }

                if (onChainBal >= 0) {
                    maticBalanceVal = onChainBal;
                    usedOnChain = true;
                    logger.info(`On-Chain: ${maticBalanceVal.toFixed(4)} MATIC`, { context: name, emoji: '⛓️' });
                }
            } else {
                logger.warn(`No wallet address found`, { context: name });
            }

            // STRICT: On-Chain Only. If On-Chain fails (-1), maticBalanceVal stays 0.

            // Update state with balance info
            state.accounts[index].info = `${initialPoints} pts | ${maticBalanceVal.toFixed(4)} MATIC`;

            // AUTO-REFILL CHECK: If balance < minBalance, refill from master wallet
            const minBalance = config.autoRefill?.minBalance || 0.2;
            if (maticBalanceVal < minBalance && resProfile.address && config.autoRefill?.enabled) {
                state.accounts[index].info = 'Auto-refilling...';
                logger.warn(`Low balance (${maticBalanceVal}), auto-refilling...`, { context: name });
                const refillSuccess = await refillFromMaster(resProfile.address, name);

                if (refillSuccess) {
                    await new Promise(r => setTimeout(r, 5000));
                    const newBalance = await getPolygonBalance(resProfile.address, null);
                    if (newBalance >= 0) {
                        maticBalanceVal = newBalance;
                        logger.success(`New Balance: ${maticBalanceVal} MATIC`, { context: name, emoji: '💰' });
                    }
                }
            }

            if (maticBalanceVal < 0.0001) {
                if (config.settings.ignoreLowBalance) {
                    logger.warn(`Low balance but FORCE MODE ON`, { context: name });
                } else {
                    state.accounts[index].status = 'SKIPPED';
                    state.accounts[index].info = 'Low balance';
                    logger.error(`Insufficient MATIC (${maticBalanceVal})`, { context: name });
                    submitDailyStat({
                        name: name,
                        pointsBefore: initialPoints,
                        pointsAfter: initialPoints,
                        matic: maticBalanceVal + " MATIC",
                        nextRun: "SKIPPED",
                        nextRefresh: "OK"
                    });
                    return;
                }
            }

            // Logic: If ignored, we assume sufficient.
            let isEarning = (maticBalanceVal >= 0.0001) || config.settings.ignoreLowBalance;
            state.accounts[index].info = 'Sending transactions...';

            let currentPoints = initialPoints;
            let txCount = 0;

            // SMART LOOP
            while (isEarning) {
                let batchStartPoints = currentPoints;
                const batchSize = 2;

                state.accounts[index].info = `TX batch ${txCount}... (${currentPoints} pts)`;

                for (let i = 0; i < batchSize; i++) {
                    const txRes = await retryWithBackoff(() => sendTransaction(api, name), name, accounts[index], index);

                    if (txRes.shouldRetryLoop) {
                        api = createApi(accounts[index]);
                    }

                    txCount++;
                    await new Promise(r => setTimeout(r, 2000));
                }

                // Delay check
                await new Promise(r => setTimeout(r, 10000));

                // Check Points Update
                resProfile = await retryWithBackoff(() => getProfile(api, name), name, accounts[index], index);

                if (resProfile.success) {
                    let newPoints = parseFloat(resProfile.points) || 0;

                    if (newPoints > batchStartPoints) {
                        currentPoints = newPoints;
                        state.accounts[index].info = `+${newPoints - batchStartPoints} pts! (${newPoints})`;
                        logger.success(`Points increased: ${batchStartPoints} -> ${newPoints}`, { context: name });
                    } else {
                        // Double check
                        state.accounts[index].info = 'Waiting for server...';
                        await new Promise(r => setTimeout(r, 30000));

                        let retryCheck = await retryWithBackoff(() => getProfile(api, name), name, accounts[index], index);
                        if (retryCheck.success) {
                            newPoints = parseFloat(retryCheck.points) || 0;

                            if (newPoints > batchStartPoints) {
                                currentPoints = newPoints;
                                logger.success(`Points increased after delay!`, { context: name });
                                continue;
                            }
                        }

                        logger.warn(`Points stopped. Ending cycle.`, { context: name });
                        isEarning = false;
                        currentPoints = newPoints;
                    }
                } else {
                    logger.warn(`Network error verifying points`, { context: name });
                }
            } // End While Earning

            // Final Stats for this account

            // POST-PROCESSING TOKEN REFRESH
            const postExp = getTokenExpiry(accounts[index].token);
            if (postExp) {
                const postMinsLeft = Math.round((postExp - new Date()) / 60000);
                if (postMinsLeft < 30) {
                    logger.info(`Refreshing token...`, { context: name, emoji: '🔄' });
                    await refreshPrivyToken(index, name);
                }
            }

            // Calc Next Refresh for Table (after potential refresh)
            let nextRefresh = "Unknown";
            const finalExp = getTokenExpiry(accounts[index].token);
            if (finalExp) {
                const diffMins = Math.round((finalExp - new Date()) / 60000);
                // Show actual expiry time
                nextRefresh = diffMins > 0 ? `${finalExp.toLocaleTimeString()} (${diffMins}m)` : "EXPIRED!";
            }

            // UPDATE DB: MARK AS DONE
            const todayDone = new Date().toISOString().split('T')[0];
            if (!walletDb[todayDone]) walletDb[todayDone] = {};
            walletDb[todayDone][name] = {
                status: "DONE",
                points: currentPoints,
                timestamp: new Date().toISOString()
            };
            saveWalletDb();

            submitDailyStat({
                name: name,
                pointsBefore: initialPoints,
                pointsAfter: currentPoints,
                matic: maticBalanceVal + " MATIC",
                nextRun: "DONE",
                nextRefresh: nextRefresh
            });

            // Update Dashboard state
            state.accounts[index].status = 'SUCCESS';
            state.accounts[index].info = `Done! ${currentPoints} pts`;
            state.accounts[index].lastRun = Date.now();

            logger.success(`Finished! ${initialPoints} -> ${currentPoints} pts`, { context: name });

        }); // End accounts.map

        // Wait for ALL accounts to complete
        await Promise.all(accountPromises);

        // PRINT FINAL SUMMARY TABLE (after all parallel tasks done)
        console.log(chalk.magenta(`\n${'═'.repeat(60)}`));
        console.log(chalk.magenta.bold(`📊 DAILY SUMMARY - ${new Date().toLocaleDateString()}`));
        console.log(chalk.magenta(`${'═'.repeat(60)}`));

        // Force print remaining stats
        if (dailyStats.length > 0) {
            const summaryTable = new Table({
                head: ['Account', 'Before', 'After', 'MATIC', 'Status', 'Token Refresh'],
                style: { head: ['cyan'] }
            });
            dailyStats.forEach(stat => {
                summaryTable.push([stat.name, stat.pointsBefore, stat.pointsAfter, stat.matic, stat.nextRun, stat.nextRefresh]);
            });
            console.log(summaryTable.toString());
        }

        const nextRun = getNext730WIB();
        console.log(chalk.gray(`\n💤 Global Sleep until ${nextRun.toLocaleTimeString()}...`));

        // Update all accounts with next run time for Dashboard
        state.accounts.forEach((acc, idx) => {
            acc.nextRun = nextRun.getTime();
        });

        // HEARTBEAT LOGIC (Global)
        const nowTime = new Date();
        let remainingTime = nextRun - nowTime;
        const heartbeatInterval = 20 * 60 * 1000;

        while (remainingTime > 0) {
            const sleepTime = Math.min(remainingTime, heartbeatInterval);
            await new Promise(r => setTimeout(r, sleepTime));
            remainingTime -= sleepTime;

            if (remainingTime > 10000) {
                logger.info(`Heartbeat: Checking tokens...`, { context: 'System', emoji: '💓' });
                for (let i = 0; i < accounts.length; i++) {
                    const acc = accounts[i];
                    const runName = acc.name || `Account${i + 1}`;

                    const hbExp = getTokenExpiry(acc.token);
                    if (hbExp) {
                        const hbMinsLeft = Math.round((hbExp - new Date()) / 60000);
                        if (hbMinsLeft < 30) {
                            logger.warn(`Refreshing token (${hbMinsLeft}m left)`, { context: runName, emoji: '🔄' });
                            await refreshPrivyToken(i, runName);
                        }
                    }

                    let api = createApi(accounts[i]);
                    await retryWithBackoff(() => getProfile(api, runName), runName, accounts[i], i);
                }
                logger.success(`Heartbeat complete`, { context: 'System', emoji: '💓' });
            }
        }
    }
})();
