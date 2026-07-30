import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import MercadoPago from "mercadopago";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Inicializar SDK de Mercado Pago (versión 3.x)
const mp = new MercadoPago({
    accessToken: process.env.MP_ACCESS_TOKEN,
});

// CORS: por ahora abierto para pruebas; luego limita a tu dominio de frontend
app.use(
    cors({
        origin: "*",
        methods: ["GET", "POST"],
    }),
);

app.use(express.json());

// Ruta de prueba para saber si el backend está vivo
app.get("/", (_req, res) => {
    res.json({ ok: true, message: "Backend funcionando" });
});

// Construir header de autenticación Basic a partir de API Key + Secret
function getClipAuthHeader() {
    const apiKey = process.env.CLIP_API_KEY;
    const apiSecret = process.env.CLIP_API_SECRET;

    if (!apiKey || !apiSecret) {
        console.error("Faltan CLIP_API_KEY o CLIP_API_SECRET en las variables de entorno");
        return null;
    }

    const raw = `${apiKey}:${apiSecret}`;
    const base64 = Buffer.from(raw, "utf8").toString("base64");
    return `Basic ${base64}`;
}

// Ruta para crear el enlace de Checkout Redireccionado (Clip)
app.post("/api/clip/create-checkout", async(req, res) => {
    try {
        const { amount, placa, folio, estado, description } = req.body;

        if (!amount || !placa || !folio) {
            return res.status(400).json({
                success: false,
                error: "Datos incompletos para crear la orden (amount, placa, folio).",
            });
        }

        const clipBaseUrl = process.env.CLIP_BASE_URL;
        const authHeader = getClipAuthHeader();

        if (!clipBaseUrl || !authHeader) {
            console.error("Falta CLIP_BASE_URL o token de autenticación");
            return res.status(500).json({
                success: false,
                error: "Configuración incompleta de Clip.",
            });
        }

        // Cuerpo que envías a Clip
        const body = {
            amount: Number(amount),
            currency: "MXN",
            purchase_description: description || `Pago control vehicular ${placa} - folio ${folio}`,
            redirection_url: {
                success: `${process.env.FRONTEND_URL}/pago-exitoso?placa=${placa}&folio=${folio}`,
                error: `${process.env.FRONTEND_URL}/pago-error?placa=${placa}&folio=${folio}`,
                default: `${process.env.FRONTEND_URL}`,
            },
        };

        const clipRes = await fetch(`${clipBaseUrl}/v2/checkout`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: authHeader,
                accept: "application/json",
            },
            body: JSON.stringify(body),
        });

        console.log("Respuesta Clip status:", clipRes.status);

        if (!clipRes.ok) {
            const text = await clipRes.text();
            console.error("Error Clip:", clipRes.status, text);
            return res.status(502).json({
                success: false,
                error: "Error al comunicarse con Clip.",
            });
        }

        const clipData = await clipRes.json();
        console.log("Respuesta Clip JSON:", clipData);

        const checkoutUrl =
            clipData.checkout_url ||
            clipData.payment_request_url ||
            clipData.url;

        if (!checkoutUrl) {
            console.error("Clip no devolvió URL de checkout");
            return res.status(500).json({
                success: false,
                error: "Clip no devolvió una URL de checkout.",
            });
        }

        return res.json({
            success: true,
            checkout_url: checkoutUrl,
        });
    } catch (err) {
        console.error("Error create-checkout:", err);
        return res.status(500).json({
            success: false,
            error: "Error interno al crear el enlace de pago.",
        });
    }
});

// Ruta para crear preferencia de pago (Mercado Pago)
app.post("/api/mercadopago/create-preference", async(req, res) => {
    try {
        const { amount, placa, folio, description } = req.body;

        if (!amount || !placa) {
            return res.status(400).json({
                success: false,
                error: "Datos incompletos (amount, placa requeridos).",
            });
        }

        const preference = {
            items: [{
                title: description || `Pago de infracciones - Placa ${placa}`,
                unit_price: Number(amount),
                quantity: 1,
                currency_id: "MXN",
            }, ],
            back_urls: {
                success: `${process.env.FRONTEND_URL}/pago-exitoso?placa=${placa}&folio=${folio}`,
                failure: `${process.env.FRONTEND_URL}/pago-error?placa=${placa}&folio=${folio}`,
                pending: `${process.env.FRONTEND_URL}/pago-pendiente?placa=${placa}&folio=${folio}`,
            },
            auto_return: "approved",
            external_reference: folio || `F-${Date.now()}`,
            notification_url: `${process.env.BACKEND_URL}/api/mercadopago/webhook`,
        };

        const response = await mp.preferences.create(preference);

        return res.json({
            success: true,
            checkout_url: response.body.init_point,
            preference_id: response.body.id,
        });
    } catch (error) {
        console.error("Error creando preferencia MP:", error);
        res.status(500).json({
            success: false,
            error: error.message || "Error al crear preferencia de pago",
        });
    }
});

// Webhook de Mercado Pago para recibir notificaciones de pago
app.post("/api/mercadopago/webhook", async(req, res) => {
    try {
        const { action, data } = req.body;

        if (action === "payment.created" || action === "payment.updated") {
            const paymentId = data.id;
            const payment = await mp.payments.get(paymentId);

            if (payment.body.status === "approved") {
                console.log("Pago aprobado en MP:", payment.body.external_reference);
            }
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("Error en webhook MP:", error);
        res.status(500).send("Error");
    }
});

// Importante para Render: escuchar en process.env.PORT y host 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor escuchando en puerto ${PORT}`);
});