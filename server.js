const express = require("express");
const WebSocket = require("ws");
const app = express();
const port = process.env.PORT || 3000;

// --- Configuração SideSwap
const SIDESWAP_WS = "wss://api-testnet.sideswap.io/json-rpc-ws";
// Se testnet mudar, ajuste acima!

app.use(express.json());

// -- Globais de conexão WS
let ws = null;
let messageId = 1;
const pending = {};
let isConnected = false;
let reconnectTries = 0;
const MAX_RECONNECT = 10;

// --- Função para conectar WebSocket SideSwap
function connectWS() {
  ws = new WebSocket(SIDESWAP_WS);
  ws.on("open", () => {
    console.log("✅ WebSocket conectado ao SideSwap Testnet!");
    isConnected = true;
    reconnectTries = 0;
  });
  ws.on("close", () => {
    console.log("❌ WS SideSwap desconectado. Reconnect em 2s...");
    isConnected = false;
    setTimeout(() => {
      if (reconnectTries < MAX_RECONNECT) {
        reconnectTries++;
        connectWS();
      }
    }, 2000);
  });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.id && pending[msg.id]) {
        pending[msg.id](msg);
        delete pending[msg.id];
      }
    } catch (e) {
      console.error("Erro WS SideSwap:", e.message);
    }
  });
  ws.on("error", (err) => {
    console.error("Erro WS SideSwap:", err.message);
  });
}
connectWS();

// --- Função utilitária para JSON-RPC
function sendMessage(method, params) {
  return new Promise((resolve, reject) => {
    if (!isConnected) return reject(new Error("WebSocket não conectado ao SideSwap!"));
    const id = messageId++;
    const msg = { id, method, params };
    ws.send(JSON.stringify(msg));
    const timeout = setTimeout(() => {
      delete pending[id];
      reject(new Error(`Timeout para a requisição ${method}`));
    }, 10000);
    pending[id] = (res) => {
      clearTimeout(timeout);
      if (res.error) reject(res.error);
      else resolve(res.result || res);
    };
  });
}

// --- Endpoint: Lista mercados disponíveis (markets)
app.get("/api/markets", async (req, res) => {
  try {
    // SideSwap aceita "markets" ou "list_markets"
    let response;
    try {
      response = await sendMessage("markets", {});
    } catch (e) {
      response = await sendMessage("list_markets", {});
    }
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Endpoint: Cotação instantânea (quote) ---
// Troque o método abaixo ("instant-quote") para "get_quote", "getQuote" ou "quote" conforme a testnet!
app.post("/api/instant-quote", async (req, res) => {
  try {
    const { base_asset, quote_asset, amount, side } = req.body;
    if (!base_asset || !quote_asset || !amount || !side) {
      return res.status(400).json({ error: "Missing required params!" });
    }
    const market_id = `${base_asset.toLowerCase()}_${quote_asset.toLowerCase()}`;
    const params = { market_id, side, amount };
    // TROQUE O NOME DO MÉTODO AQUI SE DER "method not found":
    const response = await sendMessage("instant-quote", params);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Endpoint: DEBUG (opcional, lista métodos suportados)
app.get("/api/help", async (req, res) => {
  try {
    const response = await sendMessage("help", {});
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Inicia servidor Express
app.listen(port, () => {
  console.log(`SideSwap bridge API online na porta ${port}`);
});
