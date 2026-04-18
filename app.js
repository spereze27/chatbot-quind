console.log("🚀 [1/6] Iniciando script app.js con Motor Transaccional...");

const path = require('path');
const express = require('express');

// --- CONFIGURACIÓN DE SERVIDOR WEB PARA CLOUD RUN ---
const app = express();
const port = process.env.PORT || 8080;
app.get('/', (req, res) => res.send('🤖 QuindBot Pro (Transaccional) está activo!'));
app.listen(port, '0.0.0.0', () => console.log(`🌐 Servidor Express escuchando en 0.0.0.0:${port}`));

console.log("🔑 [2/6] Variables de entorno y Servidor listos.");

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

/**
 * CONSULTA TRANSACCIONAL: Une el Perfil Maestro con el historial de Movimientos
 */
async function consultarDatosCliente(cedula) {
    const query = `
        WITH resumen_movimientos AS (
            SELECT 
                cedula,
                SUM(CASE WHEN movimiento > 0 THEN movimiento ELSE 0 END) as ingresos_totales,
                SUM(CASE WHEN movimiento < 0 THEN ABS(movimiento) ELSE 0 END) as egresos_totales,
                COUNT(*) as total_transacciones,
                STRING_AGG(CONCAT(fecha, ': ', detalle, ' ($', movimiento, ')'), ' | ' ORDER BY fecha DESC LIMIT 15) as historial_reciente
            FROM \`${PROJECT_ID}.banco_quind.movimientos_cliente\`
            WHERE cedula = '${cedula}'
            GROUP BY cedula
        )
        SELECT 
            c.nombres, c.apellidos, c.cedula,
            COALESCE(m.ingresos_totales, 0) as ingresos_totales,
            COALESCE(m.egresos_totales, 0) as egresos_totales,
            (COALESCE(m.ingresos_totales, 0) - COALESCE(m.egresos_totales, 0)) as flujo_neto_mensual,
            c.deuda_actual_tarjetas, c.cupo_total_tarjetas, c.saldo_promedio_cuentas,
            COALESCE(m.historial_reciente, 'Sin movimientos registrados') as historial_reciente
        FROM \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\` c
        LEFT JOIN resumen_movimientos m ON c.cedula = m.cedula
        WHERE c.cedula = '${cedula}'
        LIMIT 1
    `;

    try {
        const [rows] = await bigquery.query(query);
        if (rows.length > 0) {
            console.log(`📊 Datos maestros y transaccionales recuperados para: ${rows[0].nombres}`);
            return JSON.stringify(rows[0]);
        }
        return "CLIENTE_NO_ENCONTRADO";
    } catch (error) {
        console.error("❌ Error en consulta SQL relacional:", error);
        return "ERROR_BD";
    }
}

/**
 * INTERACCIÓN CON VERTEX AI: Análisis de Riesgo y Asesoría Financiera
 */
async function consultarVertex(mensajeUsuario, pdfBase64 = null, datosBigQuery = "") {
    try {
        let promptEnriquecido = `Solicitud del cliente: ${mensajeUsuario}\n\nDatos Financieros Reales (BigQuery): ${datosBigQuery}`;
        const parts = [{ text: promptEnriquecido }];
        
        if (pdfBase64) {
            parts.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });
        }

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: parts }],
            config: {
                systemInstruction: `Eres el Motor de Decisión de Riesgo y Asesor Financiero del Banco Quind. Tu comunicación es PROFESIONAL, SINTÉTICA y TÉCNICA.

ESTRATEGIA DE RESPUESTA:
1. SI datosBigQuery == "NO_CEDULA": Pide amablemente la cédula para iniciar.
2. SI datosBigQuery == "CLIENTE_NO_ENCONTRADO": Informa que el documento no existe en la base maestra.
3. SI HAY DATOS:
   - Saluda por el Nombre del cliente.
   - Analiza la lista de 'historial_reciente' para detectar patrones (gastos hormiga, nómina, deudas).
   - Calcula la Capacidad de Pago Mensual (CPM) basada en el flujo_neto_mensual.
   - Evalúa Riesgo: Cupo tarjetas vs deuda. (Riesgo Alto si deuda > 75% cupo).
   - Decide crédito: Riesgo Bajo/Medio = CPM * 5 | Riesgo Alto = CPM * 2.

ESTRUCTURA JSON OBLIGATORIA:
{
  "clasificacion": "ANALISIS_GASTOS" | "SOLICITUD_CREDITO" | "PQRS" | "IDENTIFICACION",
  "respuesta_usuario": "Texto con viñetas incluyendo: Resumen de Ingresos/Egresos, Análisis de historial reciente, Nivel de Riesgo y Decisión de Crédito final."
}`,
                tools: [{ retrieval: { vertexAiSearch: { datastore: `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/dataStores/${DATA_STORE_ID}` } } }]
            }
        });
        
        return JSON.parse(response.text.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch (error) {
        console.error("❌ Error en Vertex AI:", error);
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
        printQRInTerminal: false, // Forzamos el uso de Pairing Code
        logger: pino({ level: 'silent' }), 
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    // GENERAR CÓDIGO DE VINCULACIÓN SI NO HAY SESIÓN
    if (!sock.authState.creds.registered) {
        const numeroBot = "573003094183"; 
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(numeroBot);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n======================================================`);
                console.log(`📲 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log(`======================================================\n`);
            } catch (err) {
                console.error("Error pidiendo Pairing Code:", err);
            }
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
        
        let textoUsuario = m.conversation || m.extendedTextMessage?.text || "";
        let pdfBase64 = null;
        let docMessage = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;

        // MANEJO DE PDF
        if (docMessage && docMessage.mimetype === 'application/pdf') {
            console.log(`📥 Procesando PDF de ${numeroUsuario}...`);
            try {
                const stream = await downloadContentFromMessage(docMessage, 'document');
                let buffer = Buffer.from([]);
                for await(const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                pdfBase64 = buffer.toString('base64');
                textoUsuario = docMessage.caption || "Analiza este extracto.";
            } catch (err) {
                console.error("Error descargando PDF:", err);
            }
        }

        if (textoUsuario || pdfBase64) {
            // 🧠 EXTRACCIÓN DE CÉDULA CON REGEX (7 a 11 dígitos)
            const matchCedula = textoUsuario.match(/\b\d{7,11}\b/);
            let datosBigQuery = "";

            if (matchCedula) {
                const cedulaDetectada = matchCedula[0];
                await sock.sendMessage(numeroUsuario, { text: `🔍 Consultando historial para la cédula ${cedulaDetectada}...` });
                datosBigQuery = await consultarDatosCliente(cedulaDetectada);
            } else {
                datosBigQuery = "NO_CEDULA";
            }

            try {
                const respuestaIA = await consultarVertex(textoUsuario, pdfBase64, datosBigQuery);
                await sock.sendMessage(numeroUsuario, { text: respuestaIA.respuesta_usuario });
            } catch (error) {
                await sock.sendMessage(numeroUsuario, { text: "⚠️ Error en el motor de decisión. Intente más tarde." });
            }
        }
    });
}

conectarWhatsApp().catch(err => console.error("💥 ERROR CRÍTICO:", err));