/**
 * ═══════════════════════════════════════════════════════════════
 * LA GRAN BANCOLOMBIA — Backend API Server
 * Convive con app.js (QuindBot) en el mismo repo chatbot-quind
 * Cloud Run | Node.js | BigQuery
 * ═══════════════════════════════════════════════════════════════
 */

const express      = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const crypto       = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const cors         = require('cors');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Configuración GCP ──────────────────────────────────────────
const PROJECT_ID = process.env.PROJECT_ID || 'datatest-347114';
const DATASET    = 'banco_quind';
const TBL_CLIENTES       = `\`${PROJECT_ID}.${DATASET}.clientes_riesgo_chatbot\``;
const TBL_MOVIMIENTOS    = `\`${PROJECT_ID}.${DATASET}.movimientos_cliente\``;
const TBL_TRANSFERENCIAS = `\`${PROJECT_ID}.${DATASET}.transferencias\``;

const bigquery = new BigQuery({ projectId: PROJECT_ID });

// ── Middlewares ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Sirve el frontend desde /public (en la raíz del repo)
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting: 60 req/min por IP
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
  if (params.length) options.params = params;
  const [rows] = await bigquery.query(options);
  return rows;
}

// ── Detección de fraude ────────────────────────────────────────
async function analizarRiesgoTransferencia({ cedula, monto, cuentaDestino, ip, dispositivoHash }) {
  const alertas = [];
  let nivelRiesgo = 'BAJO';

  const rows = await bqQuery(`
    SELECT saldo_actual, saldo_promedio_cuentas, dispositivo_hash AS disp_registrado, estado_cuenta
    FROM ${TBL_CLIENTES}
    WHERE cedula = @cedula LIMIT 1`,
    [{ name: 'cedula', value: cedula }]
  );

  if (!rows.length) return { riesgo: 'ALTO', alertas: ['Cliente no encontrado'], bloquear: true };

  const cliente = rows[0];

  if (cliente.estado_cuenta !== 'ACTIVA') {
    return { riesgo: 'ALTO', alertas: ['Cuenta no activa'], bloquear: true };
  }

  // Saldo insuficiente
  if (monto > cliente.saldo_actual) {
    return { riesgo: 'ALTO', alertas: ['Saldo insuficiente'], bloquear: true };
  }

  // Monto > 80% del saldo
  if (monto > cliente.saldo_actual * 0.8) {
    alertas.push('Transferencia superior al 80% del saldo disponible');
    nivelRiesgo = 'MEDIO';
  }

  // Monto inusualmente alto vs promedio histórico
  if (cliente.saldo_promedio_cuentas && monto > cliente.saldo_promedio_cuentas * 2) {
    alertas.push('Monto inusualmente alto respecto al historial de saldo');
    nivelRiesgo = 'ALTO';
  }

  // Dispositivo no reconocido
  if (cliente.disp_registrado && dispositivoHash && cliente.disp_registrado !== dispositivoHash) {
    alertas.push('Inicio de sesión desde dispositivo no reconocido');
    nivelRiesgo = nivelRiesgo === 'BAJO' ? 'MEDIO' : 'ALTO';
  }

  // Múltiples transferencias en última hora (>3)
  const recientes = await bqQuery(`
    SELECT COUNT(*) AS total
    FROM ${TBL_TRANSFERENCIAS}
    WHERE cedula_origen = @cedula
      AND fecha > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
      AND estado = 'COMPLETADA'`,
    [{ name: 'cedula', value: cedula }]
  );

  if (recientes[0]?.total >= 3) {
    alertas.push('Múltiples transferencias en la última hora');
    nivelRiesgo = 'ALTO';
  }

  return {
    riesgo: nivelRiesgo,
    alertas,
    bloquear: nivelRiesgo === 'ALTO' && alertas.length > 0
  };
}

// ══════════════════════════════════════════
// ENDPOINTS API
// ══════════════════════════════════════════

