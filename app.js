console.log("🚀 [1/6] Iniciando QuindBot Pro - Asesor Bancario Inteligente...");

const path = require('path');
const express = require('express');

// --- SERVIDOR WEB PARA CLOUD RUN ---
const app = express();
const port = process.env.PORT || 8080;
app.get('/', (req, res) => res.send('🤖 QuindBot Pro está activo!'));
app.listen(port, '0.0.0.0', () => console.log(`🌐 Servidor Express en 0.0.0.0:${port}`));

console.log("🔑 [2/6] Servidor listo.");

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

console.log("📦 [3/6] Librerías importadas.");

// ─────────────────────────────────────────────
// CONFIGURACIÓN GCP
// ─────────────────────────────────────────────
const PROJECT_ID    = process.env.PROJECT_ID    || 'datatest-347114';
const DATA_STORE_ID = process.env.DATA_STORE_ID || 'documentacion-chatbot_1776440842820';
const LOCATION      = 'global';

// ─────────────────────────────────────────────
// INICIALIZAR SDKs
// ─────────────────────────────────────────────
let ai, bigquery;
try {
    ai       = new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location: 'us-central1' });
    bigquery = new BigQuery({ projectId: PROJECT_ID });
    console.log("🧠 [4/6] Google Gen AI y BigQuery inicializados.");
} catch (e) {
    console.error("❌ Error crítico inicializando SDKs:", e);
}

// ─────────────────────────────────────────────
// GESTIÓN DE SESIONES EN MEMORIA
// TTL: 1 hora de inactividad por usuario
// ─────────────────────────────────────────────
const sesiones = new Map();
const TTL_MS   = 60 * 60 * 1000; // 1 hora

function obtenerSesion(numero) {
    const ahora  = Date.now();
    const sesion = sesiones.get(numero);
    if (sesion && (ahora - sesion.ultimaActividad) < TTL_MS) {
        sesion.ultimaActividad = ahora;
        return sesion;
    }
    // Sesión nueva o expirada
    const nueva = { cedula: null, nombre: null, ultimaActividad: ahora };
    sesiones.set(numero, nueva);
    return nueva;
}

function guardarCedulaEnSesion(numero, cedula, nombre = null) {
    const sesion = obtenerSesion(numero);
    sesion.cedula          = cedula;
    sesion.nombre          = nombre || sesion.nombre;
    sesion.ultimaActividad = Date.now();
    sesiones.set(numero, sesion);
    console.log(`💾 Sesión guardada | ${numero.split('@')[0]} → cédula: ${cedula} | nombre: ${nombre}`);
}

// Limpieza periódica cada 30 minutos
setInterval(() => {
    const ahora     = Date.now();
    let eliminadas  = 0;
    for (const [numero, sesion] of sesiones.entries()) {
        if ((ahora - sesion.ultimaActividad) >= TTL_MS) {
            sesiones.delete(numero);
            eliminadas++;
        }
    }
    if (eliminadas > 0) console.log(`🧹 ${eliminadas} sesión(es) expirada(s) eliminada(s).`);
}, 30 * 60 * 1000);

