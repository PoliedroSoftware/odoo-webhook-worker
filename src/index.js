export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Prueba rápida desde navegador
      if (request.method === "GET") {
        return json({
          ok: true,
          service: "Odoo Webhook Worker",
          message: "Worker activo",
          timestamp: new Date().toISOString()
        });
      }

      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      // Token por query string o por header
      const tokenFromQuery = url.searchParams.get("token");
      const tokenFromHeader = request.headers.get("x-webhook-token");
      const token = tokenFromQuery || tokenFromHeader;

      console.log("Debug token:");
      console.log(JSON.stringify({
        tokenPresent: !!token,
        tokenLength: token ? token.length : 0,
        secretConfigured: !!env.WEBHOOK_SECRET,
        secretLength: env.WEBHOOK_SECRET ? env.WEBHOOK_SECRET.length : 0,
        matches: token === env.WEBHOOK_SECRET
      }, null, 2));

      if (token !== env.WEBHOOK_SECRET) {
        console.warn("Intento no autorizado");

        return json({
          ok: false,
          error: "Unauthorized",
          tokenPresent: !!token,
          tokenLength: token ? token.length : 0,
          secretConfigured: !!env.WEBHOOK_SECRET,
          secretLength: env.WEBHOOK_SECRET ? env.WEBHOOK_SECRET.length : 0
        }, 401);
      }

      const body = await request.json();

      console.log("Webhook recibido desde Odoo:");
      console.log(JSON.stringify(body, null, 2));

      /*
        IMPORTANTE:
        Respondemos rápido a Odoo para evitar que Odoo cierre la conexión.
        El procesamiento pesado queda en segundo plano con ctx.waitUntil().
      */
      ctx.waitUntil(handleWebhookInBackground(body, env));

      return json({
        ok: true,
        message: "Webhook recibido. Procesamiento iniciado en segundo plano.",
        model: body._model || null,
        id: body.id || body._id || null,
        received_at: new Date().toISOString()
      });

    } catch (error) {
      console.error("Error recibiendo webhook:");
      console.error(error.message);
      console.error(error.stack);

      return json({
        ok: false,
        error: error.message
      }, 500);
    }
  }
};

async function handleWebhookInBackground(body, env) {
  try {
    console.log("Procesamiento en segundo plano iniciado:");
    console.log(JSON.stringify(body, null, 2));

    let result;

    if (body._model === "account.move") {
      result = await processInvoiceWebhook(body, env);
    } else if (body._model === "pos.order") {
      result = await processPosWebhook(body, env);
    } else {
      result = {
        event_type: "unknown",
        message: "Modelo no reconocido",
        source_model: body._model || null,
        original_payload: body,
        processed_at: new Date().toISOString()
      };
    }

    console.log("Resultado procesado en segundo plano:");
    console.log(JSON.stringify(result, null, 2));

    if (env.DESTINATION_API_URL) {
      await forwardToDestination(result, env);
    }

  } catch (error) {
    console.error("Error procesando webhook en segundo plano:");
    console.error(error.message);
    console.error(error.stack);
  }
}

async function processInvoiceWebhook(body, env) {
  const invoiceNumber = body.name || body.display_name;

  if (!invoiceNumber || invoiceNumber === "/") {
    throw new Error("No llegó número de factura válido en el webhook");
  }

  console.log(`Procesando factura: ${invoiceNumber}`);

  const uid = await authenticateOdoo(env);

  const invoices = await executeKw(env, uid, "account.move", "search_read", [
    [
      ["name", "=", invoiceNumber],
      ["move_type", "=", "out_invoice"]
    ]
  ], {
    fields: [
      "id",
      "name",
      "display_name",
      "move_type",
      "state",
      "partner_id",
      "invoice_partner_display_name",
      "invoice_date",
      "invoice_date_due",
      "amount_untaxed",
      "amount_tax",
      "amount_total",
      "amount_residual",
      "amount_paid",
      "currency_id",
      "payment_state",
      "company_id",
      "invoice_origin",
      "payment_reference",
      "ref",
      "invoice_line_ids"
    ],
    limit: 1
  });

  if (!invoices.length) {
    throw new Error(`Factura no encontrada en Odoo: ${invoiceNumber}`);
  }

  const invoice = invoices[0];

  let lines = [];

  if (invoice.invoice_line_ids && invoice.invoice_line_ids.length > 0) {
    lines = await executeKw(env, uid, "account.move.line", "read", [
      invoice.invoice_line_ids
    ], {
      fields: [
        "id",
        "move_id",
        "product_id",
        "name",
        "quantity",
        "price_unit",
        "discount",
        "price_subtotal",
        "price_total",
        "tax_ids",
        "account_id",
        "currency_id"
      ]
    });
  }

  return {
    event_type: "invoice_confirmed",
    source_model: body._model,
    source_id: body._id || body.id || invoice.id,
    invoice_number: invoice.name,
    invoice,
    lines,
    original_payload: body,
    processed_at: new Date().toISOString()
  };
}

