const axios = require('axios');
const chalk = require('chalk');
const Table = require('cli-table3');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const http = require('http');
const https = require('https');

// Load Config & Accounts
let config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
let accounts = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));

// Global State
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

// Banner
function displayBanner() {
    console.log(chalk.cyan(`
               / \\
              /   \\
             |  |  |
             |  |  |
              \\  \\
             |  |  |
             |  |  |
              \\   /
               \\ /

    ======SIPAL AIRDROP======
  =====SIPAL CIRCLPAY V1.0=====
`));
    console.log(chalk.yellow(`[System] Loaded ${accounts.length} account(s)`));
}

// Helper: Save Accounts
function saveAccounts() {
    fs.writeFileSync('accounts.json', JSON.stringify(accounts, null, 2));
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
async function refreshPrivyToken(accountIndex, accountName) {
    console.log(chalk.blue(`[${accountName}] 🔄 Refreshing access token...`));

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
            proxy: false
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
        console.log(chalk.red(`[${accountName}] ✗ Refresh Failed: ${error.message}`));
        if (error.response) {
            console.log(chalk.red(`[${accountName}] Status: ${error.response.status}`));
            console.log(chalk.red(`[${accountName}] Data: ${JSON.stringify(error.response.data)}`));
        }
        return false;
    }
}