// ─────────────────────────────────────────────
// CONSULTA BIGQUERY: Perfil + Movimientos mensuales (últimos 3 meses)
// ─────────────────────────────────────────────
async function consultarDatosCliente(cedula) {
    const query = `
        WITH movimientos_mensuales AS (
            SELECT
                cedula,
                FORMAT_DATE('%Y-%m', DATE(fecha)) AS mes,
                SUM(CASE WHEN movimiento > 0 THEN movimiento ELSE 0 END)     AS ingresos_mes,
                SUM(CASE WHEN movimiento < 0 THEN ABS(movimiento) ELSE 0 END) AS egresos_mes,
                SUM(movimiento) AS flujo_neto_mes,
                STRING_AGG(
                    CASE WHEN movimiento < 0
                    THEN CONCAT(detalle, ' ($', CAST(ABS(ROUND(movimiento,0)) AS STRING), ')')
                    ELSE NULL END,
                    ' | ' ORDER BY ABS(movimiento) DESC LIMIT 5
                ) AS top_egresos_mes,
                STRING_AGG(
                    CASE WHEN movimiento > 0
                    THEN CONCAT(detalle, ' ($', CAST(ROUND(movimiento,0) AS STRING), ')')
                    ELSE NULL END,
                    ' | ' ORDER BY movimiento DESC LIMIT 3
                ) AS top_ingresos_mes
            FROM \`${PROJECT_ID}.banco_quind.movimientos_cliente\`
            WHERE cedula = '${cedula}'
              AND DATE(fecha) >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 MONTH)
            GROUP BY cedula, mes
        ),
        totales AS (
            SELECT
                cedula,
                SUM(ingresos_mes)      AS ingresos_totales_3m,
                SUM(egresos_mes)       AS egresos_totales_3m,
                AVG(flujo_neto_mes)    AS flujo_neto_promedio,
                COUNT(*)               AS meses_con_datos,
                TO_JSON_STRING(
                    ARRAY_AGG(
                        STRUCT(mes, ingresos_mes, egresos_mes, flujo_neto_mes, top_egresos_mes, top_ingresos_mes)
                        ORDER BY mes DESC
                    )
                ) AS detalle_mensual
            FROM movimientos_mensuales
            GROUP BY cedula
        )
        SELECT
            c.nombres,
            c.apellidos,
            c.cedula,
            COALESCE(t.ingresos_totales_3m, 0)  AS ingresos_totales_3m,
            COALESCE(t.egresos_totales_3m, 0)   AS egresos_totales_3m,
            COALESCE(t.flujo_neto_promedio, 0)  AS flujo_neto_promedio_mensual,
            COALESCE(t.meses_con_datos, 0)      AS meses_con_datos,
            COALESCE(t.detalle_mensual, '[]')   AS detalle_mensual,
            c.deuda_actual_tarjetas,
            c.cupo_total_tarjetas,
            c.saldo_promedio_cuentas
        FROM \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\` c
        LEFT JOIN totales t ON c.cedula = t.cedula
        WHERE c.cedula = '${cedula}'
        LIMIT 1
    `;

    try {
        const [rows] = await bigquery.query(query);
        if (rows.length > 0) {
            console.log(`📊 Datos recuperados: ${rows[0].nombres} ${rows[0].apellidos}`);
            return { estado: 'OK', datos: rows[0] };
        }
        return { estado: 'NO_ENCONTRADO' };
    } catch (error) {
        console.error("❌ Error en BigQuery:", error.message);
        return { estado: 'ERROR', detalle: error.message };
    }
}

