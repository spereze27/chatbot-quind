console.log("🚀 [1/6] Iniciando QuindBot Pro - Asesor Bancario con Agente Dinámico...");

const express = require('express');

// ─────────────────────────────────────────────
// SERVIDOR WEB PARA CLOUD RUN
// ─────────────────────────────────────────────
const app  = express();
const port = process.env.PORT || 8080;

app.use(express.json());

app.get('/', (req, res) => res.send('🤖 QuindBot Pro está activo!'));

// ── Endpoint interno: recibe alertas de fraude desde server.js (portal web) ──
app.post('/alerta-fraude', async (req, res) => {
    const { celular, cedula, nombre, monto, cuentaDestino, motivo, idTransferencia } = req.body;

    console.log(`\n🚨 [ALERTA-FRAUDE] Recibida | celular: ${celular} | cedula: ${cedula} | monto: ${monto}`);

    if (!celular) {
        return res.status(400).json({ error: 'celular requerido' });
    }
    if (!sockGlobal) {
        return res.status(503).json({ error: 'Bot de WhatsApp no conectado aún' });
    }

    const numeroWA = `57${String(celular).replace(/\D/g, '')}@s.whatsapp.net`;
    const ahora    = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    const saludoLinea = nombre
        ? `Hola *${nombre.split(' ')[0]}*, detectamos una transferencia inusual desde tu cuenta:`
        : `Detectamos una transferencia inusual desde tu cuenta:`;

    const mensajeAlerta =
`🚨 *ALERTA DE SEGURIDAD — La Gran Bancolombia*

${saludoLinea}

💰 *Monto:* $${Number(monto).toLocaleString('es-CO')} COP
🏦 *Cuenta destino:* ${cuentaDestino || 'No especificada'}
⚠️ *Motivo de alerta:* ${motivo || 'Movimiento inusual'}
🕐 *Fecha y hora:* ${ahora}
🔖 *Referencia:* ${idTransferencia ? idTransferencia.slice(0, 8).toUpperCase() : 'N/A'}

¿Fuiste tú quien realizó esta transferencia?

Responde *SÍ* si la reconoces ✅
Responde *NO* si NO la autorizaste 🔒
(bloquearemos tu cuenta de inmediato)`;

    try {
        await sockGlobal.sendMessage(numeroWA, { text: mensajeAlerta });

        const alertaData = {
            pendiente:      true,
            monto,
            cuenta:         cuentaDestino || 'No especificada',
            detalle:        motivo || 'Transferencia inusual',
            idTransferencia,
            cedula,
            nombre:         nombre || null,
            numeroWA,
            timestamp:      Date.now()
        };

        // ── ÍNDICE POR CÉDULA (fuente de verdad principal) ──
        // El JID real de WhatsApp puede diferir del construido con el celular del portal.
        // Guardamos la alerta indexada por cédula para encontrarla sin importar el JID.
        if (cedula) {
            alertasPorCedula.set(String(cedula), alertaData);
            console.log(`📌 Alerta indexada por cédula: ${cedula}`);
        }

        // También guardar en sesión por JID construido (útil si el JID coincide exactamente)
        const sesionExistente = sesiones.get(numeroWA);
        const sesion = sesionExistente || {
            cedula:            cedula || null,
            nombre:            nombre || null,
            celular:           numeroWA,
            ultimaActividad:   Date.now(),
            alertaFraude:      null,
            pendingFraudAlert: null
        };
        if (cedula && !sesion.cedula)  sesion.cedula  = cedula;
        if (nombre && !sesion.nombre)  sesion.nombre  = nombre;
        sesion.alertaFraude    = alertaData;
        sesion.ultimaActividad = Date.now();
        sesiones.set(numeroWA, sesion);

        console.log(`📲 Alerta registrada | JID construido: ${numeroWA} | cédula: ${cedula} | nombre: ${nombre}`);
        res.json({ ok: true, numeroWA });
    } catch (err) {
        console.error('❌ Error enviando alerta WA:', err.message);
        res.status(500).json({ error: err.message });
    }
});

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
const { BigQuery }    = require('@google-cloud/bigquery');
const pino            = require('pino');

