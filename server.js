/**
 * ═══════════════════════════════════════════════════════════════
 * BANCO QUIND — Backend API Server
 * Convive con app.js (QuindBot) en el mismo repo chatbot-quind
 * Cloud Run | Node.js | BigQuery
 * ═══════════════════════════════════════════════════════════════
 */

const express        = require('express');
const { BigQuery }   = require('@google-cloud/bigquery');
const crypto         = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit      = require('express-rate-limit');
const helmet         = require('helmet');
const cors           = require('cors');
const path           = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Configuración GCP ──────────────────────────────────────────
const PROJECT_ID = process.env.PROJECT_ID || 'datatest-347114';
const DATASET    = 'banco_quind';
const TBL_CLIENTES        = `\`${PROJECT_ID}.${DATASET}.clientes_riesgo_chatbot\``;
const TBL_MOVIMIENTOS     = `\`${PROJECT_ID}.${DATASET}.movimientos_cliente\``;
const TBL_TRANSFERENCIAS  = `\`${PROJECT_ID}.${DATASET}.transferencias\``;
const TBL_SOLICITUDES     = `\`${PROJECT_ID}.${DATASET}.solicitudes_productos\``;

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || '';

const bigquery = new BigQuery({ projectId: PROJECT_ID });

// ── Middlewares ────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true });
app.use('/api/', limiter);

// ── Utilidades ─────────────────────────────────────────────────
const sha256 = (str) => crypto.createHash('sha256').update(str).digest('hex');

function generarNumeroCuenta() {
    const prefijo = '4271';
    const sufijo  = Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
    return prefijo + sufijo;
}

async function bqQuery(sql, params = []) {
    const options = { query: sql, location: 'US' };
    if (params && params.length > 0) {
        const p = {};
        params.forEach(x => { p[x.name] = x.value; });
        options.params = p;
    }
    const [rows] = await bigquery.query(options);
    return rows;
}

