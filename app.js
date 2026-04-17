console.log("🚀 [1/6] Iniciando script app.js...");

const path = require('path');
const express = require('express');

// --- CONFIGURACIÓN DE SERVIDOR WEB PARA CLOUD RUN ---
const app = express();
const port = process.env.PORT || 8080;
app.get('/', (req, res) => res.send('🤖 QuindBot está activo y escuchando en la nube!'));
app.listen(port, '0.0.0.0', () => console.log(`🌐 Servidor Express escuchando en 0.0.0.0:${port}`));

console.log("🔑 [2/6] Variables de entorno listas.");

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    Browsers, 
    downloadContentFromMessage 
} = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const { BigQuery } = require('@google-cloud/bigquery');
const pino = require('pino');

// ⚠️ Se eliminó por completo qrcode-terminal para forzar el código de 8 dígitos

console.log("📦 [3/6] Librerías importadas correctamente.");

// 2. CONFIGURACIÓN GCP
const PROJECT_ID = process.env.PROJECT_ID || 'datatest-347114';
const DATA_STORE_ID = process.env.DATA_STORE_ID || 'documentacion-chatbot_1776440842820';
const LOCATION = 'global'; 

// 3. INICIALIZAR SDKs
let ai;
let bigquery;
try {
    ai = new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location: 'us-central1' });
    bigquery = new BigQuery({ projectId: PROJECT_ID });
    console.log("🧠 [4/6] SDK de Google Gen AI y BigQuery inicializados.");
} catch (error) {
    console.error("❌ Error crítico inicializando SDKs:", error);
}

async function consultarDatosCliente(celularUsuario) {
    const numeroLimpio = celularUsuario.split('@')[0];
    const query = `SELECT * FROM \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\` WHERE celular = '${numeroLimpio}' LIMIT 1`;
    try {
        const [rows] = await bigquery.query(query);
        if (rows.length > 0) return JSON.stringify(rows[0]); 
        return "Cliente no encontrado en BD.";
    } catch (error) {
        return "Error al consultar BD.";
    }
}

async function consultarVertex(mensajeUsuario, pdfBase64 = null, datosBigQuery = "") {
    try {
        let promptEnriquecido = `Solicitud del cliente: ${mensajeUsuario}\n\nDatos de BigQuery: ${datosBigQuery}`;
        const parts = [{ text: promptEnriquecido }];
        
        if (pdfBase64) {
            parts.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });
        }

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: parts }],
            config: {
                systemInstruction: `Eres el Motor de Decisión de Riesgo del Banco Quind. Tu comunicación es SINTÉTICA, DIRECTA y TÉCNICA. NADA de saludos extensos ni textos de relleno. Ve directamente a los datos. Usa viñetas.

POLÍTICAS DE CRÉDITO Y CÁLCULOS ESTRICTOS:
1. Capacidad de Pago Mensual (CPM): Calcula los ingresos mensuales (ingresos_12_meses / 12) y réstale los gastos mensuales (egresos_12_meses / 12).
2. Perfil de Riesgo y Mora: Evalúa 'deuda_actual_tarjetas' vs 'cupo_total_tarjetas'. Si la deuda supera el 75% del cupo, el cliente se considera de ALTO RIESGO.
3. Cupo Límite de Crédito:
   - Riesgo Bajo/Medio: CPM * 5.
   - Riesgo Alto: CPM * 2.
   - Si CPM es negativo: CRÉDITO DENEGADO.
4. Tasas de Interés:
   - Saldo promedio > 5,000,000 y Riesgo Bajo: Tasa Fija 1.2% M.V. / Tasa Compuesta 15.3% E.A.
   - Estándar: Tasa Fija 2.2% M.V. / Tasa Compuesta 29.8% E.A.
   - Riesgo Alto: Tasa Fija 2.9% M.V. / Tasa Compuesta 40.9% E.A.

ESTRUCTURA DE TU RESPUESTA (Obligatoria):
- Saludo de 1 línea.
- Viñetas con: Ingresos Mensuales Estimados, Gastos Mensuales, CPM.
- Nivel de Riesgo Determinado (Bajo, Medio, Alto).
- Decisión: Aprobado/Denegado con el Cupo Límite exacto en COP.
- Tasa Fija (M.V.) y Tasa Compuesta (E.A.) aplicables.

REGLA DE FORMATO (ESTRICTA):
Tu respuesta DEBE ser ÚNICAMENTE un objeto JSON.
{
  "clasificacion": "FRAUDE" | "CONSULTA_PRODUCTO" | "SOLICITUD_CREDITO" | "PQR" | "OTRO",
  "respuesta_usuario": "Texto sintetizado..."
}`,
                tools: [{ retrieval: { vertexAiSearch: { datastore: `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/dataStores/${DATA_STORE_ID}` } } }]
            }
        });
        
        return JSON.parse(response.text.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch (error) {
        throw error;
    }
}

