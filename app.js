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

// ⚠️ AHORA BUSCAMOS POR CÉDULA, NO POR CELULAR
async function consultarDatosCliente(cedula) {
    // Si tu columna se llama diferente en BigQuery, cámbialo aquí abajo donde dice "cedula ="
    const query = `SELECT * FROM \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\` WHERE cedula = '${cedula}' LIMIT 1`;
    try {
        const [rows] = await bigquery.query(query);
        if (rows.length > 0) return JSON.stringify(rows[0]); 
        return "CLIENTE_NO_ENCONTRADO";
    } catch (error) {
        console.error("Error SQL:", error);
        return "ERROR_BD";
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
                systemInstruction: `Eres el Motor de Decisión de Riesgo del Banco Quind. Tu comunicación es SINTÉTICA, DIRECTA y TÉCNICA. Usa viñetas.

REGLA CERO (IDENTIFICACIÓN OBLIGATORIA):
- Si en los "Datos de BigQuery" recibes el texto "NO_CEDULA", significa que el cliente aún no nos ha dado su documento. Tu ÚNICA respuesta debe ser un saludo cordial pidiéndole que por favor te indique su número de cédula para buscarlo en el sistema. NO calcules nada ni intentes dar tasas.
- Si recibes "CLIENTE_NO_ENCONTRADO", dile formalmente que esa cédula no tiene historial en nuestra base de datos.

POLÍTICAS DE CRÉDITO Y CÁLCULOS ESTRICTOS (Solo aplicar si hay datos financieros):
1. Capacidad de Pago Mensual (CPM): Calcula ingresos mensuales (ingresos_12_meses / 12) menos gastos mensuales (egresos_12_meses / 12).
2. Perfil de Riesgo y Mora: Si 'deuda_actual_tarjetas' supera el 75% del 'cupo_total_tarjetas', el cliente es de ALTO RIESGO.
3. Cupo Límite de Crédito:
   - Riesgo Bajo/Medio: CPM * 5.
   - Riesgo Alto: CPM * 2.
   - Si CPM es negativo: CRÉDITO DENEGADO.
4. Tasas de Interés:
   - Saldo promedio > 5,000,000 y Riesgo Bajo: Tasa Fija 1.2% M.V. / Tasa Compuesta 15.3% E.A.
   - Estándar: Tasa Fija 2.2% M.V. / Tasa Compuesta 29.8% E.A.
   - Riesgo Alto: Tasa Fija 2.9% M.V. / Tasa Compuesta 40.9% E.A.

REGLA DE FORMATO (ESTRICTA):
Tu respuesta DEBE ser ÚNICAMENTE un objeto JSON.
{
  "clasificacion": "CONSULTA_CEDULA" | "FRAUDE" | "SOLICITUD_CREDITO" | "OTRO",
  "respuesta_usuario": "Texto sintetizado según las reglas..."
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
    const { state, saveCreds } = await useMultiFileAuthState('sesion_wa_limpia');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), 
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    if (!sock.authState.creds.registered) {
        const numeroBot = "573003094183"; 
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(numeroBot);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n======================================================`);
                console.log(`📲 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log(`======================================================\n`);
            } catch (err) {}
        }, 3000); 
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
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
            textoUsuario = docMessage.caption || "Analiza este documento.";
            if (docMessage.mimetype === 'application/pdf') {
                try {
                    const stream = await downloadContentFromMessage(docMessage, 'document');
                    let buffer = Buffer.from([]);
                    for await(const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    pdfBase64 = buffer.toString('base64');
                    if (buffer.length === 0) throw new Error("PDF vacío.");
                } catch (err) {
                    await sock.sendMessage(numeroUsuario, { text: "⚠️ Error técnico al leer el PDF." });
                    return;
                }
            }
        }

        if (textoUsuario || pdfBase64) {
            
            // 🧠 EXTRACCIÓN INTELIGENTE DE CÉDULA CON REGEX
            // Busca cualquier número entre 7 y 11 dígitos dentro de lo que escribió el usuario
            const matchCedula = textoUsuario.match(/\b\d{7,11}\b/);
            let datosBigQuery = "";

            if (matchCedula) {
                const cedulaDetectada = matchCedula[0];
                await sock.sendMessage(numeroUsuario, { text: `⏳ Buscando la cédula ${cedulaDetectada} y evaluando perfil...` });
                datosBigQuery = await consultarDatosCliente(cedulaDetectada);
            } else {
                // Si el usuario dijo "hola" y no mandó números, le decimos a Gemini que no hay cédula
                datosBigQuery = "NO_CEDULA";
            }

            try {
                // Si solo dijo "hola", no mandamos la alerta de "Evaluando perfil...", solo le respondemos.
                if (datosBigQuery === "NO_CEDULA") {
                    // Feedback visual en la terminal
                    console.log(`📩 Solicitando cédula a ${numeroUsuario.split('@')[0]}`);
                }

                const respuestaIA = await consultarVertex(textoUsuario, pdfBase64, datosBigQuery);
                await sock.sendMessage(numeroUsuario, { text: respuestaIA.respuesta_usuario });
            } catch (error) {
                await sock.sendMessage(numeroUsuario, { text: "⚠️ Fallo en el motor de riesgo. Contacte a soporte." });
            }
        }
    });
}

conectarWhatsApp().catch(err => console.error("💥 ERROR CRÍTICO:", err));