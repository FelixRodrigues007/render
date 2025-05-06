const express = require('express');
const WebSocket = require('ws');
const app = express();
const port = process.env.PORT || 3000;

// Configuração do Express
app.use(express.json());

// Variáveis globais
let sideswapWs = null;
let messageId = 1;
const pendingRequests = {};
let isConnected = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;

// Função para conectar ao WebSocket do SideSwap
function connectToSideSwap() {
    // Usar o endpoint de testnet (ou troque para produção se necessário)
    const wsUrl = 'wss://api-testnet.sideswap.io/json-rpc-ws';
    console.log(`Tentativa ${reconnectAttempts + 1}: Conectando a ${wsUrl}...`);

    try {
        sideswapWs = new WebSocket(wsUrl);

        sideswapWs.on('open', () => {
            console.log('Conexão WebSocket estabelecida com SideSwap');
            isConnected = true;
            reconnectAttempts = 0;
        });

        sideswapWs.on('message', (data) => {
            try {
                const response = JSON.parse(data.toString());
                console.log('Resposta recebida:', JSON.stringify(response).substring(0, 100) + '...');

                // Se a resposta tem um ID e temos uma promessa pendente para esse ID
                if (response.id && pendingRequests[response.id]) {
                    const { resolve } = pendingRequests[response.id];
                    resolve(response);
                    delete pendingRequests[response.id];
                } else {
                    // console.log('Mensagem recebida sem handler ou é uma notificação.');
                }
            } catch (error) {
                console.error('Erro ao processar mensagem:', error);
            }
        });

        sideswapWs.on('error', (error) => {
            console.error('Erro na conexão WebSocket:', error.message);
            isConnected = false;
            // Tentar reconectar após um erro, se não exceder o limite
            // scheduleReconnect(); // Comentado para evitar loop durante deploy inicial
        });

        sideswapWs.on('close', (code, reason) => {
            console.log(`Conexão WebSocket fechada. Código: ${code}, Motivo: ${reason ? reason.toString() : 'N/A'}`);
            isConnected = false;
            // Tentar reconectar quando a conexão é fechada inesperadamente
            // if (code !== 1000) { // 1000 = Normal closure
            // scheduleReconnect(); // Comentado para evitar loop durante deploy inicial
            // }
        });

    } catch (error) {
        console.error('Erro ao tentar criar WebSocket:', error);
        scheduleReconnect(); // Manter aqui para o caso de falha na criação inicial do WebSocket
    }
}

function scheduleReconnect() {
    if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(30000, reconnectAttempts * 2000); // Aumenta o delay, max 30s
        console.log(`Tentando reconectar em ${delay / 1000} segundos... (Tentativa ${reconnectAttempts}/${maxReconnectAttempts})`);
        setTimeout(connectToSideSwap, delay);
    } else {
        console.error('Número máximo de tentativas de reconexão atingido.');
    }
}

// Função para enviar mensagem e aguardar resposta
function sendMessage(method, params) {
    return new Promise((resolve, reject) => {
        if (!isConnected || !sideswapWs || sideswapWs.readyState !== WebSocket.OPEN) {
            console.error('Conexão WebSocket não está aberta ou disponível.');
            return reject(new Error('Conexão WebSocket não está aberta.'));
        }

        const currentId = messageId++;
        const message = {
            id: currentId,
            method: method,
            params: params
        };

        console.log('Enviando mensagem:', JSON.stringify(message));
        sideswapWs.send(JSON.stringify(message));

        // Armazenar a promessa para resolver quando a resposta chegar
        pendingRequests[currentId] = { resolve, reject };

        // Timeout para a requisição
        setTimeout(() => {
            if (pendingRequests[currentId]) {
                console.error(`Timeout para a requisição ID ${currentId}, método ${method}`);
                reject(new Error(`Timeout para a requisição ${method}`));
                delete pendingRequests[currentId];
            }
        }, 30000); // Timeout de 30 segundos
    });
}

// Rotas da API
app.get('/api/assets', async (req, res) => {
    try {
        const response = await sendMessage('assets', { all_assets: true });
        res.json(response);
    } catch (error) {
        console.error("Erro em /api/assets:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/server-status', async (req, res) => {
    try {
        const response = await sendMessage('server_status', null);
        res.json(response);
    } catch (error) {
        console.error("Erro em /api/server-status:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/markets', async (req, res) => {
    try {
        const response = await sendMessage('market', { list_markets: {} });
        res.json(response);
    } catch (error) {
        console.error("Erro em /api/markets:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send('Servidor intermediário SideSwap está no ar!');
});

// Iniciar conexão com SideSwap ao iniciar o servidor
connectToSideSwap();

// Iniciar o servidor Express
app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${port} e escutando em todos os IPs.`);
});