// ─────────────────────────────────────────────
// VERTEX AI — ASESOR BANCARIO INTELIGENTE
// ─────────────────────────────────────────────
async function consultarVertex({ mensajeUsuario, datosBQ, sesion, pdfBase64 = null }) {
    try {
        const contextoCliente = sesion?.nombre
            ? `\nCLIENTE EN SESIÓN: ${sesion.nombre} | Cédula: ${sesion.cedula}`
            : '\nCLIENTE: No identificado.';

        const contextoBQ = datosBQ
            ? `\n\n===DATOS FINANCIEROS REALES (BigQuery)===\n${JSON.stringify(datosBQ, null, 2)}`
            : '';

        const parts = [{ text: `${mensajeUsuario}${contextoCliente}${contextoBQ}` }];
        if (pdfBase64) parts.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: `Eres "QuindBot", el asesor bancario personal y experto en riesgo crediticio del Banco Quind. Actúas como un gerente de banco experimentado: analítico, empático, directo y confiable.

════════════════════════════════════
REGLAS DE IDENTIFICACIÓN Y SESIÓN
════════════════════════════════════
- Si el CLIENTE EN SESIÓN ya tiene nombre y cédula: NUNCA pidas la cédula de nuevo. Usa su nombre directamente.
- Si el cliente NO está identificado y lo que pide requiere datos: pide su cédula UNA sola vez.
- Si el cliente inicia conversación sin contexto previo: saluda brevemente y PREGUNTA qué desea hacer. Ofrece estas opciones:
  1. Análisis de perfil crediticio completo
  2. Detalle de ingresos y egresos mes a mes
  3. Simulación de crédito o cuota
  4. Posición salarial vs mercado colombiano
  5. PQR o consulta general

════════════════════════════════════
CAPACIDADES DE ANÁLISIS
════════════════════════════════════

1. PERFIL CREDITICIO COMPLETO (cuando hay datos):
   - Flujo de caja mes a mes: tabla con ingresos, egresos y neto por cada mes
   - Principal fuente de ingresos (qué concepto aporta más)
   - Principal fuente de egresos (qué concepto consume más)
   - Nivel de endeudamiento tarjetas: (deuda / cupo) * 100
     · < 30% → Riesgo BAJO  · 30-75% → Riesgo MEDIO  · > 75% → Riesgo ALTO
   - Capacidad de Pago Mensual (CPM) = flujo_neto_promedio * 0.30
   - Monto de crédito sugerido:
     · Riesgo BAJO:  CPM × 5
     · Riesgo MEDIO: CPM × 3
     · Riesgo ALTO:  CPM × 1.5 (sujeto a comité)

2. ANÁLISIS DE GASTOS DETALLADO:
   - Clasifica los gastos del historial en categorías (nómina, servicios, comercio, transferencias, tarjetas)
   - Identifica gastos hormiga y gastos recurrentes
   - Calcula % del ingreso que va a cada categoría
   - Sugiere oportunidades de ahorro concretas y alcanzables

3. ANÁLISIS SALARIAL Y CURVA DE MERCADO:
   - Si el cliente informa su profesión y años de experiencia:
     · Compara su ingreso observado en BigQuery vs rangos típicos en Colombia
     · Indica cuartil: Q1 (< P25), Q2 (P25-P50), Q3 (P50-P75), Q4 (> P75)
     · Basado en datos del DANE, encuestas salariales colombianas, portales de empleo
     · Comenta perspectivas de crecimiento para su perfil
   - Si el cliente no tiene datos en sesión, pide su ingreso declarado para comparar

4. SIMULACIONES FINANCIERAS:
   - Simulación de cuota de crédito con fórmula de amortización francesa:
     Cuota = P × [r(1+r)^n] / [(1+r)^n - 1]  (r = tasa mensual, n = plazo meses)
   - Proyección de ahorro a X meses con tasa CDT/ahorros
   - Impacto de reducir deuda de tarjeta en el score crediticio
   - Cuánto tiempo para pagar una deuda con X cuota mensual

5. RESPONDE CUALQUIER CONSULTA GENERAL del cliente relacionada con:
   - Productos bancarios (cuentas, tarjetas, CDTs, seguros)
   - Regulación financiera colombiana básica
   - Consejos de educación financiera

════════════════════════════════════
FORMATO DE RESPUESTA (ESTRICTO)
════════════════════════════════════
Responde ÚNICAMENTE con un JSON válido. Sin markdown, sin texto adicional fuera del JSON:
{
  "clasificacion": "BIENVENIDA" | "SOLICITUD_CEDULA" | "ANALISIS_CREDITICIO" | "ANALISIS_GASTOS" | "ANALISIS_SALARIAL" | "SIMULACION" | "PQRS" | "OTRO",
  "nombre_detectado": "nombre completo si aparece en datos BigQuery, sino null",
  "respuesta_usuario": "Tu respuesta como asesor. Usa viñetas, tablas de texto y saltos de línea para claridad. Emojis con moderación."
}`,
                tools: [{
                    retrieval: {
                        vertexAiSearch: {
                            datastore: `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/dataStores/${DATA_STORE_ID}`
                        }
                    }
                }]
            }
        });

        const texto = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(texto);
    } catch (error) {
        console.error("❌ Error en Vertex AI:", error.message);
        throw error;
    }
}