console.log("📦 [3/6] Librerías importadas.");

// ─────────────────────────────────────────────
// CONFIGURACIÓN GCP
// ─────────────────────────────────────────────
const PROJECT_ID    = process.env.PROJECT_ID    || 'datatest-347114';
const DATA_STORE_ID = process.env.DATA_STORE_ID || 'documentacion-chatbot_1776440842820';

// ─────────────────────────────────────────────
// INICIALIZAR SDKs
// ─────────────────────────────────────────────
let ai, bigquery;
try {
    ai       = new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location: 'us-central1' });
    bigquery = new BigQuery({ projectId: PROJECT_ID });
    console.log(`🧠 [4/6] SDKs inicializados. PROJECT_ID: ${PROJECT_ID}`);
} catch (e) {
    console.error("❌ Error crítico inicializando SDKs:", e);
}

// ─────────────────────────────────────────────
// GESTIÓN DE SESIONES EN MEMORIA (TTL: 1 hora)
// ─────────────────────────────────────────────
const sesiones = new Map();
const TTL_MS   = 60 * 60 * 1000;

// ─────────────────────────────────────────────
// ÍNDICE DE ALERTAS DE FRAUDE POR CÉDULA
// Clave: cedula (string) → valor: objeto alertaFraude
// Permite encontrar la alerta sin importar el JID de WhatsApp del remitente.
// ─────────────────────────────────────────────
const alertasPorCedula = new Map();

function obtenerSesion(numero) {
    const ahora  = Date.now();
    const sesion = sesiones.get(numero);
    if (sesion) {
        if (sesion.alertaFraude?.pendiente) {
            sesion.ultimaActividad = ahora;
            return sesion;
        }
        if ((ahora - sesion.ultimaActividad) < TTL_MS) {
            sesion.ultimaActividad = ahora;
            return sesion;
        }
    }
    const nueva = {
        cedula:            null,
        nombre:            null,
        celular:           numero,
        ultimaActividad:   ahora,
        alertaFraude:      null,
        pendingFraudAlert: null
    };
    sesiones.set(numero, nueva);
    return nueva;
}

function guardarSesion(numero, datos) {
    const sesion = obtenerSesion(numero);
    Object.assign(sesion, datos);
    sesion.ultimaActividad = Date.now();
    sesiones.set(numero, sesion);
    console.log(`💾 Sesión | ${numero.split('@')[0]} → cédula: ${sesion.cedula} | nombre: ${sesion.nombre}`);
}

// Limpieza periódica cada 30 minutos
setInterval(() => {
    const ahora = Date.now();
    let n = 0;
    for (const [k, v] of sesiones.entries()) {
        if (v.alertaFraude?.pendiente) continue;
        if ((ahora - v.ultimaActividad) >= TTL_MS) { sesiones.delete(k); n++; }
    }
    // Limpiar alertasPorCedula vencidas (> 2 horas sin resolver)
    for (const [ced, a] of alertasPorCedula.entries()) {
        if (!a.pendiente || (ahora - a.timestamp) > 2 * TTL_MS) {
            alertasPorCedula.delete(ced);
        }
    }
    if (n > 0) console.log(`🧹 ${n} sesión(es) expirada(s) eliminada(s).`);
}, 30 * 60 * 1000);

// ─────────────────────────────────────────────
// EJECUTOR DE QUERIES BIGQUERY
// ─────────────────────────────────────────────
async function ejecutarQueryBigQuery(sqlQuery) {
    console.log(`\n📊 Query BigQuery:\n${sqlQuery}`);
    try {
        const [rows] = await bigquery.query(sqlQuery);
        console.log(`✅ Query OK — ${rows.length} fila(s).`);
        return { exito: true, filas: rows, total_filas: rows.length };
    } catch (error) {
        console.error("❌ Error BigQuery:", error.message);
        return { exito: false, error: error.message };
    }
}