async function obtenerIdToken(audiencia) {
    const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audiencia)}`;
    const res = await fetch(url, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal:  AbortSignal.timeout(3000)
    });
    if (!res.ok) throw new Error(`Metadata server respondió ${res.status}`);
    return res.text();
}

async function notificarBotFraude({ celular, cedula, nombre, monto, cuentaDestino, motivo, idTransferencia }) {
    if (!BOT_INTERNAL_URL) {
        console.warn('⚠️  BOT_INTERNAL_URL no configurado — notificación WA omitida.');
        return;
    }
    (async () => {
        try {
            const idToken = await obtenerIdToken(BOT_INTERNAL_URL);
            const res = await fetch(`${BOT_INTERNAL_URL}/alerta-fraude`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                body:    JSON.stringify({ celular, cedula, nombre, monto, cuentaDestino, motivo, idTransferencia }),
                signal:  AbortSignal.timeout(25000)
            });
            if (!res.ok) {
                const txt = await res.text();
                console.error(`❌ Bot respondió ${res.status}: ${txt}`);
            } else {
                console.log(`📲 Alerta enviada al bot WA | celular: ${celular} | cedula: ${cedula}`);
            }
        } catch (err) {
            console.error('❌ Error al notificar al bot:', err.message);
        }
    })();
}

// ── Lógica de evaluación de productos ─────────────────────────
async function evaluarProducto({ cedula, tipoProducto }) {
    // Obtener datos del cliente
    const clienteRows = await bqQuery(
        `SELECT saldo_actual, saldo_promedio_cuentas, deuda_actual_tarjetas,
                cupo_total_tarjetas, estado_cuenta, fecha_registro
         FROM ${TBL_CLIENTES} WHERE cedula = @cedula LIMIT 1`,
        [{ name: 'cedula', value: cedula }]
    );
    if (!clienteRows.length) return { aprobado: false, motivo: 'Cliente no encontrado' };

    const cliente = clienteRows[0];
    if (cliente.estado_cuenta !== 'ACTIVA') {
        return { aprobado: false, motivo: `Cuenta en estado ${cliente.estado_cuenta}` };
    }

    // Calcular ingresos promedio últimos 3 meses
    const ingresosRows = await bqQuery(
        `SELECT COALESCE(AVG(total_mes), 0) AS ingreso_promedio
         FROM (
           SELECT FORMAT_DATE('%Y-%m', DATE(fecha)) AS mes, SUM(movimiento) AS total_mes
           FROM ${TBL_MOVIMIENTOS}
           WHERE cedula = @cedula
             AND movimiento > 0
             AND fecha >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 MONTH)
           GROUP BY mes
         )`,
        [{ name: 'cedula', value: cedula }]
    );
    const ingresoProm = ingresosRows[0]?.ingreso_promedio || 0;
    const cpm         = ingresoProm * 0.30;

    const saldoProm  = cliente.saldo_promedio_cuentas || cliente.saldo_actual || 0;
    const deuda      = cliente.deuda_actual_tarjetas   || 0;
    const cupo       = cliente.cupo_total_tarjetas      || 0;

    // Antigüedad en meses
    const fechaReg      = cliente.fecha_registro ? new Date(cliente.fecha_registro.value || cliente.fecha_registro) : new Date();
    const mesesAntiguedad = Math.floor((Date.now() - fechaReg.getTime()) / (1000 * 60 * 60 * 24 * 30));

    if (tipoProducto === 'TARJETA_CREDITO' || tipoProducto === 'TARJETA_GOLD' ||
        tipoProducto === 'TARJETA_PLATINO' || tipoProducto === 'TARJETA_BLACK') {

        const pctDeuda = cupo > 0 ? (deuda / cupo) : 0;

        // Determinar nivel de perfil
        let nivel;
        if      (saldoProm > 5_000_000 && pctDeuda < 0.30 && mesesAntiguedad >= 1) nivel = 'ALTO';
        else if (saldoProm > 2_000_000 && pctDeuda < 0.50)                         nivel = 'MEDIO';
        else if (saldoProm > 500_000   && mesesAntiguedad >= 3)                     nivel = 'BASICO';
        else nivel = 'DENEGADO';

        if (nivel === 'DENEGADO') {
            return { aprobado: false, nivel: 'DENEGADO', cupo: 0, cpm,
                     motivo: `Saldo promedio insuficiente (${Math.round(saldoProm/1000)}K) o cuenta muy nueva (${mesesAntiguedad} meses). Mínimo requerido: $500.000 de saldo promedio y 3 meses de antigüedad.` };
        }

        // Reglas por tarjeta específica
        const tarjetasConfig = {
            TARJETA_GOLD:    { nivelMin: 'BASICO', cupoMax: 3_000_000,  multiplicador: 1.5, nombre: 'Gold'    },
            TARJETA_PLATINO: { nivelMin: 'MEDIO',  cupoMax: 8_000_000,  multiplicador: 3,   nombre: 'Platino' },
            TARJETA_BLACK:   { nivelMin: 'ALTO',   cupoMax: 15_000_000, multiplicador: 5,   nombre: 'Black'   },
            TARJETA_CREDITO: { nivelMin: 'BASICO', cupoMax: 15_000_000, multiplicador: 3,   nombre: 'Crédito' }
        };
        const orden = ['BASICO', 'MEDIO', 'ALTO'];
        const cfg   = tarjetasConfig[tipoProducto] || tarjetasConfig['TARJETA_CREDITO'];

        if (orden.indexOf(nivel) < orden.indexOf(cfg.nivelMin)) {
            // Perfil insuficiente para esa tarjeta — sugerir la que sí califica
            const sugerida = nivel === 'BASICO' ? 'Gold' : nivel === 'MEDIO' ? 'Platino' : 'Black';
            return { aprobado: false, nivel, cupo: 0, cpm,
                     motivo: `Tu perfil (${nivel}) no cumple el mínimo para la tarjeta ${cfg.nombre}. Te recomendamos la tarjeta ${sugerida} que sí está disponible para tu nivel.` };
        }

        const cupoAprobado = Math.min(cfg.cupoMax, cpm * cfg.multiplicador);
        const beneficiosPorTarjeta = {
            TARJETA_GOLD:    'Sin cuota de manejo, cuotas sin interés y app de control de gastos.',
            TARJETA_PLATINO: '2 Puntos Colombia por cada $1.000 gastado, seguro de viaje y acceso a salas VIP.',
            TARJETA_BLACK:   '2% de cashback en todas las compras, concierge 24/7 y cupo hasta $15.000.000.',
            TARJETA_CREDITO: 'Cupo rotativo según perfil financiero.'
        };
        return {
            aprobado: true, nivel, cupo: cupoAprobado, cpm,
            motivo: `Tarjeta ${cfg.nombre} aprobada para perfil ${nivel}. ${beneficiosPorTarjeta[tipoProducto] || ''}`
        };
    }

    if (tipoProducto === 'CREDITO_CONSUMO') {
        const pctDeudaIngresos = ingresoProm > 0 ? (deuda / ingresoProm) : 1;
        if (mesesAntiguedad < 6) {
            return { aprobado: false, nivel: 'DENEGADO', cupo: 0, cpm,
                     motivo: `Antigüedad insuficiente: ${mesesAntiguedad} meses (mínimo 6)` };
        }
        if (pctDeudaIngresos > 0.40) {
            return { aprobado: false, nivel: 'DENEGADO', cupo: 0, cpm,
                     motivo: `Deuda actual (${Math.round(pctDeudaIngresos*100)}%) supera el 40% de tus ingresos` };
        }
        return { aprobado: true, nivel: 'APROBADO', cupo: cpm * 12, cpm,
                 motivo: `Perfil aprobado. Plazo hasta 36 meses.` };
    }

    if (tipoProducto === 'CREDITO_VIVIENDA') {
        const pctDeudaIngresos = ingresoProm > 0 ? (deuda / ingresoProm) : 1;
        if (mesesAntiguedad < 12) {
            return { aprobado: false, nivel: 'DENEGADO', cupo: 0, cpm,
                     motivo: `Antigüedad insuficiente: ${mesesAntiguedad} meses (mínimo 12)` };
        }
        if (pctDeudaIngresos > 0.30) {
            return { aprobado: false, nivel: 'DENEGADO', cupo: 0, cpm,
                     motivo: `Deuda actual supera el 30% de tus ingresos` };
        }
        if (saldoProm < 3_000_000) {
            return { aprobado: false, nivel: 'DENEGADO', cupo: 0, cpm,
                     motivo: `Saldo promedio insuficiente para crédito de vivienda` };
        }
        return { aprobado: true, nivel: 'APROBADO', cupo: cpm * 60, cpm,
                 motivo: `Perfil aprobado. Plazo hasta 15 años.` };
    }

    return { aprobado: false, motivo: 'Tipo de producto no reconocido' };
}

// ── Detección de fraude ────────────────────────────────────────
async function analizarRiesgoTransferencia({ cedula, monto, dispositivoHash }) {
    const alertas   = [];
    let nivelRiesgo = 'BAJO';

    const rows = await bqQuery(
        `SELECT saldo_actual, saldo_promedio_cuentas,
                dispositivo_hash AS disp_registrado, estado_cuenta
         FROM ${TBL_CLIENTES} WHERE cedula = @cedula LIMIT 1`,
        [{ name: 'cedula', value: cedula }]
    );
    if (!rows.length) return { riesgo: 'ALTO', alertas: ['Cliente no encontrado'], bloquear: true };

    const cliente = rows[0];
    if (cliente.estado_cuenta !== 'ACTIVA') return { riesgo: 'ALTO', alertas: ['Cuenta no activa'], bloquear: true };
    if (monto > cliente.saldo_actual)        return { riesgo: 'ALTO', alertas: ['Saldo insuficiente'], bloquear: true };

    if (monto > cliente.saldo_actual * 0.8) {
        alertas.push('Transferencia superior al 80% del saldo disponible');
        nivelRiesgo = 'MEDIO';
    }
    if (cliente.saldo_promedio_cuentas && monto > cliente.saldo_promedio_cuentas * 2) {
        alertas.push('Monto inusualmente alto respecto al historial de saldo');
        nivelRiesgo = 'ALTO';
    }
    if (cliente.disp_registrado && dispositivoHash && cliente.disp_registrado !== dispositivoHash) {
        alertas.push('Inicio de sesión desde dispositivo no reconocido');
        nivelRiesgo = nivelRiesgo === 'BAJO' ? 'MEDIO' : 'ALTO';
    }

    const recientes = await bqQuery(
        `SELECT COUNT(*) AS total FROM ${TBL_TRANSFERENCIAS}
         WHERE cedula_origen = @cedula
           AND fecha > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
           AND estado = 'COMPLETADA'`,
        [{ name: 'cedula', value: cedula }]
    );
    if (recientes[0]?.total >= 3) {
        alertas.push('Múltiples transferencias en la última hora');
        nivelRiesgo = 'ALTO';
    }

    return { riesgo: nivelRiesgo, alertas, bloquear: nivelRiesgo === 'ALTO' && alertas.length > 0 };
}

// ══════════════════════════════════════════════
// ENDPOINTS API
// ══════════════════════════════════════════════

// ── POST /api/auth/login ───────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    try {
        const { cedula, pin } = req.body;
        if (!cedula || !pin) return res.status(400).json({ error: 'Cédula y PIN requeridos' });

        const pinHash = sha256(pin.toString());
        const rows    = await bqQuery(
            `SELECT cedula, nombres, apellidos, celular, numero_cuenta,
                    saldo_actual, deuda_actual_tarjetas, cupo_total_tarjetas,
                    estado_cuenta, dispositivo_hash, ultimo_acceso_app
             FROM ${TBL_CLIENTES}
             WHERE cedula = @cedula AND pin_hash = @pin LIMIT 1`,
            [{ name: 'cedula', value: cedula }, { name: 'pin', value: pinHash }]
        );

        if (!rows.length) return res.status(401).json({ error: 'Cédula o PIN incorrectos' });
        const cliente = rows[0];
        if (cliente.estado_cuenta === 'BLOQUEADA') {
            return res.status(403).json({ error: 'Cuenta bloqueada. Comunícate con servicio al cliente.' });
        }

        const nuevoDisp       = sha256((req.headers['user-agent'] || '') + (req.ip || ''));
        const dispositivoNuevo = !!(cliente.dispositivo_hash && cliente.dispositivo_hash !== nuevoDisp);

        await bqQuery(
            `UPDATE ${TBL_CLIENTES}
             SET ultimo_acceso_app = CURRENT_TIMESTAMP(), dispositivo_hash = @disp
             WHERE cedula = @cedula`,
            [{ name: 'disp', value: nuevoDisp }, { name: 'cedula', value: cedula }]
        );

        res.json({
            ok: true,
            cliente: {
                cedula:        cliente.cedula,
                nombre:        `${cliente.nombres} ${cliente.apellidos}`,
                celular:       cliente.celular,
                numeroCuenta:  cliente.numero_cuenta,
                saldo:         cliente.saldo_actual         || 0,
                saldoPromedio: cliente.saldo_promedio_cuentas || 0,
                deudaTarjetas: cliente.deuda_actual_tarjetas || 0,
                cupoTarjetas:  cliente.cupo_total_tarjetas   || 0,
                estado:        cliente.estado_cuenta
            },
            alertaDispositivoNuevo: dispositivoNuevo
        });
    } catch (err) {
        console.error('Error login:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── POST /api/auth/registro ────────────────────────────────────
app.post('/api/auth/registro', async (req, res) => {
    try {
        const { cedula, pin, nombres, apellidos, celular } = req.body;
        if (!cedula || !pin || !nombres || !apellidos || !celular)
            return res.status(400).json({ error: 'Todos los campos son obligatorios' });
        if (pin.toString().length !== 4)
            return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });

        const existe = await bqQuery(
            `SELECT cedula FROM ${TBL_CLIENTES} WHERE cedula = @cedula LIMIT 1`,
            [{ name: 'cedula', value: cedula }]
        );
        if (existe.length) return res.status(409).json({ error: 'Esta cédula ya está registrada' });

        let numeroCuenta, intentos = 0;
        do {
            numeroCuenta = generarNumeroCuenta();
            const dup    = await bqQuery(
                `SELECT numero_cuenta FROM ${TBL_CLIENTES} WHERE numero_cuenta = @nc LIMIT 1`,
                [{ name: 'nc', value: numeroCuenta }]
            );
            if (!dup.length) break;
        } while (++intentos < 5);

        const pinHash  = sha256(pin.toString());
        const dispHash = sha256((req.headers['user-agent'] || '') + (req.ip || ''));

        await bqQuery(
            `INSERT INTO ${TBL_CLIENTES}
               (cedula, nombres, apellidos, celular, pin_hash, numero_cuenta,
                saldo_actual, estado_cuenta, dispositivo_hash, fecha_registro, ultimo_acceso_app)
             VALUES
               (@cedula, @nombres, @apellidos, @celular, @pin, @nc,
                50000, 'ACTIVA', @disp, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
            [
                { name: 'cedula',    value: cedula    },
                { name: 'nombres',   value: nombres   },
                { name: 'apellidos', value: apellidos },
                { name: 'celular',   value: celular   },
                { name: 'pin',       value: pinHash   },
                { name: 'nc',        value: numeroCuenta },
                { name: 'disp',      value: dispHash  }
            ]
        );

        await bqQuery(
            `INSERT INTO ${TBL_MOVIMIENTOS} (cedula, fecha, detalle, movimiento)
             VALUES (@cedula, CURRENT_DATE(), 'Depósito de bienvenida — Banco QUIND', 50000)`,
            [{ name: 'cedula', value: cedula }]
        );

        res.json({ ok: true, numeroCuenta, mensaje: 'Cuenta creada exitosamente. Saldo inicial: $50,000 COP' });
    } catch (err) {
        console.error('Error registro:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── GET /api/movimientos/:cedula ───────────────────────────────
app.get('/api/movimientos/:cedula', async (req, res) => {
    try {
        const rows = await bqQuery(
            `SELECT fecha, detalle, movimiento FROM ${TBL_MOVIMIENTOS}
             WHERE cedula = @cedula ORDER BY fecha DESC LIMIT 30`,
            [{ name: 'cedula', value: req.params.cedula }]
        );
        res.json({ ok: true, movimientos: rows });
    } catch (err) {
        console.error('Error movimientos:', err);
        res.status(500).json({ error: 'Error consultando movimientos' });
    }
});

// ── POST /api/transferencia ────────────────────────────────────
app.post('/api/transferencia', async (req, res) => {
    try {
        const { cedulaOrigen, cuentaDestino, monto, detalle } = req.body;
        if (!cedulaOrigen || !cuentaDestino || !monto)
            return res.status(400).json({ error: 'Datos incompletos' });
        if (monto <= 0) return res.status(400).json({ error: 'El monto debe ser positivo' });

        const dispositivoHash = sha256((req.headers['user-agent'] || '') + (req.ip || ''));
        const analisis        = await analizarRiesgoTransferencia({ cedula: cedulaOrigen, monto, dispositivoHash });

        if (analisis.bloquear && analisis.alertas.includes('Saldo insuficiente'))
            return res.status(400).json({ error: 'Saldo insuficiente para realizar la transferencia' });

        const destinoRows = await bqQuery(
            `SELECT cedula, nombres, apellidos, saldo_actual, estado_cuenta
             FROM ${TBL_CLIENTES} WHERE numero_cuenta = @nc LIMIT 1`,
            [{ name: 'nc', value: cuentaDestino }]
        );
        if (!destinoRows.length)
            return res.status(404).json({ error: 'Cuenta destino no encontrada en Banco QUIND' });

        const destino = destinoRows[0];
        if (destino.estado_cuenta !== 'ACTIVA')
            return res.status(400).json({ error: 'La cuenta destino no está activa' });

        const idTransferencia = uuidv4();
        const estadoTx        = analisis.bloquear ? 'INVESTIGACION' : 'COMPLETADA';

        await bqQuery(
            `INSERT INTO ${TBL_TRANSFERENCIAS}
               (id_transferencia, cedula_origen, cuenta_origen, cuenta_destino, cedula_destino,
                monto, fecha, detalle, estado, motivo_bloqueo, ip_origen, dispositivo_hash)
             VALUES (
               @id,
               @co,
               (SELECT numero_cuenta FROM ${TBL_CLIENTES} WHERE cedula = @co LIMIT 1),
               @cd, @ced_dest, @monto, CURRENT_TIMESTAMP(), @det, @estado, @motivo, @ip, @disp
             )`,
            [
                { name: 'id',       value: idTransferencia },
                { name: 'co',       value: cedulaOrigen    },
                { name: 'cd',       value: cuentaDestino   },
                { name: 'ced_dest', value: destino.cedula  },
                { name: 'monto',    value: monto           },
                { name: 'det',      value: detalle || 'Transferencia' },
                { name: 'estado',   value: estadoTx        },
                { name: 'motivo',   value: analisis.alertas.join('; ') || null },
                { name: 'ip',       value: req.ip          },
                { name: 'disp',     value: dispositivoHash }
            ]
        );

        if (estadoTx === 'COMPLETADA') {
            await bqQuery(
                `UPDATE ${TBL_CLIENTES} SET saldo_actual = saldo_actual - @monto WHERE cedula = @cedula`,
                [{ name: 'monto', value: monto }, { name: 'cedula', value: cedulaOrigen }]
            );
            await bqQuery(
                `UPDATE ${TBL_CLIENTES} SET saldo_actual = saldo_actual + @monto WHERE cedula = @cedula`,
                [{ name: 'monto', value: monto }, { name: 'cedula', value: destino.cedula }]
            );
            await bqQuery(
                `INSERT INTO ${TBL_MOVIMIENTOS} (cedula, fecha, detalle, movimiento) VALUES (@ced, CURRENT_DATE(), @det, @monto)`,
                [
                    { name: 'ced',   value: cedulaOrigen },
                    { name: 'det',   value: `Transferencia a cuenta ${cuentaDestino} - ${detalle || ''}` },
                    { name: 'monto', value: -monto }
                ]
            );
            await bqQuery(
                `INSERT INTO ${TBL_MOVIMIENTOS} (cedula, fecha, detalle, movimiento) VALUES (@ced, CURRENT_DATE(), @det, @monto)`,
                [
                    { name: 'ced',   value: destino.cedula },
                    { name: 'det',   value: `Transferencia recibida - ${detalle || ''}` },
                    { name: 'monto', value: monto }
                ]
            );
        } else {
            await bqQuery(
                `UPDATE ${TBL_CLIENTES} SET estado_cuenta = 'INVESTIGACION' WHERE cedula = @cedula`,
                [{ name: 'cedula', value: cedulaOrigen }]
            );
            try {
                const clienteRows = await bqQuery(
                    `SELECT celular, nombres, apellidos FROM ${TBL_CLIENTES} WHERE cedula = @cedula LIMIT 1`,
                    [{ name: 'cedula', value: cedulaOrigen }]
                );
                const celular = clienteRows[0]?.celular;
                const nombre  = clienteRows[0] ? `${clienteRows[0].nombres} ${clienteRows[0].apellidos}` : null;
                if (celular) {
                    await notificarBotFraude({ celular, cedula: cedulaOrigen, nombre, monto, cuentaDestino, motivo: analisis.alertas.join(', '), idTransferencia });
                } else {
                    console.warn('⚠️  Cliente sin celular registrado — no se puede notificar por WA.');
                }
            } catch (notifErr) {
                console.error('Error obteniendo celular para notificación:', notifErr.message);
            }
        }

        res.json({
            ok:             estadoTx === 'COMPLETADA',
            estado:         estadoTx,
            idTransferencia,
            nombreDestino:  `${destino.nombres} ${destino.apellidos}`,
            alertas:        analisis.alertas,
            mensaje: estadoTx === 'COMPLETADA'
                ? `Transferencia exitosa a ${destino.nombres} ${destino.apellidos}`
                : `Transferencia bloqueada bajo investigación por: ${analisis.alertas.join(', ')}`
        });
    } catch (err) {
        console.error('Error transferencia:', err);
        res.status(500).json({ error: 'Error procesando la transferencia' });
    }
});

// ── POST /api/solicitar-producto ───────────────────────────────
app.post('/api/solicitar-producto', async (req, res) => {
    try {
        const { cedula, tipoProducto } = req.body;
        if (!cedula || !tipoProducto)
            return res.status(400).json({ error: 'cedula y tipoProducto son requeridos' });

        const tiposValidos = ['TARJETA_CREDITO', 'CREDITO_CONSUMO', 'CREDITO_VIVIENDA'];
        if (!tiposValidos.includes(tipoProducto))
            return res.status(400).json({ error: `tipoProducto debe ser uno de: ${tiposValidos.join(', ')}` });

        const resultado = await evaluarProducto({ cedula, tipoProducto });

        // Registrar la solicitud en BigQuery
        try {
            await bqQuery(
                `INSERT INTO ${TBL_SOLICITUDES}
                   (cedula, tipo_producto, cupo_aprobado, nivel_perfil, motivo_decision,
                    cpm_calculado, fecha_solicitud, estado)
                 VALUES (@cedula, @tipo, @cupo, @nivel, @motivo, @cpm, CURRENT_TIMESTAMP(), @estado)`,
                [
                    { name: 'cedula',  value: cedula             },
                    { name: 'tipo',    value: tipoProducto        },
                    { name: 'cupo',    value: resultado.cupo || 0 },
                    { name: 'nivel',   value: resultado.nivel || (resultado.aprobado ? 'APROBADO' : 'DENEGADO') },
                    { name: 'motivo',  value: resultado.motivo    },
                    { name: 'cpm',     value: resultado.cpm   || 0},
                    { name: 'estado',  value: resultado.aprobado ? 'APROBADA' : 'DENEGADA' }
                ]
            );
        } catch (bqErr) {
            // La tabla puede no existir aún — el bot también intenta registrarla
            console.warn('⚠️ No se pudo registrar en BQ solicitudes_productos:', bqErr.message);
        }

        res.json({
            ok:       resultado.aprobado,
            aprobado: resultado.aprobado,
            nivel:    resultado.nivel,
            cupo:     resultado.cupo    || 0,
            cpm:      resultado.cpm     || 0,
            motivo:   resultado.motivo,
            tipoProducto
        });
    } catch (err) {
        console.error('Error solicitar-producto:', err);
        res.status(500).json({ error: 'Error evaluando solicitud de producto' });
    }
});

// ── GET /api/saldo/:cedula ─────────────────────────────────────
app.get('/api/saldo/:cedula', async (req, res) => {
    try {
        const rows = await bqQuery(
            `SELECT saldo_actual, numero_cuenta, estado_cuenta,
                    deuda_actual_tarjetas, cupo_total_tarjetas
             FROM ${TBL_CLIENTES} WHERE cedula = @cedula LIMIT 1`,
            [{ name: 'cedula', value: req.params.cedula }]
        );
        if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
        res.json({ ok: true, ...rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Error consultando saldo' });
    }
});

// ── GET /api/buscar-cuenta/:numero ─────────────────────────────
app.get('/api/buscar-cuenta/:numero', async (req, res) => {
    try {
        const rows = await bqQuery(
            `SELECT nombres, apellidos, numero_cuenta
             FROM ${TBL_CLIENTES}
             WHERE numero_cuenta = @nc AND estado_cuenta = 'ACTIVA' LIMIT 1`,
            [{ name: 'nc', value: req.params.numero }]
        );
        if (!rows.length) return res.status(404).json({ error: 'Cuenta no encontrada' });
        res.json({ ok: true, nombre: `${rows[0].nombres} ${rows[0].apellidos}` });
    } catch (err) {
        res.status(500).json({ error: 'Error buscando cuenta' });
    }
});

// ── Catch-all: sirve el frontend ───────────────────────────────
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Iniciar servidor ───────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏦 Banco QUIND API corriendo en puerto ${PORT}`);
    console.log(`🤖 BOT_INTERNAL_URL: ${BOT_INTERNAL_URL || '(no configurado)'}`);
});