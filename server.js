const express = require("express");
const WebSocket = require("ws");
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Variáveis globais
let sideswapWs = null;
let messageId = 1;
const pendingRequests = {};
let isConnected = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10; // Limite para tentativas de reconexão

// Função para conectar ao WebSocket do SideSwap
function connectToSideSwap() {
    const wsUrl = "wss://api.sideswap.io/json-rpc-ws";
    console.log(`Tentativa ${reconnectAttempts + 1}: Conectando a ${wsUrl}...`);

    try {
        sideswapWs = new WebSocket(wsUrl);

        sideswapWs.on("open", () => {
            console.log("Conexão WebSocket estabelecida com SideSwap");
            isConnected = true;
            reconnectAttempts = 0; // Resetar tentativas ao conectar com sucesso
        });

        sideswapWs.on("message", (data) => {
            try {
                const response = JSON.parse(data.toString());
                console.log("Resposta recebida:", JSON.stringify(response).substring(0, 100) + "...");

                if (response.id && pendingRequests[response.id]) {
                    const { resolve } = pendingRequests[response.id];
                    resolve(response);
                    delete pendingRequests[response.id];
                }
            } catch (error) {
                console.error("Erro ao processar mensagem:", error);
            }
        });

        sideswapWs.on("error", (error) => {
            console.error("Erro na conexão WebSocket:", error.message);
            isConnected = false;
            scheduleReconnect();
        });

        sideswapWs.on("close", (code, reason) => {
            console.log(`Conexão WebSocket fechada. Código: ${code}, Motivo: ${reason ? reason.toString() : "N/A"}`);
            isConnected = false;
            if (code !== 1000) { // 1000 = Normal closure
                scheduleReconnect();
            }
        });

    } catch (error) {
        console.error("Erro ao tentar criar WebSocket:", error);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(30000, reconnectAttempts * 2000); // Máx 30s
        console.log(`Tentando reconectar em ${delay / 1000} segundos... (Tentativa ${reconnectAttempts}/${maxReconnectAttempts})`);
        setTimeout(connectToSideSwap, delay);
    } else {
        console.error("Número máximo de tentativas de reconexão atingido. Não tentaremos mais reconectar automaticamente.");
    }
}

function sendMessage(method, params) {
    return new Promise((resolve, reject) => {
        if (!isConnected || !sideswapWs || sideswapWs.readyState !== WebSocket.OPEN) {
            console.error("Conexão WebSocket não está aberta ou disponível para enviar mensagem.");
            return reject(new Error("Conexão WebSocket não está aberta."));
        }

        const currentId = messageId++;
        const message = {
            id: currentId,
            method: method,
            params: params
        };

        console.log("Enviando mensagem:", JSON.stringify(message));
        sideswapWs.send(JSON.stringify(message));

        pendingRequests[currentId] = { resolve, reject };

        setTimeout(() => {
            if (pendingRequests[currentId]) {
                console.error(`Timeout para a requisição ID ${currentId}, método ${method}`);
                reject(new Error(`Timeout para a requisição ${method}`));
                delete pendingRequests[currentId];
            }
        }, 30000);
    });
}

// Endpoint de listagem de assets
app.get("/api/assets", async (req, res) => {
    try {
        const response = await sendMessage("assets", { all_assets: true });
        res.json(response);
    } catch (error) {
        console.error("Erro em /api/assets:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint de status do servidor
app.get("/api/server-status", async (req, res) => {
    try {
        const response = await sendMessage("server_status", null);
        res.json(response);
    } catch (error) {
        console.error("Erro em /api/server-status:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint de mercados disponíveis
app.get("/api/markets", async (req, res) => {
    try {
        const response = await sendMessage("market", { list_markets: {} });
        res.json(response);
    } catch (error) {
        console.error("Erro em /api/markets:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// NOVO: Endpoint para simulação instantânea de swap (QUOTE)
app.post("/api/instant-quote", async (req, res) => {
    try {
        const { base_asset, quote_asset, amount, side } = req.body;

        // Exemplo: depix -> DePix, lbtc -> L-BTC
        const market_id = `${base_asset.toLowerCase()}_${quote_asset.toLowerCase()}`;

        const params = {
            market_id,
            side, // "buy" ou "sell"
            amount
        };

        const response = await sendMessage("quote", params);

        res.json(response);
    } catch (error) {
        console.error("Erro em /api/instant-quote:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get("/", (req, res) => {
    res.send("Servidor intermediário SideSwap está no ar!");
});

connectToSideSwap();

app.listen(port, "0.0.0.0", () => {
    console.log(`Servidor rodando na porta ${port} e escutando em todos os IPs.`);
});