// ─────────────────────────────────────────────
// LOOKUP DE CLIENTE POR CÉDULA
// ─────────────────────────────────────────────
async function obtenerClientePorCedula(cedula) {
    const resultado = await ejecutarQueryBigQuery(`
        SELECT nombres, apellidos, cedula, celular,
               deuda_actual_tarjetas, cupo_total_tarjetas,
               saldo_promedio_cuentas, saldo_actual,
               numero_cuenta, estado_cuenta
        FROM \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
        WHERE cedula = '${cedula}'
        LIMIT 1
    `);
    if (resultado.exito && resultado.filas.length > 0) return resultado.filas[0];
    return null;
}

// ─────────────────────────────────────────────
// SOCK GLOBAL
// ─────────────────────────────────────────────
let sockGlobal = null;

// ─────────────────────────────────────────────
// MOTOR DE ALERTAS DE FRAUDE (vía WhatsApp directo)
// Usado cuando el agente detecta fraude en conversación WA
// ─────────────────────────────────────────────
async function enviarAlertaFraude({ cedula, monto, cuenta, detalle, numeroWhatsApp }) {
    console.log(`🚨 Enviando alerta de fraude | cédula: ${cedula} | monto: ${monto}`);

    const cliente            = await obtenerClientePorCedula(cedula);
    const telefonoRegistrado = cliente?.celular
        ? `57${String(cliente.celular).replace(/\D/g, '')}@s.whatsapp.net`
        : null;

    const ahora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    const mensajeAlerta =
`🚨 *ALERTA DE SEGURIDAD — La Gran Bancolombia*

Detectamos una transacción inusual en tu cuenta:

💰 *Monto:* $${Number(monto).toLocaleString('es-CO')} COP
🏦 *Cuenta/Destino:* ${cuenta || 'No especificada'}
📝 *Detalle:* ${detalle || 'Movimiento de alto valor'}
🕐 *Fecha y hora:* ${ahora}

¿Fuiste tú quien realizó esta transacción?

Responde *SÍ* si la reconoces ✅
Responde *NO* si NO la autorizaste 🔒 y bloquearemos tu cuenta de inmediato.`;

    if (sockGlobal) {
        await sockGlobal.sendMessage(numeroWhatsApp, { text: mensajeAlerta });
        if (telefonoRegistrado && telefonoRegistrado !== numeroWhatsApp) {
            await sockGlobal.sendMessage(telefonoRegistrado, { text: mensajeAlerta });
            console.log(`📲 Alerta enviada al teléfono registrado: ${telefonoRegistrado}`);
        }
    }

    const alertaData = { pendiente: true, monto, cuenta, detalle, timestamp: Date.now(), cedula, numeroWA: numeroWhatsApp };
    const sesion = sesiones.get(numeroWhatsApp);
    if (sesion) sesion.alertaFraude = alertaData;
    if (cedula) alertasPorCedula.set(String(cedula), alertaData);
}