async function processPosWebhook(body, env) {
  const posOrderId = body.id || body._id;

  if (!posOrderId) {
    throw new Error("No llegó ID de POS válido en el webhook");
  }

  console.log(`Procesando pedido POS ID: ${posOrderId}`);

  const uid = await authenticateOdoo(env);

  const orders = await executeKw(env, uid, "pos.order", "read", [
    [posOrderId]
  ], {
    fields: [
      "id",
      "name",
      "display_name",
      "pos_reference",
      "state",
      "date_order",
      "amount_total",
      "amount_tax",
      "amount_paid",
      "amount_return",
      "partner_id",
      "session_id",
      "config_id",
      "user_id",
      "company_id",
      "currency_id",
      "lines",
      "payment_ids"
    ]
  });

  if (!orders.length) {
    throw new Error(`Pedido POS no encontrado en Odoo: ${posOrderId}`);
  }

  const order = orders[0];

  let lines = [];

  if (order.lines && order.lines.length > 0) {
    lines = await executeKw(env, uid, "pos.order.line", "read", [
      order.lines
    ], {
      fields: [
        "id",
        "order_id",
        "product_id",
        "name",
        "qty",
        "price_unit",
        "discount",
        "price_subtotal",
        "price_subtotal_incl",
        "tax_ids"
      ]
    });
  }

  let payments = [];

  if (order.payment_ids && order.payment_ids.length > 0) {
    payments = await executeKw(env, uid, "pos.payment", "read", [
      order.payment_ids
    ], {
      fields: [
        "id",
        "pos_order_id",
        "payment_method_id",
        "amount",
        "payment_date"
      ]
    });
  }

  return {
    event_type: "pos_order_paid",
    source_model: body._model,
    source_id: body._id || body.id || order.id,
    pos_reference: order.pos_reference,
    order,
    lines,
    payments,
    original_payload: body,
    processed_at: new Date().toISOString()
  };
}

async function authenticateOdoo(env) {
  console.log("Autenticando contra Odoo...");

  validateRequiredEnv(env, [
    "ODOO_URL",
    "ODOO_DB",
    "ODOO_USERNAME",
    "ODOO_API_KEY"
  ]);

  const uid = await odooJsonRpc(env, "common", "authenticate", [
    env.ODOO_DB,
    env.ODOO_USERNAME,
    env.ODOO_API_KEY,
    {}
  ]);

  if (!uid) {
    throw new Error("No se pudo autenticar contra Odoo. Revisa ODOO_DB, ODOO_USERNAME y ODOO_API_KEY.");
  }

  console.log(`Autenticación correcta. UID: ${uid}`);

  return uid;
}

async function executeKw(env, uid, model, method, args = [], kwargs = {}) {
  console.log(`Ejecutando Odoo: ${model}.${method}`);

  return await odooJsonRpc(env, "object", "execute_kw", [
    env.ODOO_DB,
    uid,
    env.ODOO_API_KEY,
    model,
    method,
    args,
    kwargs
  ]);
}

async function odooJsonRpc(env, service, method, args) {
  const baseUrl = env.ODOO_URL.replace(/\/$/, "");
  const endpoint = `${baseUrl}/jsonrpc`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: {
        service,
        method,
        args
      },
      id: Date.now()
    })
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Odoo respondió algo que no es JSON. HTTP ${response.status}. Respuesta: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Error HTTP consultando Odoo. Status: ${response.status}. Respuesta: ${text}`);
  }

  if (data.error) {
    throw new Error(`Error JSON-RPC de Odoo: ${JSON.stringify(data.error)}`);
  }

  return data.result;
}

async function forwardToDestination(payload, env) {
  try {
    console.log("Reenviando resultado a DESTINATION_API_URL...");

    const response = await fetch(env.DESTINATION_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": env.DESTINATION_API_TOKEN || ""
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Error reenviando a destino:");
      console.error(`HTTP ${response.status}: ${text}`);
      return;
    }

    console.log("Resultado reenviado correctamente.");

  } catch (error) {
    console.error("Error en forwardToDestination:");
    console.error(error.message);
    console.error(error.stack);
  }
}

function validateRequiredEnv(env, names) {
  const missing = names.filter((name) => !env[name]);

  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}