async function retryWithBackoff(fn, context = 'Operation', account = null, accountIndex = null) {
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const result = await fn();

            if (result.success) return result;

            // HANDLE REFRESH TOKEN
            if (result.needsRefresh && account && account.refresh_token && accountIndex !== null) {
                // Call refresh with name if possible, context often is name
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

            if (result.isNetworkError) {
                const backoff = Math.min(RETRY_DELAY_MS * Math.pow(1.5, i), 30000);
                const delay = backoff + (Math.random() * 2000); // Random jitter
                if (i < MAX_RETRIES - 1) console.log(chalk.gray(`[${context}] Retry ${i + 1}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s...`));
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            return result;

        } catch (fatalError) {
            console.log(chalk.red(`[${context}] Fatal Crash protected: ${fatalError.message}`));
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    return { success: false, error: 'MAX_RETRIES' };
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

    const networkErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', '502', '504', '503', '500'];
    // Added 502/504 explicitly to string list partially, but logic handles it via status range mostly.

    const isNetworkError = networkErrors.some(code => message.includes(code)) || (status >= 500 && status < 600);

    if (isNetworkError) {
        console.log(chalk.yellow(`[${label}] ⚠️ Network Error (${functionName}): ${message} (Status: ${status})`));
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
        console.log(chalk.red("No accounts found in accounts.json"));
        return;
    }

    // Global Loop
    while (true) {
        console.log(chalk.magenta(`\n${'═'.repeat(60)}`));
        console.log(chalk.magenta.bold(`🚀 STARTING DAILY CYCLE FOR ${accounts.length} ACCOUNTS (PARALLEL)`));
        console.log(chalk.magenta(`${'═'.repeat(60)}\n`));

        // Clear stats for new day
        dailyStats = [];

        // Process ALL accounts in parallel
        const accountPromises = accounts.map(async (account, index) => {
            const name = account.name || `Account${index + 1}`;

            // CHECK ACTIVE STATUS
            if (account.active === false) {
                console.log(chalk.gray(`[${name}] ⏩ Skipped`));
                return; // Return from this promise, not break
            }

            // Check & Refresh Token if needed
            const exp = getTokenExpiry(accounts[index].token);
            if (exp) {
                const minsLeft = Math.round((exp - new Date()) / 60000);
                if (minsLeft < 30) {
                    console.log(chalk.yellow(`[${name}] 🔄 Token expiring soon (${minsLeft}m), refreshing...`));
                    await refreshPrivyToken(index, name);
                }
            }

            let api = createApi(accounts[index]); // API with fresh token

            console.log(chalk.cyan(`[${name}] 🔹 Starting...`));

            // 0. Initial Data
            let initialPoints = 0;
            let resProfile = await retryWithBackoff(() => getProfile(api, name), name, accounts[index], index);
            if (resProfile.success) initialPoints = parseFloat(resProfile.points) || 0;

            // 0.5 Sync Chain
            await retryWithBackoff(() => syncAllChain(api, index, name), name, accounts[index], index);

            // 1. Get Balances
            let res = await retryWithBackoff(() => getBalances(api, index, name), name, accounts[index], index);
            if (!res.success && res.error === 'TOKEN_DEAD') {
                submitDailyStat({
                    name: name,
                    pointsBefore: initialPoints,
                    pointsAfter: "DEAD",
                    matic: "N/A",
                    nextRun: "STOPPED",
                    nextRefresh: "TOKEN REVOKED"
                });
                return; // Skip to next account (return from map function)
            }



            // Check Low Balance
            let maticBalanceVal = 0;
            let usedOnChain = false;

            // Priority: Check On-Chain First
            if (resProfile.success && resProfile.address) {
                console.log(chalk.gray(`[${name}] 🔍 Checking On-Chain (Address: ${resProfile.address.slice(0, 8)}...)...`));

                // Try with proxy first
                let onChainBal = await getPolygonBalance(resProfile.address, accounts[index].proxy);

                // If proxy failed, try without proxy
                if (onChainBal < 0 && accounts[index].proxy) {
                    console.log(chalk.gray(`[${name}] 🔄 Retrying On-Chain without proxy...`));
                    onChainBal = await getPolygonBalance(resProfile.address, null);
                }

                if (onChainBal >= 0) {
                    maticBalanceVal = onChainBal;
                    usedOnChain = true;
                    console.log(chalk.blue(`[${name}] ⛓️ On-Chain Balance (Polygon): ${maticBalanceVal} MATIC`));
                }
            } else {
                console.log(chalk.gray(`[${name}] ⚠️ No wallet address found in profile, cannot check On-Chain.`));
            }

            // STRICT: On-Chain Only. If On-Chain fails (-1), maticBalanceVal stays 0.

            // CONSOLIDATED LOG
            let balanceSource = usedOnChain ? "⛓️ On-Chain" : "❌ RPC Failed";
            let colorFn = usedOnChain ? chalk.blue : chalk.red;

            console.log(colorFn(`[${name}] Points: ${initialPoints} | MATIC: ${maticBalanceVal} (${balanceSource})`));

            if (maticBalanceVal < 0.0001) {
                if (config.settings.ignoreLowBalance) {
                    console.log(chalk.yellow(`[${name}] ⚠️ Insufficient MATIC Balance (${maticBalanceVal}) detected, but FORCE MODE is ON. Proceeding...`));
                } else {
                    console.log(chalk.red(`[${name}] ⚠️ Insufficient MATIC Balance (${maticBalanceVal} < 0.0001). Skipping.`));
                    submitDailyStat({
                        name: name,
                        pointsBefore: initialPoints,
                        pointsAfter: initialPoints, // No change
                        matic: maticBalanceVal + " MATIC",
                        nextRun: "SKIPPED",
                        nextRefresh: "OK"
                    });
                    return; // Skip to next account (return from map function)
                }
            }

            // Logic: If ignored, we assume sufficient.
            let isEarning = (maticBalanceVal >= 0.0001) || config.settings.ignoreLowBalance;
            console.log(chalk.gray(`[${name}] Starting Smart Transaction Loop...`));

            let currentPoints = initialPoints;
            let txCount = 0;

            // SMART LOOP
            while (isEarning) {
                let batchStartPoints = currentPoints;
                const batchSize = 2;

                console.log(chalk.cyan(`[${name}] Running batch of ${batchSize} TXs... (Current Points: ${currentPoints})`));

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
                    console.log(chalk.yellow(`[${name}] Check: ${batchStartPoints} -> ${newPoints}`));

                    if (newPoints > batchStartPoints) {
                        currentPoints = newPoints;
                        console.log(chalk.green(`[${name}] Points Increased! Continuing...`));
                    } else {
                        // Double check
                        console.log(chalk.magenta(`[${name}] Points stuck. Waiting 30s for server update...`));
                        await new Promise(r => setTimeout(r, 30000));

                        let retryCheck = await retryWithBackoff(() => getProfile(api, name), name, accounts[index], index);
                        if (retryCheck.success) {
                            newPoints = parseFloat(retryCheck.points) || 0;
                            console.log(chalk.yellow(`[${name}] Re-Check: ${batchStartPoints} -> ${newPoints}`));

                            if (newPoints > batchStartPoints) {
                                currentPoints = newPoints;
                                console.log(chalk.green(`[${name}] Points Increased after delay! Continuing...`));
                                continue;
                            }
                        }

                        console.log(chalk.red(`[${name}] Points REALLY STOPPED increasing. Ending daily cycle.`));
                        isEarning = false;
                        currentPoints = newPoints;
                    }
                } else {
                    console.log(chalk.red(`[${name}] ⚠️ Failed to verify points (Network Error). Continuing tentatively...`));
                }
            } // End While Earning

            // Final Stats for this account
            // Calc Next Refresh for Table
            let nextRefresh = "Unknown";
            if (accounts[index].token) {
                const exp = getTokenExpiry(accounts[index].token);
                if (exp) {
                    const diffMins = Math.round((exp - new Date()) / 60000);
                    nextRefresh = diffMins > 0 ? `${exp.toLocaleTimeString()} (${diffMins}m)` : "Expired";
                }
            }

            submitDailyStat({
                name: name,
                pointsBefore: initialPoints,
                pointsAfter: currentPoints,
                matic: maticBalanceVal + " MATIC",
                nextRun: "DONE",
                nextRefresh: nextRefresh
            });

            console.log(chalk.green(`[${name}] ✅ Finished for today.`));

        }); // End accounts.map

        // Wait for ALL accounts to complete
        await Promise.all(accountPromises);

        // PRINT FINAL SUMMARY TABLE (after all parallel tasks done)
        console.log(chalk.magenta(`\n${'═'.repeat(60)}`));
        console.log(chalk.magenta.bold(`📊 DAILY SUMMARY - ${new Date().toLocaleDateString()}`));
        console.log(chalk.magenta(`${'═'.repeat(60)}`));

        // Force print remaining stats
        if (dailyStats.length > 0) {
            const table = new Table({
                head: ['Account', 'Before', 'After', 'MATIC', 'Status', 'Token Refresh'],
                style: { head: ['cyan'] }
            });
            dailyStats.forEach(stat => {
                table.push([stat.name, stat.pointsBefore, stat.pointsAfter, stat.matic, stat.nextRun, stat.nextRefresh]);
            });
            console.log(table.toString());
        }

        const nextRun = getNext730WIB();
        console.log(chalk.gray(`\n💤 Global Sleep until ${nextRun.toLocaleTimeString()}...`));

        // HEARTBEAT LOGIC (Global)
        const nowTime = new Date();
        let remainingTime = nextRun - nowTime;
        const heartbeatInterval = 4 * 60 * 60 * 1000;

        while (remainingTime > 0) {
            const sleepTime = Math.min(remainingTime, heartbeatInterval);
            await new Promise(r => setTimeout(r, sleepTime));
            remainingTime -= sleepTime;

            if (remainingTime > 10000) {
                console.log(chalk.blue(`\n💓 Heartbeat: Pinging server for ALL accounts...`));
                for (let i = 0; i < accounts.length; i++) {
                    const acc = accounts[i];
                    const runName = acc.name || `Account${i + 1}`;
                    // Just ping profile to keep alive
                    let api = createApi(acc);
                    await retryWithBackoff(() => getProfile(api, runName), runName, acc, i);
                }
            }
        }
    }
})();