// ── POST /api/auth/login ───────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { cedula, pin } = req.body;
    if (!cedula || !pin) return res.status(400).json({ error: 'Cédula y PIN requeridos' });

    const pinHash = sha256(pin.toString());
    const rows = await bqQuery(`
      SELECT cedula, nombres, apellidos, celular, numero_cuenta,
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

    const nuevoDisp     = sha256((req.headers['user-agent'] || '') + (req.ip || ''));
    const dispositivoNuevo = cliente.dispositivo_hash && cliente.dispositivo_hash !== nuevoDisp;

    await bqQuery(`
      UPDATE ${TBL_CLIENTES}
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
        saldo:         cliente.saldo_actual || 0,
        deudaTarjetas: cliente.deuda_actual_tarjetas || 0,
        cupoTarjetas:  cliente.cupo_total_tarjetas || 0,
        estado:        cliente.estado_cuenta
      },
      alertaDispositivoNuevo: dispositivoNuevo
    });
  } catch (err) {
    console.error('Error login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /api/auth/registro ────────────────────
app.post('/api/auth/registro', async (req, res) => {
  try {
    const { cedula, pin, nombres, apellidos, celular } = req.body;
    if (!cedula || !pin || !nombres || !apellidos || !celular) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    if (pin.toString().length !== 4) {
      return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });
    }

    const existe = await bqQuery(`
      SELECT cedula FROM ${TBL_CLIENTES} WHERE cedula = @cedula LIMIT 1`,
      [{ name: 'cedula', value: cedula }]
    );
    if (existe.length) return res.status(409).json({ error: 'Esta cédula ya está registrada' });

    let numeroCuenta, intentos = 0;
    do {
      numeroCuenta = generarNumeroCuenta();
      const dup = await bqQuery(`
        SELECT numero_cuenta FROM ${TBL_CLIENTES} WHERE numero_cuenta = @nc LIMIT 1`,
        [{ name: 'nc', value: numeroCuenta }]
      );
      if (!dup.length) break;
    } while (++intentos < 5);

    const pinHash  = sha256(pin.toString());
    const dispHash = sha256((req.headers['user-agent'] || '') + (req.ip || ''));

    await bqQuery(`
      INSERT INTO ${TBL_CLIENTES}
        (cedula, nombres, apellidos, celular, pin_hash, numero_cuenta,
         saldo_actual, estado_cuenta, dispositivo_hash, fecha_registro, ultimo_acceso_app)
      VALUES
        (@cedula, @nombres, @apellidos, @celular, @pin, @nc,
         50000, 'ACTIVA', @disp, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
      [
        { name: 'cedula',    value: cedula },
        { name: 'nombres',   value: nombres },
        { name: 'apellidos', value: apellidos },
        { name: 'celular',   value: celular },
        { name: 'pin',       value: pinHash },
        { name: 'nc',        value: numeroCuenta },
        { name: 'disp',      value: dispHash }
      ]
    );

    await bqQuery(`
      INSERT INTO ${TBL_MOVIMIENTOS} (cedula, fecha, detalle, movimiento)
      VALUES (@cedula, CURRENT_DATE(), 'Depósito de bienvenida - La Gran Bancolombia', 50000)`,
      [{ name: 'cedula', value: cedula }]
    );

    res.json({ ok: true, numeroCuenta, mensaje: 'Cuenta creada exitosamente. Saldo inicial: $50,000 COP' });
  } catch (err) {
    console.error('Error registro:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /api/movimientos/:cedula ───────────────
app.get('/api/movimientos/:cedula', async (req, res) => {
  try {
    const rows = await bqQuery(`
      SELECT fecha, detalle, movimiento
      FROM ${TBL_MOVIMIENTOS}
      WHERE cedula = @cedula
      ORDER BY fecha DESC LIMIT 30`,
      [{ name: 'cedula', value: req.params.cedula }]
    );
    res.json({ ok: true, movimientos: rows });
  } catch (err) {
    console.error('Error movimientos:', err);
    res.status(500).json({ error: 'Error consultando movimientos' });
  }
});

// ── POST /api/transferencia ────────────────────
app.post('/api/transferencia', async (req, res) => {
  try {
    const { cedulaOrigen, cuentaDestino, monto, detalle } = req.body;
    if (!cedulaOrigen || !cuentaDestino || !monto) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }
    if (monto <= 0) return res.status(400).json({ error: 'El monto debe ser positivo' });

    const dispositivoHash = sha256((req.headers['user-agent'] || '') + (req.ip || ''));

    const analisis = await analizarRiesgoTransferencia({
      cedula: cedulaOrigen, monto, cuentaDestino,
      ip: req.ip, dispositivoHash
    });

    if (analisis.bloquear && analisis.alertas.includes('Saldo insuficiente')) {
      return res.status(400).json({ error: 'Saldo insuficiente para realizar la transferencia' });
    }

    const destinoRows = await bqQuery(`
      SELECT cedula, nombres, apellidos, saldo_actual, estado_cuenta
      FROM ${TBL_CLIENTES}
      WHERE numero_cuenta = @nc LIMIT 1`,
      [{ name: 'nc', value: cuentaDestino }]
    );

    if (!destinoRows.length) {
      return res.status(404).json({ error: 'Cuenta destino no encontrada en La Gran Bancolombia' });
    }

    const destino = destinoRows[0];
    if (destino.estado_cuenta !== 'ACTIVA') {
      return res.status(400).json({ error: 'La cuenta destino no está activa' });
    }

    const idTransferencia = uuidv4();
    const estadoTx        = analisis.bloquear ? 'INVESTIGACION' : 'COMPLETADA';

    await bqQuery(`
      INSERT INTO ${TBL_TRANSFERENCIAS}
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
        { name: 'co',       value: cedulaOrigen },
        { name: 'cd',       value: cuentaDestino },
        { name: 'ced_dest', value: destino.cedula },
        { name: 'monto',    value: monto },
        { name: 'det',      value: detalle || 'Transferencia' },
        { name: 'estado',   value: estadoTx },
        { name: 'motivo',   value: analisis.alertas.join('; ') || null },
        { name: 'ip',       value: req.ip },
        { name: 'disp',     value: dispositivoHash }
      ]
    );

    if (estadoTx === 'COMPLETADA') {
      await bqQuery(`UPDATE ${TBL_CLIENTES} SET saldo_actual = saldo_actual - @monto WHERE cedula = @cedula`,
        [{ name: 'monto', value: monto }, { name: 'cedula', value: cedulaOrigen }]);

      await bqQuery(`UPDATE ${TBL_CLIENTES} SET saldo_actual = saldo_actual + @monto WHERE cedula = @cedula`,
        [{ name: 'monto', value: monto }, { name: 'cedula', value: destino.cedula }]);

      await bqQuery(`INSERT INTO ${TBL_MOVIMIENTOS} (cedula, fecha, detalle, movimiento) VALUES (@ced, CURRENT_DATE(), @det, @monto)`,
        [{ name: 'ced', value: cedulaOrigen },
         { name: 'det', value: `Transferencia a cuenta ${cuentaDestino} - ${detalle || ''}` },
         { name: 'monto', value: -monto }]);

      await bqQuery(`INSERT INTO ${TBL_MOVIMIENTOS} (cedula, fecha, detalle, movimiento) VALUES (@ced, CURRENT_DATE(), @det, @monto)`,
        [{ name: 'ced', value: destino.cedula },
         { name: 'det', value: `Transferencia recibida - ${detalle || ''}` },
         { name: 'monto', value: monto }]);
    } else {
      await bqQuery(`UPDATE ${TBL_CLIENTES} SET estado_cuenta = 'INVESTIGACION' WHERE cedula = @cedula`,
        [{ name: 'cedula', value: cedulaOrigen }]);
    }

    res.json({
      ok:              estadoTx === 'COMPLETADA',
      estado:          estadoTx,
      idTransferencia,
      nombreDestino:   `${destino.nombres} ${destino.apellidos}`,
      alertas:         analisis.alertas,
      mensaje: estadoTx === 'COMPLETADA'
        ? `Transferencia exitosa a ${destino.nombres} ${destino.apellidos}`
        : `Transferencia bloqueada bajo investigación por: ${analisis.alertas.join(', ')}`
    });
  } catch (err) {
    console.error('Error transferencia:', err);
    res.status(500).json({ error: 'Error procesando la transferencia' });
  }
});

// ── GET /api/saldo/:cedula ─────────────────────
app.get('/api/saldo/:cedula', async (req, res) => {
  try {
    const rows = await bqQuery(`
      SELECT saldo_actual, numero_cuenta, estado_cuenta,
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

// ── GET /api/buscar-cuenta/:numero ────────────
app.get('/api/buscar-cuenta/:numero', async (req, res) => {
  try {
    const rows = await bqQuery(`
      SELECT nombres, apellidos, numero_cuenta
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

// ── Catch-all: sirve el frontend ───────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Iniciar servidor ───────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏦 La Gran Bancolombia API corriendo en puerto ${PORT}`);
});