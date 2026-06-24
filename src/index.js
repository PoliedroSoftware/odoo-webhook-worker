export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET") {
        return json({
          ok: true,
          service: "Odoo Webhook Worker",
          message: "Worker activo"
        });
      }

      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      const token = url.searchParams.get("token") || request.headers.get("x-webhook-token");

      if (token !== env.WEBHOOK_SECRET) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      const body = await request.json();

      let result;

      if (body._model === "account.move") {
        result = await processInvoiceWebhook(body, env);
      } else if (body._model === "pos.order") {
        result = await processPosWebhook(body, env);
      } else {
        result = {
          event_type: "unknown",
          original_payload: body
        };
      }

      if (env.DESTINATION_API_URL) {
        ctx.waitUntil(forwardToDestination(result, env));
      }

      return json({
        ok: true,
        processed: result
      });

    } catch (error) {
      return json({
        ok: false,
        error: error.message
      }, 500);
    }
  }
};

async function processInvoiceWebhook(body, env) {
  const invoiceNumber = body.name || body.display_name;

  if (!invoiceNumber || invoiceNumber === "/") {
    throw new Error("No llegó número de factura válido");
  }

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
      "move_type",
      "state",
      "partner_id",
      "invoice_date",
      "invoice_date_due",
      "amount_untaxed",
      "amount_tax",
      "amount_total",
      "currency_id",
      "payment_state",
      "company_id",
      "invoice_line_ids"
    ],
    limit: 1
  });

  if (!invoices.length) {
    throw new Error(`Factura no encontrada: ${invoiceNumber}`);
  }

  const invoice = invoices[0];

  let lines = [];
  if (invoice.invoice_line_ids?.length > 0) {
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
        "currency_id"
      ]
    });
  }

  return {
    event_type: "invoice_confirmed",
    invoice,
    lines,
    original_payload: body
  };
}

async function processPosWebhook(body, env) {
  const posOrderId = body.id || body._id;

  if (!posOrderId) {
    throw new Error("No llegó ID de POS válido");
  }

  const uid = await authenticateOdoo(env);

  const orders = await executeKw(env, uid, "pos.order", "read", [
    [posOrderId]
  ], {
    fields: [
      "id",
      "name",
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
    throw new Error(`Pedido POS no encontrado: ${posOrderId}`);
  }

  const order = orders[0];

  let lines = [];
  if (order.lines?.length > 0) {
    lines = await executeKw(env, uid, "pos.order.line", "read", [
      order.lines
    ], {
      fields: [
        "id",
        "order_id",
        "product_id",
        "full_product_name",
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
  if (order.payment_ids?.length > 0) {
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
    order,
    lines,
    payments,
    original_payload: body
  };
}

async function authenticateOdoo(env) {
  const uid = await odooJsonRpc(env, "common", "authenticate", [
    env.ODOO_DB,
    env.ODOO_USERNAME,
    env.ODOO_API_KEY,
    {}
  ]);

  if (!uid) {
    throw new Error("No se pudo autenticar contra Odoo");
  }

  return uid;
}

async function executeKw(env, uid, model, method, args = [], kwargs = {}) {
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

  const data = await response.json();

  if (data.error) {
    throw new Error(JSON.stringify(data.error));
  }

  return data.result;
}

async function forwardToDestination(payload, env) {
  const response = await fetch(env.DESTINATION_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-token": env.DESTINATION_API_TOKEN || ""
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    console.log("Error reenviando a destino:", response.status);
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