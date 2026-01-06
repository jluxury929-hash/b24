    LOG_HISTORY.unshift(logEntry);
    if (LOG_HISTORY.length > MAX_LOGS) LOG_HISTORY.pop();
    
    // Print to console
    const color = type === 'SUCCESS' ? "\x1b[32m" : type === 'ERROR' ? "\x1b[31m" : "\x1b[36m";
    console.log(`${color}[${type}] ${message}\x1b[0m`);
}

// Override console methods to capture logs
const originalLog = console.log;
const originalError = console.error;

console.log = (msg) => { broadcastLog('INFO', msg); };
console.error = (msg) => { broadcastLog('ERROR', msg); };
console.warn = (msg) => { broadcastLog('WARN', msg); };

const TXT = { green: "\x1b[32m", gold: "\x1b[38;5;220m", reset: "\x1b[0m", red: "\x1b[31m", cyan: "\x1b[36m" };

// --- CONFIGURATION ---
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const EXECUTOR_ADDRESS = process.env.EXECUTOR_ADDRESS;
const PROFIT_RECIPIENT = "0x458f94e935f829DCAD18Ae0A18CA5C3E223B71DE";
const TRADE_ALLOCATION_PERCENT = 80; 
const MIN_BALANCE_THRESHOLD = parseEther("0.001");

const TOKENS = {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

const NETWORKS = {
    BASE: {
        chainId: 8453,
        rpc: [process.env.BASE_RPC, "https://mainnet.base.org", "https://base.llamarpc.com", "https://1rpc.io/base"],
        wss: [
            process.env.BASE_WSS, 
            "wss://base.publicnode.com", 
            "wss://base-rpc.publicnode.com",
            "wss://1rpc.io/base"
        ].filter(Boolean),
        isL2: true
    }
};

const poolIndex = { BASE: 0 };

function sanitize(k) {
    let s = (k || "").trim().replace(/['" \n\r]+/g, '');
    if (!s.startsWith("0x")) s = "0x" + s;
    return s;
}

if (cluster.isPrimary) {
    // --- MASTER PROCESS: API SERVER ---
    originalLog(`${TXT.gold}╔════════════════════════════════════════════════════════╗`);
    originalLog(`║    ⚡ APEX TITAN v87.1 | API DASHBOARD SERVER ONLINE    ║`);
    originalLog(`║    PORT: ${process.env.PORT || 8080} | LOGS: BUFFERED                       ║`);
    originalLog(`╚════════════════════════════════════════════════════════╝${TXT.reset}`);

    const wallet = new Wallet(sanitize(PRIVATE_KEY));
    broadcastLog('SYSTEM', `Wallet Active: ${wallet.address}`);

    // HTTP API Server for Frontend
    const server = http.createServer((req, res) => {
        // CORS Headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.url === '/logs') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(LOG_HISTORY));
        } else if (req.url === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: "ONLINE", 
                workers: Object.keys(cluster.workers).length,
                uptime: process.uptime()
            }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(process.env.PORT || 8080);

    // Spawn Workers
    const cpuCount = Math.min(os.cpus().length, 4);
    for (let i = 0; i < cpuCount; i++) {
        const worker = cluster.fork({ TARGET_CHAIN: 'BASE' });
        
        // Listen for messages from workers to log
        worker.on('message', (msg) => {
            if (msg.type === 'LOG') {
                broadcastLog(msg.level, `[Worker ${worker.id}] ${msg.text}`);
            }
        });
    }

    cluster.on('exit', (worker, code, signal) => {
        broadcastLog('WARN', `Worker ${worker.process.pid} died. Respawning...`);
        cluster.fork({ TARGET_CHAIN: 'BASE' });
    });

} else {
    runWorkerEngine();
}

async function runWorkerEngine() {
    // Helper to send logs to master
    const logToMaster = (level, text) => {
        if (process.send) process.send({ type: 'LOG', level, text });
    };

    const targetChain = 'BASE';
    const config = NETWORKS[targetChain];

    await initializeHighPerformanceEngine(targetChain, config, logToMaster);
}

// --- STARTUP DIAGNOSTIC PING ---
async function executeTestPing(chain, wallet, provider, logger) {
    try {
        logger('INFO', `[${chain}] 🧪 Initiating Startup Ping...`);
        const bal = await provider.getBalance(wallet.address);
        if (bal < parseEther("0.0001")) {
             logger('WARN', `[${chain}] PING FAILED: Low Balance.`);
             return;
        }

        const gasPrice = (await provider.getFeeData()).gasPrice || parseEther("0.1", "gwei");
        const tx = {
            to: wallet.address,
            value: 0n,
            gasLimit: 21000n,
            maxFeePerGas: gasPrice * 120n / 100n,
            maxPriorityFeePerGas: gasPrice,
            chainId: NETWORKS[chain].chainId,
            type: 2
        };

        const res = await wallet.sendTransaction(tx);
        logger('SUCCESS', `[${chain}] ✅ PING SENT! Hash: ${res.hash}`);
    } catch (e) {
        logger('ERROR', `[${chain}] ❌ PING ERROR: ${e.message}`);
    }
}

async function initializeHighPerformanceEngine(name, config, logger) {
    const rpcUrl = config.rpc[poolIndex[name] % config.rpc.length] || config.rpc[0];
    
    // Protocol Fixer
    let rawWssUrl = config.wss[0];
    if (rawWssUrl && rawWssUrl.startsWith('https://')) rawWssUrl = rawWssUrl.replace('https://', 'wss://');
    const wssUrl = rawWssUrl;

    logger('INFO', `[${name}] Connecting via ${rpcUrl}`);

    const network = ethers.Network.from(config.chainId);
    const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
    const wallet = new Wallet(sanitize(PRIVATE_KEY), provider);
    
    // Run Startup Checks
    await executeTestPing(name, wallet, provider, logger);

    const ws = new WebSocket(wssUrl);

    ws.on('open', () => {
        logger('SUCCESS', `[${name}] SpeedStream Connected.`);
        ws.send(JSON.stringify({ 
            jsonrpc: "2.0", 
            id: 1, 
            method: "eth_subscribe", 
            params: ["newPendingTransactions"] 
        }));
    });

    ws.on('message', async (data) => {
        let payload;
        try { payload = JSON.parse(data); } catch (e) { return; }
        if (payload.id === 1) return;

        if (payload.params && payload.params.result) {
            const txHash = payload.params.result;
            // Here you would run your arbitrage logic
            // For dashboard demo purposes, we log occasional activity
            if (Math.random() > 0.95) {
                logger('INFO', `[${name}] Scanning Hash: ${txHash.substring(0,10)}...`);
            }
        }
    });

    ws.on('error', (error) => { 
        logger('ERROR', `[${name}] WS Error: ${error.message}`);
        ws.terminate(); 
    });
    
    ws.on('close', () => { 
        logger('WARN', `[${name}] WS Closed. Reconnecting...`);
        setTimeout(() => initializeHighPerformanceEngine(name, config, logger), 5000); 
    });
}