// 4. CONEXIÓN WHATSAPP
async function conectarWhatsApp() {
    console.log("🔄 [5/6] Preparando la conexión a WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState('sesion_wa_limpia');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // 🚫 Bloqueamos la generación de QRs
        logger: pino({ level: 'silent' }), 
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    // 🚀 LÓGICA DE VINCULACIÓN CON CÓDIGO (PAIRING CODE)
    if (!sock.authState.creds.registered) {
        const numeroBot = "573003094183"; 
        console.log(`\n⏳ Solicitando código de vinculación a WhatsApp para el número ${numeroBot}...`);
        
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(numeroBot);
                // Le damos formato (ej. ABCD-1234) para que sea fácil de leer
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n======================================================`);
                console.log(`📲 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log(`======================================================\n`);
            } catch (err) {
                console.log("⚠️ Error pidiendo código de vinculación:", err);
            }
        }, 3000); 
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        // Limpiamos la recepción del QR de esta función
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== 401) conectarWhatsApp();
        }
        if (connection === 'open') console.log('\n✅ [6/6] ¡QuindBot ONLINE en WhatsApp!');
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const numeroUsuario = msg.key.remoteJid;
        const m = msg.message;
        
        let textoUsuario = m.conversation || m.extendedTextMessage?.text;
        let pdfBase64 = null;
        let docMessage = m.documentMessage;

        if (m.documentWithCaptionMessage) {
            docMessage = m.documentWithCaptionMessage.message.documentMessage;
        }

        if (docMessage) {
            textoUsuario = docMessage.caption || "Analiza mi perfil para solicitud de crédito con este documento.";
            if (docMessage.mimetype === 'application/pdf') {
                try {
                    const stream = await downloadContentFromMessage(docMessage, 'document');
                    let buffer = Buffer.from([]);
                    for await(const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    pdfBase64 = buffer.toString('base64');
                    if (buffer.length === 0) throw new Error("PDF vacío.");
                } catch (err) {
                    await sock.sendMessage(numeroUsuario, { text: "⚠️ Error técnico: El PDF está dañado o protegido por contraseña." });
                    return;
                }
            } else {
                await sock.sendMessage(numeroUsuario, { text: "⚠️ Formato no soportado. Por favor envía un archivo PDF." });
                return;
            }
        }

        if (textoUsuario || pdfBase64) {
            await sock.sendMessage(numeroUsuario, { text: "⏳ Evaluando perfil de riesgo..." });
            try {
                const datosBigQuery = await consultarDatosCliente(numeroUsuario);
                const respuestaIA = await consultarVertex(textoUsuario, pdfBase64, datosBigQuery);
                await sock.sendMessage(numeroUsuario, { text: respuestaIA.respuesta_usuario });
            } catch (error) {
                await sock.sendMessage(numeroUsuario, { text: "⚠️ Fallo en el motor de riesgo. Contacte a soporte: 01-8000-QUIND." });
            }
        }
    });
}

conectarWhatsApp().catch(err => console.error("💥 ERROR CRÍTICO:", err));