// ─────────────────────────────────────────────
// AGENTE DINÁMICO CON FUNCTION CALLING
// ─────────────────────────────────────────────
async function ejecutarAgenteFinanciero({ mensajeUsuario, sesion, pdfBase64 = null }) {

    const systemPrompt = `Eres "QuindBot", el asesor bancario personal y experto en riesgo crediticio del Banco Quind.
Eres analítico, empático y confiable como un gerente de banco experimentado.

ESQUEMA DE BASE DE DATOS (BigQuery, proyecto: ${PROJECT_ID}):
─────────────────────────────────────────────
TABLA 1: \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
  • nombres (STRING), apellidos (STRING), cedula (STRING), celular (STRING)
  • deuda_actual_tarjetas (FLOAT), cupo_total_tarjetas (FLOAT), saldo_promedio_cuentas (FLOAT)
  • saldo_actual (FLOAT) — saldo disponible en la cuenta del portal web
  • numero_cuenta (STRING), estado_cuenta (STRING), fecha_registro (TIMESTAMP)

TABLA 2: \`${PROJECT_ID}.banco_quind.movimientos_cliente\`
  • cedula (STRING), fecha (DATE/TIMESTAMP), detalle (STRING), movimiento (FLOAT)
  • movimiento > 0 = INGRESO | movimiento < 0 = EGRESO

TABLA 3: \`${PROJECT_ID}.banco_quind.transferencias\`
  • cedula_origen (STRING), cuenta_destino (STRING), monto (FLOAT)
  • estado (STRING): COMPLETADA | INVESTIGACION | BLOQUEADA
  • motivo_bloqueo (STRING), fecha (TIMESTAMP)
─────────────────────────────────────────────
CLIENTE EN SESIÓN: ${sesion.nombre || 'No identificado'} | Cédula: ${sesion.cedula || 'No registrada'}

════════════════════════════════════
REGLAS DE COMPORTAMIENTO
════════════════════════════════════
• Si el cliente NO está identificado: saluda y pregunta qué desea hacer. Opciones: análisis crediticio, movimientos, simulación crédito, posición salarial, PQR.
• Si el cliente YA ESTÁ IDENTIFICADO: usa su nombre. NUNCA pidas la cédula de nuevo.
• Para CUALQUIER análisis financiero: usa consultar_bigquery. NO respondas con datos inventados.
• Construye las queries de forma DINÁMICA según lo que pide el usuario.
• Si detectas fraude o transacción inusual: usa registrar_alerta_fraude.
• Para consultar el saldo actual usa el campo saldo_actual de la TABLA 1.

════════════════════════════════════
CAPACIDADES
════════════════════════════════════
1. ANÁLISIS DE MOVIMIENTOS: por mes, por categoría, por rango de fechas, comparativos, tendencias
2. PERFIL CREDITICIO: endeudamiento, CPM = flujo_neto * 0.30, monto crédito (BAJO: CPM×5, MEDIO: CPM×3, ALTO: CPM×1.5)
3. ANÁLISIS SALARIAL: cuartiles Q1-Q4 en mercado colombiano según profesión y experiencia
4. SIMULACIONES: cuota con amortización francesa [P×r(1+r)^n]/[(1+r)^n-1], proyección ahorro
5. DETECCIÓN FRAUDE: transacciones no reconocidas o de alto valor inusual
6. SALDO Y ESTADO DE CUENTA: consulta saldo_actual y estado_cuenta de la tabla de clientes

════════════════════════════════════
FORMATO
════════════════════════════════════
Responde en texto natural directamente al cliente. Usa viñetas y tablas para claridad. Emojis con moderación.`;

    const tools = [{
        functionDeclarations: [
            {
                name: "consultar_bigquery",
                description: "Ejecuta una query SQL en BigQuery para obtener datos financieros reales. Úsala SIEMPRE que necesites datos de movimientos, ingresos, egresos, historial, perfil, saldo o cualquier análisis. Construye la query dinámicamente según lo que pide el usuario.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        query_sql: {
                            type: "STRING",
                            description: `Query SQL estándar BigQuery. Usa nombres completos de tabla: \`${PROJECT_ID}.banco_quind.nombre_tabla\`. Filtra siempre por cedula = '${sesion.cedula || "CEDULA_DEL_CLIENTE"}' cuando aplique. Para meses usa FORMAT_DATE('%Y-%m', DATE(fecha)).`
                        },
                        descripcion: {
                            type: "STRING",
                            description: "Descripción corta de qué analiza esta query"
                        }
                    },
                    required: ["query_sql", "descripcion"]
                }
            },
            {
                name: "registrar_alerta_fraude",
                description: "Registra y envía una alerta de seguridad cuando el cliente menciona una transacción que no reconoce, una transferencia inusual de alto monto, o cualquier movimiento sospechoso.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        monto: {
                            type: "NUMBER",
                            description: "Monto de la transacción sospechosa en pesos colombianos"
                        },
                        cuenta_destino: {
                            type: "STRING",
                            description: "Cuenta, entidad o persona destino de la transacción"
                        },
                        detalle: {
                            type: "STRING",
                            description: "Descripción del movimiento sospechoso"
                        }
                    },
                    required: ["monto"]
                }
            }
        ]
    }];

    const partsInicio = [{ text: mensajeUsuario }];
    if (pdfBase64) partsInicio.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });

    let mensajes = [{ role: 'user', parts: partsInicio }];
    let respuestaFinal = null;
    const MAX_ITER = 6;

    for (let i = 0; i < MAX_ITER; i++) {
        console.log(`\n🔄 Agente — iteración ${i + 1}/${MAX_ITER}`);

        let response;
        try {
            response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: mensajes,
                config: { systemInstruction: systemPrompt, tools }
            });
        } catch (err) {
            console.error("❌ Error Gemini:", err.message);
            throw err;
        }

        const parts        = response.candidates?.[0]?.content?.parts || [];
        const funcionCalls = parts.filter(p => p.functionCall);
        const textoParts   = parts.filter(p => p.text).map(p => p.text).join('');

        if (funcionCalls.length === 0) {
            respuestaFinal = textoParts || "He procesado tu solicitud. ¿Hay algo más en lo que pueda ayudarte?";
            console.log("✅ Respuesta final obtenida.");
            break;
        }

        mensajes.push({ role: 'model', parts });

        const resultados = [];

        for (const part of funcionCalls) {
            const { name, args } = part.functionCall;
            console.log(`🔧 Invocando: ${name}`, JSON.stringify(args).substring(0, 120));

            let resultado = {};

            if (name === 'consultar_bigquery') {
                console.log(`📝 ${args.descripcion}`);
                const bq = await ejecutarQueryBigQuery(args.query_sql);
                resultado = bq.exito
                    ? { exito: true, datos: bq.filas, total_filas: bq.filas.length }
                    : { exito: false, error: bq.error };

            } else if (name === 'registrar_alerta_fraude') {
                const sesActual = sesiones.get(sesion.celular);
                if (sesActual) {
                    sesActual.pendingFraudAlert = {
                        monto:   args.monto,
                        cuenta:  args.cuenta_destino || 'No especificada',
                        detalle: args.detalle || 'Transacción sospechosa'
                    };
                }
                resultado = {
                    registrado: true,
                    mensaje: "Alerta de fraude registrada. Se enviará notificación al cliente."
                };
            }

            resultados.push({ functionResponse: { name, response: resultado } });
        }

        mensajes.push({ role: 'user', parts: resultados });
    }

    return respuestaFinal || "He procesado tu solicitud. ¿En qué más puedo ayudarte?";
}