// ─────────────────────────────────────────────
// CONEXIÓN WHATSAPP (BAILEYS)
// ─────────────────────────────────────────────
async function conectarWhatsApp() {
    console.log("🔄 [5/6] Preparando conexión a WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState('sesion_wa_limpia');
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    // Pairing code si no hay sesión
    if (!sock.authState.creds.registered) {
        const numeroBot = "573003094183";
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(numeroBot);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n══════════════════════════════════`);
                console.log(`📲 CÓDIGO DE VINCULACIÓN: ${code}`);
                console.log(`══════════════════════════════════\n`);
            } catch (err) {
                console.error("Error solicitando Pairing Code:", err);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Conexión cerrada (${reason}). Reconectando...`);
            if (reason !== 401) conectarWhatsApp();
        }
        if (connection === 'open') console.log('\n✅ [6/6] ¡QuindBot ONLINE!');
    });

    // ─────────────────────────────────────────────
    // HANDLER DE MENSAJES
    // ─────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];

        console.log(`\n📨 Evento recibido | fromMe: ${msg.key.fromMe}`);
        if (!msg.message || msg.key.fromMe) return;

        const numeroUsuario = msg.key.remoteJid;
        const m             = msg.message;

        // Extracción robusta de texto (cubre todos los tipos de mensajes de Baileys)
        let textoUsuario =
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.ephemeralMessage?.message?.conversation ||
            m.ephemeralMessage?.message?.extendedTextMessage?.text ||
            m.viewOnceMessage?.message?.conversation ||
            m.viewOnceMessage?.message?.extendedTextMessage?.text ||
            m.buttonsResponseMessage?.selectedDisplayText ||
            m.listResponseMessage?.singleSelectReply?.selectedRowId ||
            null;

        let pdfBase64    = null;
        const docMessage =
            m.documentMessage ||
            m.documentWithCaptionMessage?.message?.documentMessage ||
            m.ephemeralMessage?.message?.documentMessage ||
            null;

        // Procesamiento de PDF
        if (docMessage && docMessage.mimetype === 'application/pdf') {
            console.log(`📥 PDF recibido de ${numeroUsuario.split('@')[0]}...`);
            try {
                const stream = await downloadContentFromMessage(docMessage, 'document');
                let buffer   = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                pdfBase64    = buffer.toString('base64');
                textoUsuario = docMessage.caption || "Analiza este extracto bancario.";
                console.log("✅ PDF procesado correctamente.");
            } catch (err) {
                console.error("❌ Error procesando PDF:", err.message);
                await sock.sendMessage(numeroUsuario, { text: "Lo siento, no pude procesar el PDF. ¿Puedes enviarlo nuevamente?" });
                return;
            }
        }

        // Si no hay contenido procesable, logueamos la estructura para diagnóstico
        if (!textoUsuario && !pdfBase64) {
            console.log("⚠️ Sin contenido procesable. Estructura recibida:");
            console.log(JSON.stringify(m, null, 2));
            return;
        }

        console.log(`👤 [${numeroUsuario.split('@')[0]}]: "${textoUsuario}"`);

        // ── Recuperar sesión del usuario ──
        const sesion = obtenerSesion(numeroUsuario);

        // ── Detectar si el mensaje contiene una cédula (7-11 dígitos) ──
        const matchCedula = textoUsuario?.match(/\b\d{7,11}\b/);
        let datosBQ       = null;

        if (matchCedula && !sesion.cedula) {
            // Primera identificación: consultar BigQuery y guardar en sesión
            const cedulaDetectada = matchCedula[0];
            await sock.sendMessage(numeroUsuario, {
                text: `🔍 Consultando tu información para la cédula *${cedulaDetectada}*...`
            });

            const resultado = await consultarDatosCliente(cedulaDetectada);

            if (resultado.estado === 'OK') {
                const nombreCompleto = `${resultado.datos.nombres} ${resultado.datos.apellidos}`;
                guardarCedulaEnSesion(numeroUsuario, cedulaDetectada, nombreCompleto);
                datosBQ = resultado.datos;
            } else if (resultado.estado === 'NO_ENCONTRADO') {
                await sock.sendMessage(numeroUsuario, {
                    text: `⚠️ La cédula *${cedulaDetectada}* no está registrada en nuestra base de datos. Verifica el número e inténtalo de nuevo.`
                });
                return;
            } else {
                await sock.sendMessage(numeroUsuario, {
                    text: `⚠️ Error consultando tu información. Intenta de nuevo en un momento.`
                });
                return;
            }

        } else if (sesion.cedula) {
            // Sesión activa: usar cédula guardada sin pedirla de nuevo
            console.log(`🔄 Sesión activa: usando cédula ${sesion.cedula} (${sesion.nombre})`);
            const resultado = await consultarDatosCliente(sesion.cedula);
            if (resultado.estado === 'OK') {
                datosBQ = resultado.datos;
            }
        }
        // Si no hay cédula ni en mensaje ni en sesión, datosBQ = null
        // y la IA sabrá preguntar qué desea hacer el cliente

        // ── Llamar a Vertex AI ──
        try {
            const respuestaIA = await consultarVertex({
                mensajeUsuario: textoUsuario,
                datosBQ,
                sesion,
                pdfBase64
            });

            console.log(`🤖 Clasificación: ${respuestaIA.clasificacion}`);

            // Actualizar nombre en sesión si la IA lo detectó por primera vez
            if (respuestaIA.nombre_detectado && sesion.cedula && !sesion.nombre) {
                guardarCedulaEnSesion(numeroUsuario, sesion.cedula, respuestaIA.nombre_detectado);
            }

            await sock.sendMessage(numeroUsuario, { text: respuestaIA.respuesta_usuario });

        } catch (error) {
            console.error("❌ Error procesando mensaje:", error.message);
            await sock.sendMessage(numeroUsuario, {
                text: "⚠️ Estoy teniendo dificultades técnicas. Por favor intenta de nuevo en un momento."
            });
        }
    });
}

// INICIO DEL PROGRAMA
console.log("▶️ Iniciando QuindBot...");
conectarWhatsApp().catch(err => console.error("💥 ERROR CRÍTICO:", err));