const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 5000;

// In-memory store
const devices = {};       // { deviceId: { ws, deviceName } }
const deviceContacts = {}; // { deviceId: [ { id, name, phone } ] }

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── WebSocket ───────────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);

      // Device registers itself
      if (data.type === "register") {
        ws.deviceId = data.deviceId;
        devices[data.deviceId] = {
          ws,
          deviceName: data.deviceName || data.deviceId,
          phoneNumber: data.phoneNumber || data.deviceId,
          battery: data.battery ?? -1,
          charging: data.charging ?? false,
          network: data.network || 'Unknown',
          online: true,
          lastSeen: new Date().toISOString(),
        };
        console.log("Device registered:", data.deviceId);
        ws.send(JSON.stringify({ type: "registered", deviceId: data.deviceId }));
      }

      // Device sends updated status (pong)
      if (data.type === "pong" && devices[data.deviceId]) {
        devices[data.deviceId].battery = data.battery ?? devices[data.deviceId].battery;
        devices[data.deviceId].charging = data.charging ?? devices[data.deviceId].charging;
        devices[data.deviceId].network = data.network || devices[data.deviceId].network;
      }
      

      // Device sends its contacts list
      if (data.type === "contacts") {
        deviceContacts[data.deviceId] = data.contacts;
        console.log(`Contacts received from ${data.deviceId}: ${data.contacts.length}`);
      }

    } catch (e) {
      console.error("Invalid message:", e.message);
    }
  });

  ws.on("close", () => {
    if (ws.deviceId && devices[ws.deviceId]) {
      devices[ws.deviceId].online = false;
      devices[ws.deviceId].ws = null;
      devices[ws.deviceId].lastSeen = new Date().toISOString();
      console.log("Device disconnected:", ws.deviceId);
    }
  });
});

// ─── REST API ────────────────────────────────────────────────────────────────

// GET /devices — all devices with online/offline status
app.get("/devices", (req, res) => {
  const list = Object.entries(devices).map(([id, info]) => ({
    id,
    name: info.deviceName,
    phoneNumber: info.phoneNumber,
    battery: info.battery,
    charging: info.charging,
    network: info.network,
    online: info.online ?? true,
    lastSeen: info.lastSeen || null,
  }));
  res.json(list);
});

// GET /contacts/:deviceId — contacts of a specific device
app.get("/contacts/:deviceId", (req, res) => {
  const contacts = deviceContacts[req.params.deviceId] || [];
  res.json(contacts);
});

// POST /contacts/refresh — ask device to resend contacts
app.post("/contacts/refresh", (req, res) => {
  const { deviceId } = req.body;
  const device = devices[deviceId];
  if (!device) return res.status(404).json({ error: "Device not connected" });
  device.ws.send(JSON.stringify({ type: "get_contacts" }));
  res.json({ success: true });
});

// POST /send — send SMS task to device
app.post("/send", (req, res) => {
  const { deviceId, phone, message } = req.body;

  if (!deviceId || !phone || !message) {
    return res.status(400).json({ error: "deviceId, phone, and message are required" });
  }

  const device = devices[deviceId];
  if (!device) return res.status(404).json({ error: "Device not connected" });

  device.ws.send(JSON.stringify({ type: "send_sms", phone, message }));
  res.json({ success: true });
});

// POST /send-bulk — send SMS to multiple phones at once
app.post("/send-bulk", (req, res) => {
  const { deviceId, phones, message } = req.body;

  if (!deviceId || !Array.isArray(phones) || !message) {
    return res.status(400).json({ error: "deviceId, phones[], and message are required" });
  }

  const device = devices[deviceId];
  if (!device) return res.status(404).json({ error: "Device not connected" });

  phones.forEach((phone) => {
    device.ws.send(JSON.stringify({ type: "send_sms", phone, message }));
  });

  res.json({ success: true, queued: phones.length });
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket on ws://localhost:${PORT}`);
});