// ────────────────────────────────────────────
// CONEXIÓN WHATSAPP (BAILEYS)
// ────────────────────────────────────────────
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
    sockGlobal = sock;

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

        console.log(`\n📨 Evento | fromMe: ${msg.key.fromMe}`);
        if (!msg.message || msg.key.fromMe) return;

        const numeroUsuario = msg.key.remoteJid;
        const m             = msg.message;

        // Extracción robusta de texto
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

        if (docMessage && docMessage.mimetype === 'application/pdf') {
            console.log(`📥 PDF recibido...`);
            try {
                const stream = await downloadContentFromMessage(docMessage, 'document');
                let buffer   = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                pdfBase64    = buffer.toString('base64');
                textoUsuario = docMessage.caption || "Analiza este extracto bancario.";
                console.log("✅ PDF procesado.");
            } catch (err) {
                console.error("❌ Error PDF:", err.message);
                await sock.sendMessage(numeroUsuario, { text: "No pude procesar el PDF. ¿Puedes enviarlo de nuevo?" });
                return;
            }
        }

        if (!textoUsuario && !pdfBase64) {
            console.log("⚠️ Sin contenido procesable.");
            console.log(JSON.stringify(m, null, 2));
            return;
        }

        console.log(`👤 [${numeroUsuario.split('@')[0]}]: "${textoUsuario}"`);

        // ════════════════════════════════════════════════════════
        // RESOLUCIÓN DE SESIÓN — 3 capas
        //
        // El JID real de WhatsApp puede ser completamente diferente
        // al número construido con el celular del portal.
        // Ej: Baileys entrega "1406129510885280@s.whatsapp.net"
        //     pero construimos "573053060560@s.whatsapp.net"
        //
        // Capa 1: JID exacto en sesiones
        // Capa 2: Fallback por últimos 10 dígitos del JID
        // Capa 3: Índice alertasPorCedula — busca por cédula de sesión
        //         o por cédula detectada en el texto del mensaje
        // ════════════════════════════════════════════════════════

        // Capa 1: lookup directo sin crear sesión nueva
        let sesion = sesiones.get(numeroUsuario);
        let alertaResuelta = !!sesion?.alertaFraude?.pendiente;

        // Capa 2: fallback por últimos 10 dígitos
        if (!alertaResuelta) {
            const digitos10 = numeroUsuario.replace(/\D/g, '').slice(-10);
            for (const [jid, s] of sesiones.entries()) {
                if (s.alertaFraude?.pendiente) {
                    const jidDigitos = jid.replace(/\D/g, '').slice(-10);
                    if (jidDigitos === digitos10) {
                        sesiones.delete(jid);
                        s.celular = numeroUsuario;
                        sesiones.set(numeroUsuario, s);
                        sesion = s;
                        alertaResuelta = true;
                        console.log(`🔄 Sesión migrada (10 dígitos): ${jid} → ${numeroUsuario}`);
                        break;
                    }
                }
            }
        }

        // Capa 3: índice por cédula
        // Aplica si las capas 1 y 2 no encontraron alerta pendiente.
        // Busca por cédula ya conocida en la sesión, o por cédula detectada en el texto.
        if (!alertaResuelta) {
            if (!sesion) sesion = obtenerSesion(numeroUsuario);

            const cedulaEnMensaje = textoUsuario?.match(/\b\d{7,11}\b/)?.[0];
            const cedulaBusqueda  = sesion.cedula || cedulaEnMensaje;

            if (cedulaBusqueda) {
                const alertaCedula = alertasPorCedula.get(String(cedulaBusqueda));
                if (alertaCedula?.pendiente) {
                    console.log(`🔍 Alerta encontrada vía índice cédula ${cedulaBusqueda} para JID ${numeroUsuario}`);
                    sesion.alertaFraude = alertaCedula;
                    if (!sesion.cedula)  sesion.cedula = String(cedulaBusqueda);
                    if (!sesion.nombre && alertaCedula.nombre) sesion.nombre = alertaCedula.nombre;
                    sesiones.set(numeroUsuario, sesion);
                    alertaResuelta = true;
                }
            }
        }

        // Garantizar que sesion esté inicializada
        if (!sesion) sesion = obtenerSesion(numeroUsuario);

        // ════════════════════════════════════════════════════════
        // HANDLER DE RESPUESTA A ALERTA DE FRAUDE
        // ════════════════════════════════════════════════════════
        if (sesion.alertaFraude?.pendiente) {
            const esNo = /^no\b|no fui|no la reconoc|no la autoriz|no autoriz/i.test(textoUsuario);
            const esSi = /^s[íi]\b|sí fui|si fui|la reconoc|la autoricé|si la hice|si fui yo/i.test(textoUsuario);

            console.log(`🔐 Respuesta fraude | esNo: ${esNo} | esSi: ${esSi} | texto: "${textoUsuario}"`);

            if (esNo) {
                const cedulaFraude = sesion.cedula || sesion.alertaFraude.cedula;
                const idTx         = sesion.alertaFraude.idTransferencia;
                sesion.alertaFraude.pendiente = false;
                if (cedulaFraude) alertasPorCedula.delete(String(cedulaFraude));

                if (cedulaFraude) {
                    try {
                        await ejecutarQueryBigQuery(`
                            UPDATE \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                            SET estado_cuenta = 'BLOQUEADA'
                            WHERE cedula = '${cedulaFraude}'
                        `);
                        console.log(`🔒 Cuenta ${cedulaFraude} bloqueada en BQ`);

                        if (idTx) {
                            await ejecutarQueryBigQuery(`
                                UPDATE \`${PROJECT_ID}.banco_quind.transferencias\`
                                SET estado = 'BLOQUEADA',
                                    motivo_bloqueo = 'Fraude reportado por titular vía WhatsApp'
                                WHERE id_transferencia = '${idTx}'
                            `);
                            console.log(`🔒 Transferencia ${idTx} marcada BLOQUEADA`);
                        }
                    } catch (err) {
                        console.error('❌ Error bloqueando cuenta en BQ:', err.message);
                    }
                }

                await sock.sendMessage(numeroUsuario, {
                    text: `🔒 *Cuenta bloqueada preventivamente.*\n\nTu caso ha sido escalado al equipo de seguridad. Un asesor se comunicará contigo al número registrado.\n\n📞 Línea de fraudes: *018000-QUIND*\n\n¿Necesitas algo más?`
                });
                return;
            }

            if (esSi) {
                const cedulaFraude = sesion.cedula || sesion.alertaFraude.cedula;
                const idTx         = sesion.alertaFraude.idTransferencia;
                sesion.alertaFraude.pendiente = false;
                if (cedulaFraude) alertasPorCedula.delete(String(cedulaFraude));

                if (cedulaFraude) {
                    try {
                        // Reactivar cuenta
                        await ejecutarQueryBigQuery(`
                            UPDATE \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                            SET estado_cuenta = 'ACTIVA'
                            WHERE cedula = '${cedulaFraude}'
                              AND estado_cuenta = 'INVESTIGACION'
                        `);
                        console.log(`✅ Cuenta ${cedulaFraude} reactivada a ACTIVA en BQ`);

                        if (idTx) {
                            // Obtener datos de la transferencia para completar los movimientos
                            const txRows = await ejecutarQueryBigQuery(`
                                SELECT cedula_origen, cedula_destino, cuenta_destino, monto
                                FROM \`${PROJECT_ID}.banco_quind.transferencias\`
                                WHERE id_transferencia = '${idTx}'
                                LIMIT 1
                            `);

                            if (txRows.exito && txRows.filas.length > 0) {
                                const tx = txRows.filas[0];

                                // Marcar transferencia como COMPLETADA
                                await ejecutarQueryBigQuery(`
                                    UPDATE \`${PROJECT_ID}.banco_quind.transferencias\`
                                    SET estado = 'COMPLETADA',
                                        motivo_bloqueo = NULL
                                    WHERE id_transferencia = '${idTx}'
                                `);

                                // Débito al origen
                                await ejecutarQueryBigQuery(`
                                    UPDATE \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                                    SET saldo_actual = saldo_actual - ${tx.monto}
                                    WHERE cedula = '${tx.cedula_origen}'
                                `);

                                // Crédito al destino
                                await ejecutarQueryBigQuery(`
                                    UPDATE \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                                    SET saldo_actual = saldo_actual + ${tx.monto}
                                    WHERE cedula = '${tx.cedula_destino}'
                                `);

                                // Movimiento egreso origen
                                await ejecutarQueryBigQuery(`
                                    INSERT INTO \`${PROJECT_ID}.banco_quind.movimientos_cliente\`
                                    (cedula, fecha, detalle, movimiento)
                                    VALUES ('${tx.cedula_origen}', CURRENT_DATE(),
                                            'Transferencia confirmada a cuenta ${tx.cuenta_destino}',
                                            -${tx.monto})
                                `);

                                // Movimiento ingreso destino
                                await ejecutarQueryBigQuery(`
                                    INSERT INTO \`${PROJECT_ID}.banco_quind.movimientos_cliente\`
                                    (cedula, fecha, detalle, movimiento)
                                    VALUES ('${tx.cedula_destino}', CURRENT_DATE(),
                                            'Transferencia recibida confirmada por titular',
                                            ${tx.monto})
                                `);

                                console.log(`✅ Transferencia ${idTx} completada y saldos actualizados en BQ`);
                            }
                        }
                    } catch (err) {
                        console.error('❌ Error confirmando transferencia en BQ:', err.message);
                    }
                }

                const nombreConfirm = sesion.nombre ? sesion.nombre.split(' ')[0] : 'cliente';
                await sock.sendMessage(numeroUsuario, {
                    text: `✅ Perfecto, *${nombreConfirm}*. Transacción confirmada y validada como autorizada. Tu cuenta está activa y queda registrada en tu historial.\n\n¿Hay algo más en lo que pueda ayudarte?`
                });
                return;
            }

            // Respuesta no reconocida mientras hay alerta pendiente
            await sock.sendMessage(numeroUsuario, {
                text: `Por favor responde *SÍ* si reconoces la transferencia, o *NO* si no la autorizaste.`
            });
            return;
        }

        // ════════════════════════════════════════════════════════
        // FLUJO NORMAL — identificación y agente
        // ════════════════════════════════════════════════════════

        const matchCedula = textoUsuario?.match(/\b\d{7,11}\b/);
        if (matchCedula && !sesion.cedula) {
            const cedulaDetectada = matchCedula[0];
            await sock.sendMessage(numeroUsuario, {
                text: `🔍 Consultando tu información para la cédula *${cedulaDetectada}*...`
            });
            const cliente = await obtenerClientePorCedula(cedulaDetectada);
            if (cliente) {
                guardarSesion(numeroUsuario, {
                    cedula: cedulaDetectada,
                    nombre: `${cliente.nombres} ${cliente.apellidos}`
                });
            } else {
                await sock.sendMessage(numeroUsuario, {
                    text: `⚠️ La cédula *${cedulaDetectada}* no está registrada. Verifica el número e inténtalo de nuevo.`
                });
                return;
            }
        }

        const sesionActual = obtenerSesion(numeroUsuario);

        try {
            const respuesta = await ejecutarAgenteFinanciero({
                mensajeUsuario: textoUsuario,
                sesion: sesionActual,
                pdfBase64
            });

            if (sesionActual.pendingFraudAlert) {
                const { monto, cuenta, detalle } = sesionActual.pendingFraudAlert;
                sesionActual.pendingFraudAlert    = null;
                await enviarAlertaFraude({
                    cedula:        sesionActual.cedula,
                    monto,
                    cuenta,
                    detalle,
                    numeroWhatsApp: numeroUsuario
                });
            }

            await sock.sendMessage(numeroUsuario, { text: respuesta });

        } catch (error) {
            console.error("❌ Error en agente:", error.message);
            await sock.sendMessage(numeroUsuario, {
                text: "⚠️ Estoy teniendo dificultades técnicas. Por favor intenta de nuevo en un momento."
            });
        }
    });
}

// ─────────────────────────────────────────────
// INICIO
// ─────────────────────────────────────────────
console.log("▶️ Iniciando QuindBot...");
conectarWhatsApp().catch(err => console.error("💥 ERROR CRÍTICO:", err));