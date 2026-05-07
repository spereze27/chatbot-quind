console.log("🚀 [1/6] Iniciando QuindBot Pro - Asesor Bancario con Agente Dinámico...");

const express = require('express');

// ─────────────────────────────────────────────
// SERVIDOR WEB PARA CLOUD RUN
// ─────────────────────────────────────────────
const app  = express();
const port = process.env.PORT || 8080;

app.use(express.json());

app.get('/', (req, res) => res.send('🤖 QuindBot Pro está activo!'));

// ── Endpoint interno: recibe alertas de fraude desde server.js ──
app.post('/alerta-fraude', async (req, res) => {
    const { celular, cedula, nombre, monto, cuentaDestino, motivo, idTransferencia } = req.body;

    console.log(`\n🚨 [ALERTA-FRAUDE] Recibida | celular: ${celular} | cedula: ${cedula} | monto: ${monto}`);

    if (!celular) return res.status(400).json({ error: 'celular requerido' });
    if (!sockGlobal) return res.status(503).json({ error: 'Bot de WhatsApp no conectado aún' });

    const numeroWA = `57${String(celular).replace(/\D/g, '')}@s.whatsapp.net`;
    const ahora    = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    const saludoLinea = nombre
        ? `Hola *${nombre.split(' ')[0]}*, detectamos una transferencia inusual desde tu cuenta:`
        : `Detectamos una transferencia inusual desde tu cuenta:`;

    const mensajeAlerta =
`🚨 *ALERTA DE SEGURIDAD — Banco QUIND*

${saludoLinea}

💰 *Monto:* $${Number(monto).toLocaleString('es-CO')} COP
🏦 *Cuenta destino:* ${cuentaDestino || 'No especificada'}
⚠️ *Motivo de alerta:* ${motivo || 'Movimiento inusual'}
🕐 *Fecha y hora:* ${ahora}
🔖 *Referencia:* ${idTransferencia ? idTransferencia.slice(0, 8).toUpperCase() : 'N/A'}

¿Fuiste tú quien realizó esta transferencia?

Por favor selecciona una opción 👇`;

    try {
        await sockGlobal.sendMessage(numeroWA, {
            text: mensajeAlerta + `\n\n*1.* Sí, fui yo
*2.* No, bloquear mi cuenta

Responde *1* o *2*`
        });

        // Si no tenemos cédula, pedir que la ingrese (no podemos identificarlos sin ella)
        if (!cedula) {
            await sockGlobal.sendMessage(numeroWA, {
                text: `Para gestionar tu caso necesitamos verificar tu identidad.\n\nPor favor escribe tu *número de cédula* 👇`
            });
        }

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

        // Índice por cédula (fuente de verdad principal)
        if (cedula) {
            alertasPorCedula.set(String(cedula), alertaData);
            console.log(`📌 Alerta indexada por cédula: ${cedula}`);
        }

        // También guardar en sesión por JID construido
        const sesionExistente = sesiones.get(numeroWA);
        const sesion = sesionExistente || {
            cedula:            cedula || null,
            nombre:            nombre || null,
            celular:           numeroWA,
            ultimaActividad:   Date.now(),
            alertaFraude:      null,
            pendingFraudAlert: null
        };
        if (cedula && !sesion.cedula) sesion.cedula = cedula;
        if (nombre && !sesion.nombre) sesion.nombre = nombre;
        sesion.alertaFraude    = alertaData;
        sesion.ultimaActividad = Date.now();
        sesiones.set(numeroWA, sesion);

        console.log(`📲 Alerta registrada | JID: ${numeroWA} | cédula: ${cedula} | nombre: ${nombre}`);
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
// ÍNDICE DE ALERTAS POR CÉDULA
// Resuelve el mismatch de JID entre portal y WA real
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
        pendingFraudAlert: null,
        historial:         [],   // ← Historial de mensajes para Gemini (multi-turn)
        presentado:        false // ← true después del primer saludo del bot
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
    for (const [ced, a] of alertasPorCedula.entries()) {
        if (!a.pendiente || (ahora - a.timestamp) > 2 * TTL_MS) alertasPorCedula.delete(ced);
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
// ENVÍO DE MENÚ PRINCIPAL CON BOTONES
// ─────────────────────────────────────────────
async function enviarMenuPrincipal(jid, identificado = false, nombre = null) {
    const saludo = identificado && nombre
        ? `¡Hola de nuevo, *${nombre.split(' ')[0]}*! 👋`
        : `¡Hola! 👋 Soy *QuindBot*, tu asesor bancario personal del *Banco QUIND*.`;

    const pie = identificado
        ? `¿En qué puedo ayudarte hoy?\n\nElige una opción o escríbeme directamente:`
        : `Escribe tu *número de cédula* para acceder a tu información, o elige una opción:`;

    await sockGlobal.sendMessage(jid, {
        text:
`${saludo}

${pie}

*1.* Análisis crediticio
*2.* Movimientos
*3.* Simulación de crédito
*4.* Posición salarial
*5.* PQR (Peticiones, Quejas o Reclamos)
*6.* Solicitar producto

_Responde con el número o escribe tu consulta directamente_`
    });
}

// ─────────────────────────────────────────────
// MOTOR DE ALERTAS DE FRAUDE (desde el agente WA)
// ─────────────────────────────────────────────
async function enviarAlertaFraude({ cedula, monto, cuenta, detalle, numeroWhatsApp }) {
    console.log(`🚨 Enviando alerta de fraude | cédula: ${cedula} | monto: ${monto}`);

    const cliente            = await obtenerClientePorCedula(cedula);
    const telefonoRegistrado = cliente?.celular
        ? `57${String(cliente.celular).replace(/\D/g, '')}@s.whatsapp.net`
        : null;

    const ahora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    const mensajeAlerta =
`🚨 *ALERTA DE SEGURIDAD — Banco QUIND*

Detectamos una transacción inusual en tu cuenta:

💰 *Monto:* $${Number(monto).toLocaleString('es-CO')} COP
🏦 *Cuenta/Destino:* ${cuenta || 'No especificada'}
📝 *Detalle:* ${detalle || 'Movimiento de alto valor'}
🕐 *Fecha y hora:* ${ahora}

¿Fuiste tú quien realizó esta transacción?`;

    if (sockGlobal) {
        const textoAlerta = mensajeAlerta + `\n\n*1.* Sí, fui yo
*2.* No, bloquear mi cuenta

Responde *1* o *2*`;
        await sockGlobal.sendMessage(numeroWhatsApp, { text: textoAlerta });
        if (telefonoRegistrado && telefonoRegistrado !== numeroWhatsApp) {
            await sockGlobal.sendMessage(telefonoRegistrado, { text: textoAlerta });
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

    // ── Indicadores de contexto conversacional para el system prompt ──
    const yaIdentificado   = !!sesion.cedula;
    const yaPresentado     = !!sesion.presentado;
    const turnosActivos    = sesion.historial ? Math.floor(sesion.historial.length / 2) : 0;
    const contextoConvStr  = turnosActivos > 0
        ? `Llevas ${turnosActivos} turno(s) de conversación con este cliente en esta sesión.`
        : 'Este es el primer mensaje del cliente en esta sesión.';

    const systemPrompt = `Eres "QuindBot", el asesor bancario personal y experto en riesgo crediticio del Banco QUIND.
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
ESTADO DE LA SESIÓN:
  • Cliente: ${sesion.nombre || 'No identificado'} | Cédula: ${sesion.cedula || 'No registrada'}
  • Ya te presentaste en esta sesión: ${yaPresentado ? 'SÍ — NO vuelvas a presentarte ni a saludar formalmente' : 'NO — puedes saludar brevemente si es el primer mensaje'}
  • ${contextoConvStr}

════════════════════════════════════
REGLAS DE COMPORTAMIENTO
════════════════════════════════════
• TONO CONVERSACIONAL: Responde de forma natural y concisa. NO repitas saludos formales ni te presentes de nuevo si ya lo hiciste. Continúa la conversación como un asesor que ya conoce al cliente.
• Si el cliente NO está identificado: indica amablemente que puede escribir su cédula para acceder a su información.
• Si el cliente YA ESTÁ IDENTIFICADO: usa su nombre de pila ocasionalmente. NUNCA pidas la cédula de nuevo.
• Para CUALQUIER análisis financiero: usa consultar_bigquery. NO respondas con datos inventados.
• Construye las queries de forma DINÁMICA según lo que pide el usuario.
• Si detectas fraude o transacción inusual: usa registrar_alerta_fraude.
• SALDO: NUNCA muestres saldo_actual espontáneamente. Solo si el cliente pregunta EXPLÍCITAMENTE por su saldo.
• DESBLOQUEO DE CUENTA: Si el cliente pide desbloquear su cuenta, usa actualizar_estado_cuenta para cambiar a 'ACTIVA'. Solo si estado es 'INVESTIGACION'. Si está 'BLOQUEADA' por fraude confirmado, indica que debe llamar al 018000-QUIND.
• NO incluyas listas de opciones numeradas al final de tus respuestas salvo que el cliente lo pida. Responde directamente lo que se preguntó.

════════════════════════════════════
TARJETAS DE CRÉDITO — CATÁLOGO Y LÓGICA DE OFERTA
════════════════════════════════════
El Banco QUIND ofrece tres tarjetas. Cuando el cliente pregunte por tarjetas, compáralas y recomienda la más adecuada según su perfil:

TARJETA GOLD (perfil BÁSICO — saldo_promedio > $500K, antigüedad ≥ 3 meses):
  • Beneficio estrella: SIN cuota de manejo
  • Cuotas sin interés en comercios aliados
  • App de control de gastos
  • Cupo máximo: $3.000.000

TARJETA PLATINO (perfil MEDIO — saldo_promedio > $2M):
  • Beneficio estrella: Acumula 2 PUNTOS COLOMBIA por cada $1.000 gastado
  • Seguro de viaje internacional incluido
  • Acceso a salas VIP en aeropuertos
  • Cupo máximo: $8.000.000

TARJETA BLACK (perfil ALTO — saldo_promedio > $5M, deuda < 30% cupo):
  • Beneficio estrella: 2% CASHBACK en TODAS las compras, abonado directo a la cuenta
  • Concierge personal 24/7
  • Cupo máximo: $15.000.000

REGLA DE RECOMENDACIÓN:
  1. Consulta el perfil del cliente con consultar_bigquery
  2. Determina su nivel (BÁSICO/MEDIO/ALTO) según saldo_promedio y deuda
  3. Recomienda la tarjeta más alta que califica, y explica los beneficios de cada una
  4. Si el cliente elige una tarjeta superior a su perfil, explica qué necesita mejorar
  5. Usa solicitar_producto con el tipo: TARJETA_GOLD | TARJETA_PLATINO | TARJETA_BLACK
  
CRÉDITO DE CONSUMO:
  • Monto máximo = CPM × 12 (plazo hasta 36 meses)
  • Requiere: cuenta activa > 6 meses Y deuda actual < 40% ingresos
  
CRÉDITO DE VIVIENDA:
  • Monto máximo = CPM × 60 (plazo hasta 15 años)
  • Requiere: cuenta activa > 12 meses Y deuda actual < 30% ingresos Y saldo_promedio > $3M

Al evaluar: consulta BigQuery para obtener ingresos reales de los últimos 3 meses.
Comunica el resultado de forma clara: producto aprobado, cupo/monto asignado, condiciones.
Si se deniega, explica por qué y qué necesita mejorar.

════════════════════════════════════
CAPACIDADES
════════════════════════════════════
1. ANÁLISIS DE MOVIMIENTOS: por mes, por categoría, por rango de fechas, comparativos, tendencias
2. PERFIL CREDITICIO: endeudamiento, CPM, scoring
3. ANÁLISIS SALARIAL: cuartiles Q1-Q4 en mercado colombiano
4. SIMULACIONES: amortización francesa [P×r(1+r)^n]/[(1+r)^n-1], proyección ahorro
5. DETECCIÓN FRAUDE: transacciones no reconocidas
6. SALDO Y ESTADO: saldo_actual y estado_cuenta
7. SOLICITUD PRODUCTOS: tarjeta crédito, crédito consumo, crédito vivienda

════════════════════════════════════
FORMATO
════════════════════════════════════
Responde en texto natural y conversacional. Usa viñetas y tablas solo cuando aporten claridad real.
Emojis con moderación. NO incluyas instrucciones sobre botones — el sistema los agrega automáticamente.
NO repitas el menú de opciones al final de cada respuesta. Si ya respondiste la consulta, termina ahí o pregunta brevemente si hay algo más.`;

    const tools = [{
        functionDeclarations: [
            {
                name: "consultar_bigquery",
                description: "Ejecuta una query SQL en BigQuery para obtener datos financieros reales.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        query_sql: {
                            type: "STRING",
                            description: `Query SQL BigQuery. Tablas con prefijo \`${PROJECT_ID}.banco_quind.\`. Filtra por cedula = '${sesion.cedula || "CEDULA_DEL_CLIENTE"}' cuando aplique.`
                        },
                        descripcion: { type: "STRING", description: "Descripción corta de la query" }
                    },
                    required: ["query_sql", "descripcion"]
                }
            },
            {
                name: "registrar_alerta_fraude",
                description: "Registra alerta de seguridad cuando el cliente menciona una transacción no reconocida.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        monto:          { type: "NUMBER", description: "Monto de la transacción sospechosa" },
                        cuenta_destino: { type: "STRING", description: "Cuenta o entidad destino" },
                        detalle:        { type: "STRING", description: "Descripción del movimiento sospechoso" }
                    },
                    required: ["monto"]
                }
            },
            {
                name: "actualizar_estado_cuenta",
                description: "Actualiza el estado de la cuenta del cliente en BigQuery. Usar para desbloquear una cuenta en INVESTIGACION (→ ACTIVA). NO usar para desbloquear cuentas en estado BLOQUEADA por fraude confirmado.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        nuevo_estado: {
                            type: "STRING",
                            description: "Nuevo estado: ACTIVA | INVESTIGACION | BLOQUEADA"
                        },
                        motivo: {
                            type: "STRING",
                            description: "Motivo del cambio de estado (para logs)"
                        }
                    },
                    required: ["nuevo_estado"]
                }
            },
            {
                name: "solicitar_producto",
                description: "Evalúa y procesa la solicitud de un producto financiero (tarjeta de crédito, crédito de consumo, crédito de vivienda). Usa consultar_bigquery primero para obtener los datos del cliente.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        tipo_producto: {
                            type: "STRING",
                            description: "Tipo de producto: TARJETA_CREDITO | CREDITO_CONSUMO | CREDITO_VIVIENDA"
                        },
                        cupo_aprobado:   { type: "NUMBER", description: "Monto de cupo o crédito aprobado en COP (0 si denegado)" },
                        nivel_perfil:    { type: "STRING", description: "ALTO | MEDIO | BASICO | DENEGADO" },
                        motivo_decision: { type: "STRING", description: "Explicación de la decisión tomada" },
                        cpm_calculado:   { type: "NUMBER", description: "Capacidad de pago mensual calculada" }
                    },
                    required: ["tipo_producto", "cupo_aprobado", "nivel_perfil", "motivo_decision"]
                }
            }
        ]
    }];

    const partsInicio = [{ text: mensajeUsuario }];
    if (pdfBase64) partsInicio.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });

    // ── HISTORIAL MULTI-TURN: incluir mensajes previos de la sesión ──
    // Limitar a los últimos 20 turnos (10 pares user/model) para no exceder el contexto
    const historialPrevio = (sesion.historial || []).slice(-20);
    let mensajes = [...historialPrevio, { role: 'user', parts: partsInicio }];

    let respuestaFinal  = null;
    let productoResult  = null;
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

            // ── Guardar el turno en el historial de la sesión ──
            if (!sesion.historial) sesion.historial = [];
            sesion.historial.push({ role: 'user',  parts: partsInicio });
            sesion.historial.push({ role: 'model', parts: [{ text: respuestaFinal }] });
            // Marcar que el bot ya se presentó en esta sesión
            sesion.presentado = true;

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
                resultado = { registrado: true, mensaje: "Alerta de fraude registrada." };

            } else if (name === 'actualizar_estado_cuenta') {
                if (!sesion.cedula) {
                    resultado = { exito: false, error: 'No hay cédula en sesión para actualizar' };
                } else {
                    const estadoActualRows = await ejecutarQueryBigQuery(`
                        SELECT estado_cuenta FROM \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                        WHERE cedula = '${sesion.cedula}' LIMIT 1
                    `);
                    const estadoActual = estadoActualRows.filas?.[0]?.estado_cuenta;

                    // No permitir desbloqueo si está BLOQUEADA por fraude confirmado
                    if (args.nuevo_estado === 'ACTIVA' && estadoActual === 'BLOQUEADA') {
                        resultado = {
                            exito:   false,
                            bloqueada_fraude: true,
                            mensaje: 'Cuenta bloqueada por fraude confirmado. El cliente debe llamar al 018000-QUIND.'
                        };
                    } else {
                        const bq = await ejecutarQueryBigQuery(`
                            UPDATE \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                            SET estado_cuenta = '${args.nuevo_estado}'
                            WHERE cedula = '${sesion.cedula}'
                        `);
                        if (bq.exito) {
                            console.log(`✅ Estado cuenta ${sesion.cedula}: ${estadoActual} → ${args.nuevo_estado} | motivo: ${args.motivo || 'solicitud del cliente'}`);
                            resultado = { exito: true, estado_anterior: estadoActual, estado_nuevo: args.nuevo_estado };
                        } else {
                            resultado = { exito: false, error: bq.error };
                        }
                    }
                }

            } else if (name === 'solicitar_producto') {
                // Guardar resultado del producto para registrarlo en BQ después
                productoResult = { ...args, cedula: sesion.cedula };
                resultado = { registrado: true, aprobado: args.cupo_aprobado > 0 };
            }

            resultados.push({ functionResponse: { name, response: resultado } });
        }

        mensajes.push({ role: 'user', parts: resultados });
    }

    // Registrar la solicitud de producto en BigQuery si el agente la procesó
    if (productoResult && productoResult.cedula) {
        try {
            await ejecutarQueryBigQuery(`
                INSERT INTO \`${PROJECT_ID}.banco_quind.solicitudes_productos\`
                (cedula, tipo_producto, cupo_aprobado, nivel_perfil, motivo_decision, cpm_calculado, fecha_solicitud, estado)
                VALUES (
                    '${productoResult.cedula}',
                    '${productoResult.tipo_producto}',
                    ${productoResult.cupo_aprobado || 0},
                    '${productoResult.nivel_perfil}',
                    '${(productoResult.motivo_decision || '').replace(/'/g, "\\'")}',
                    ${productoResult.cpm_calculado || 0},
                    CURRENT_TIMESTAMP(),
                    '${productoResult.cupo_aprobado > 0 ? 'APROBADA' : 'DENEGADA'}'
                )
            `);
            console.log(`📋 Solicitud producto registrada en BQ | cédula: ${productoResult.cedula} | tipo: ${productoResult.tipo_producto}`);
        } catch (err) {
            console.error('⚠️ No se pudo registrar solicitud en BQ (tabla puede no existir aún):', err.message);
        }
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

        // Extracción robusta de texto — lista interactiva tiene prioridad sobre texto libre
        let textoUsuario =
            m.listResponseMessage?.singleSelectReply?.selectedRowId ||  // ← lista interactiva (rowId)
            m.buttonsResponseMessage?.selectedButtonId ||                // botón (Business)
            m.buttonsResponseMessage?.selectedDisplayText ||
            m.templateButtonReplyMessage?.selectedId ||
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.ephemeralMessage?.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
            m.ephemeralMessage?.message?.conversation ||
            m.ephemeralMessage?.message?.extendedTextMessage?.text ||
            m.ephemeralMessage?.message?.buttonsResponseMessage?.selectedButtonId ||
            m.viewOnceMessage?.message?.conversation ||
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
            return;
        }

        console.log(`👤 [${numeroUsuario.split('@')[0]}]: "${textoUsuario}"`);

        // ════════════════════════════════════════════════════════
        // RESOLUCIÓN DE SESIÓN — 3 capas
        // ════════════════════════════════════════════════════════

        // Capa 1: JID exacto
        let sesion = sesiones.get(numeroUsuario);
        let alertaResuelta = !!sesion?.alertaFraude?.pendiente;

        // Capa 2: fallback por últimos 10 dígitos
        if (!alertaResuelta) {
            const digitos10 = numeroUsuario.replace(/\D/g, '').slice(-10);
            for (const [jid, s] of sesiones.entries()) {
                if (s.alertaFraude?.pendiente) {
                    if (jid.replace(/\D/g, '').slice(-10) === digitos10) {
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
        if (!alertaResuelta) {
            if (!sesion) sesion = obtenerSesion(numeroUsuario);
            const cedulaEnMensaje = textoUsuario?.match(/\b\d{7,11}\b/)?.[0];
            const cedulaBusqueda  = sesion.cedula || cedulaEnMensaje;
            if (cedulaBusqueda) {
                const alertaCedula = alertasPorCedula.get(String(cedulaBusqueda));
                if (alertaCedula?.pendiente) {
                    console.log(`🔍 Alerta encontrada vía índice cédula ${cedulaBusqueda}`);
                    sesion.alertaFraude = alertaCedula;
                    if (!sesion.cedula)  sesion.cedula = String(cedulaBusqueda);
                    if (!sesion.nombre && alertaCedula.nombre) sesion.nombre = alertaCedula.nombre;
                    sesiones.set(numeroUsuario, sesion);
                    alertaResuelta = true;
                }
            }
        }

        if (!sesion) sesion = obtenerSesion(numeroUsuario);

        // ════════════════════════════════════════════════════════
        // HANDLER DE ALERTA DE FRAUDE PENDIENTE
        // ════════════════════════════════════════════════════════
        if (sesion.alertaFraude?.pendiente) {
            // Normalizar: aceptar tanto ID de botón, número (1/2) como texto libre
            const texto = textoUsuario.toLowerCase().trim();
            const esNo  = texto === 'fraude_no' || texto === '2' ||
                          /^no\b|no fui|no la reconoc|no la autoriz|no autoriz|bloquear/i.test(textoUsuario);
            const esSi  = texto === 'fraude_si' || texto === '1' ||
                          /^s[íi]\b|sí fui|si fui|la reconoc|la autoricé|si la hice|si fui yo|fui yo/i.test(textoUsuario);

            console.log(`🔐 Respuesta fraude | esNo: ${esNo} | esSi: ${esSi} | texto: "${textoUsuario}"`);

            // Si aún no tenemos cédula, pedirla antes de actuar
            if (!sesion.cedula && !sesion.alertaFraude.cedula) {
                const cedulaEnTexto = textoUsuario?.match(/\b\d{7,11}\b/)?.[0];
                if (cedulaEnTexto) {
                    // Validar que la cédula existe
                    const cliente = await obtenerClientePorCedula(cedulaEnTexto);
                    if (cliente) {
                        sesion.cedula = cedulaEnTexto;
                        sesion.nombre = `${cliente.nombres} ${cliente.apellidos}`;
                        sesion.alertaFraude.cedula = cedulaEnTexto;
                        alertasPorCedula.set(cedulaEnTexto, sesion.alertaFraude);
                        await sock.sendMessage(numeroUsuario, {
                            text: `✅ Identidad verificada, *${cliente.nombres}*.\n\n¿Esta transferencia fue realizada por ti?\n\n*1.* Sí, fui yo
*2.* No, bloquear mi cuenta

Responde *1* o *2*`
                        });
                    } else {
                        await sock.sendMessage(numeroUsuario, {
                            text: `⚠️ No encontré esa cédula. Por favor escribe tu número de cédula correcto para verificar tu identidad.`
                        });
                    }
                    return;
                } else {
                    await sock.sendMessage(numeroUsuario, {
                        text: `Para procesar tu respuesta necesito verificar tu identidad.\n\nPor favor escribe tu *número de cédula* 👇`
                    });
                    return;
                }
            }

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
                    text: `🔒 *Cuenta bloqueada preventivamente.*\n\nTu caso ha sido escalado al equipo de seguridad. Un asesor se comunicará contigo al número registrado.\n\n📞 Línea de fraudes: *018000-QUIND*`
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
                        await ejecutarQueryBigQuery(`
                            UPDATE \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                            SET estado_cuenta = 'ACTIVA'
                            WHERE cedula = '${cedulaFraude}'
                              AND estado_cuenta = 'INVESTIGACION'
                        `);
                        console.log(`✅ Cuenta ${cedulaFraude} reactivada a ACTIVA`);

                        if (idTx) {
                            const txRows = await ejecutarQueryBigQuery(`
                                SELECT cedula_origen, cedula_destino, cuenta_destino, monto
                                FROM \`${PROJECT_ID}.banco_quind.transferencias\`
                                WHERE id_transferencia = '${idTx}' LIMIT 1
                            `);
                            if (txRows.exito && txRows.filas.length > 0) {
                                const tx = txRows.filas[0];
                                await ejecutarQueryBigQuery(`
                                    UPDATE \`${PROJECT_ID}.banco_quind.transferencias\`
                                    SET estado = 'COMPLETADA', motivo_bloqueo = NULL
                                    WHERE id_transferencia = '${idTx}'
                                `);
                                await ejecutarQueryBigQuery(`
                                    UPDATE \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                                    SET saldo_actual = saldo_actual - ${tx.monto}
                                    WHERE cedula = '${tx.cedula_origen}'
                                `);
                                await ejecutarQueryBigQuery(`
                                    UPDATE \`${PROJECT_ID}.banco_quind.clientes_riesgo_chatbot\`
                                    SET saldo_actual = saldo_actual + ${tx.monto}
                                    WHERE cedula = '${tx.cedula_destino}'
                                `);
                                await ejecutarQueryBigQuery(`
                                    INSERT INTO \`${PROJECT_ID}.banco_quind.movimientos_cliente\`
                                    (cedula, fecha, detalle, movimiento)
                                    VALUES ('${tx.cedula_origen}', CURRENT_DATE(),
                                            'Transferencia confirmada a cuenta ${tx.cuenta_destino}', -${tx.monto})
                                `);
                                await ejecutarQueryBigQuery(`
                                    INSERT INTO \`${PROJECT_ID}.banco_quind.movimientos_cliente\`
                                    (cedula, fecha, detalle, movimiento)
                                    VALUES ('${tx.cedula_destino}', CURRENT_DATE(),
                                            'Transferencia recibida confirmada por titular', ${tx.monto})
                                `);
                                console.log(`✅ Transferencia ${idTx} completada y saldos actualizados`);
                            }
                        }
                    } catch (err) {
                        console.error('❌ Error confirmando en BQ:', err.message);
                    }
                }

                const nombreConfirm = sesion.nombre ? sesion.nombre.split(' ')[0] : 'cliente';
                await sock.sendMessage(numeroUsuario, {
                    text: `✅ Perfecto, *${nombreConfirm}*. Transacción confirmada. Tu cuenta está activa y queda registrada en tu historial.\n\n¿Hay algo más en lo que pueda ayudarte?`
                });
                return;
            }

            // Respuesta no reconocida — recordar opciones en texto plano
            await sock.sendMessage(numeroUsuario, {
                text: `No reconocí tu respuesta. Por favor responde:\n\n*1.* Sí, fui yo\n*2.* No, bloquear mi cuenta\n\nEscribe *1* o *2*`
            });
            return;
        }

        // Mapeo de IDs de botón/lista Y números del menú → intención del agente
        const menuMap = {
            'menu_credito':     'Quiero ver mi análisis crediticio y perfil de endeudamiento.',
            'menu_movimientos': 'Quiero revisar mis últimos movimientos y transacciones.',
            'menu_simulacion':  'Quiero simular un crédito.',
            'menu_salario':     'Quiero conocer mi posición salarial en el mercado.',
            'menu_pqr':         'Quiero radicar una PQR (Petición, Queja o Reclamo).',
            'menu_productos':   'Quiero solicitar un producto financiero (tarjeta de crédito o crédito).',
            '1':                'Quiero ver mi análisis crediticio y perfil de endeudamiento.',
            '2':                'Quiero revisar mis últimos movimientos y transacciones.',
            '3':                'Quiero simular un crédito.',
            '4':                'Quiero conocer mi posición salarial en el mercado.',
            '5':                'Quiero radicar una PQR (Petición, Queja o Reclamo).',
            '6':                'Quiero solicitar un producto financiero (tarjeta de crédito o crédito).'
        };
        const mensajeEfectivo = menuMap[textoUsuario.trim()] || textoUsuario;

        // ════════════════════════════════════════════════════════
        // FLUJO NORMAL — identificación y agente
        // ════════════════════════════════════════════════════════

        const matchCedula = mensajeEfectivo?.match(/\b\d{7,11}\b/);
        if (matchCedula && !sesion.cedula) {
            const cedulaDetectada = matchCedula[0];
            await sock.sendMessage(numeroUsuario, {
                text: `🔍 Consultando tu información para la cédula *${cedulaDetectada}*...`
            });
            const cliente = await obtenerClientePorCedula(cedulaDetectada);
            if (cliente) {
                const nombreCompleto = `${cliente.nombres} ${cliente.apellidos}`;
                guardarSesion(numeroUsuario, {
                    cedula:     cedulaDetectada,
                    nombre:     nombreCompleto,
                    presentado: true
                });
                // Si el usuario ya venía con una intención (ej: eligió opción del menú antes de identificarse),
                // se la pasamos al agente en lugar de mostrar el menú de nuevo.
                const sesionActualizada = obtenerSesion(numeroUsuario);
                if (mensajeEfectivo !== cedulaDetectada) {
                    // El mensaje tenía algo más además de la cédula — procesarlo con el agente
                    const respuesta = await ejecutarAgenteFinanciero({
                        mensajeUsuario: mensajeEfectivo,
                        sesion: sesionActualizada
                    });
                    await sock.sendMessage(numeroUsuario, { text: respuesta });
                } else {
                    // Solo escribió su cédula — dar bienvenida personalizada + menú
                    await enviarMenuPrincipal(numeroUsuario, true, nombreCompleto);
                }
                return;
            } else {
                await sock.sendMessage(numeroUsuario, {
                    text: `⚠️ La cédula *${cedulaDetectada}* no está registrada. Verifica el número e inténtalo de nuevo.`
                });
                return;
            }
        }

        // Si el usuario saluda o escribe "hola/menú/inicio"
        const esActivadorMenu = /^(hola|hi|buenas|inicio|menu|menú|ayuda|help|start|opciones)$/i.test(mensajeEfectivo.trim());
        if (esActivadorMenu) {
            // Si ya tiene una conversación activa, no interrumpir con el menú completo
            if (sesion.cedula && sesion.historial.length > 2) {
                const nombre1 = sesion.nombre?.split(' ')[0] || 'cliente';
                await sock.sendMessage(numeroUsuario, {
                    text: `¡Aquí estoy, ${nombre1}! 😊 ¿En qué te ayudo? Puedes preguntarme directamente o escribir *menú* para ver todas las opciones.`
                });
                // Mostrar menú completo solo si explícitamente escribe "menú" o "menu"
                if (/^(menu|menú|opciones)$/i.test(mensajeEfectivo.trim())) {
                    await enviarMenuPrincipal(numeroUsuario, !!sesion.cedula, sesion.nombre);
                }
                return;
            }
            await enviarMenuPrincipal(numeroUsuario, !!sesion.cedula, sesion.nombre);
            sesion.presentado = true;
            return;
        }

        // Si no hay cédula y no es botón de menú, ejecutar agente para responder libremente
        const sesionActual = obtenerSesion(numeroUsuario);
        // Si nunca se ha presentado y el cliente no está identificado, marcar que el agente lo hará
        if (!sesionActual.presentado && !sesionActual.cedula) {
            sesionActual.presentado = true; // el agente se presentará en esta respuesta
        }

        try {
            const respuesta = await ejecutarAgenteFinanciero({
                mensajeUsuario: mensajeEfectivo,
                sesion: sesionActual,
                pdfBase64
            });

            if (sesionActual.pendingFraudAlert) {
                const { monto, cuenta, detalle } = sesionActual.pendingFraudAlert;
                sesionActual.pendingFraudAlert = null;
                await enviarAlertaFraude({
                    cedula:        sesionActual.cedula,
                    monto, cuenta, detalle,
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

// ───────────────────────────────────────────
// INICIO
// ───────────────────────────────────────────
console.log("▶️ Iniciando QuindBot...");
conectarWhatsApp().catch(err => console.error("💥 ERROR CRÍTICO:", err));