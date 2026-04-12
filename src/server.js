require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const http = require("http");
const admin = require("firebase-admin");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "sms_secret_key";

// ─── MongoDB Connect ──────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URL, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
  .then(async () => {
    console.log("✅ MongoDB connected");
    // Create default admin user if not exists
    const adminExists = await User.findOne({ email: 'admin@bulksms.com' });
    if (!adminExists) {
      const hashed = await bcrypt.hash('admin123', 10);
      await User.create({ name: 'Admin', email: 'admin@bulksms.com', password: hashed });
      console.log("✅ Default admin created: admin@bulksms.com / admin123");
    }
  })
  .catch(e => console.error("❌ MongoDB error:", e.message));

// ─── Models ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, lowercase: true },
  password: String,
  createdAt: { type: Date, default: Date.now },
});
const User = mongoose.model("User", UserSchema);

const NumberListSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  deviceId: String, // optional - assign list to specific device
  name: String,
  numbers: [String],
  createdAt: { type: Date, default: Date.now },
});
const NumberList = mongoose.model("NumberList", NumberListSchema);

const ScheduledJobSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  deviceId: String,
  message: String,
  numbers: [String],
  delaySeconds: { type: Number, default: 0 },
  scheduledAt: Date,
  recurring: { type: String, default: "none" }, // none | daily | weekly
  status: { type: String, default: "pending" }, // pending | running | done | failed
  lastRun: Date,
  createdAt: { type: Date, default: Date.now },
});
const ScheduledJob = mongoose.model("ScheduledJob", ScheduledJobSchema);

const SavedMessageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  title: String,
  content: String,
  createdAt: { type: Date, default: Date.now },
});
const SavedMessage = mongoose.model("SavedMessage", SavedMessageSchema);

const MessageHistorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  deviceId: String,
  deviceName: String,
  phone: String,
  message: String,
  status: { type: String, default: "sent" }, // sent | failed
  sentAt: { type: Date, default: Date.now },
});
const MessageHistory = mongoose.model("MessageHistory", MessageHistorySchema);

// ─── Firebase Admin ───────────────────────────────────────────────────────────
let firebaseReady = false;
try {
  admin.initializeApp({ credential: admin.credential.cert(require("./firebase-service-account.json")) });
  firebaseReady = true;
  console.log("✅ Firebase Admin initialized");
} catch (e) {
  console.warn("⚠️  Firebase init failed:", e.message);
}

async function sendFcm(fcmToken, phone, message) {
  if (!fcmToken || !firebaseReady) return false;
  await admin.messaging().send({
    token: fcmToken,
    data: { type: "send_sms", phone, message },
    android: { priority: "high" },
  });
  return true;
}

// ─── In-memory devices ────────────────────────────────────────────────────────
const devices = {};

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("📱 New WebSocket connection");
  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "register") {
        ws.deviceId = data.deviceId;
        ws.userId = 'admin'; // All devices belong to admin
        const existing = devices[data.deviceId] || {};
        devices[data.deviceId] = {
          ws, userId: 'admin',
          deviceName: data.deviceName || data.deviceId,
          phoneNumber: data.phoneNumber || "",
          battery: data.battery ?? -1,
          charging: data.charging ?? false,
          network: data.network || "Unknown",
          fcmToken: data.fcmToken || existing.fcmToken || null,
          online: true,
          lastSeen: new Date().toISOString(),
        };
        console.log(`✅ Device registered: ${data.deviceId} | Phone: ${data.phoneNumber}`);
        ws.send(JSON.stringify({ type: "registered", deviceId: data.deviceId }));
      }
      if (data.type === "pong" && devices[data.deviceId]) {
        Object.assign(devices[data.deviceId], {
          battery: data.battery ?? devices[data.deviceId].battery,
          charging: data.charging ?? devices[data.deviceId].charging,
          network: data.network || devices[data.deviceId].network,
        });
      }
    } catch (e) { console.error("WS error:", e.message); }
  });

  ws.on("close", () => {
    console.log("📱 WebSocket disconnected");
    if (ws.deviceId && devices[ws.deviceId]) {
      devices[ws.deviceId].online = false;
      devices[ws.deviceId].ws = null;
      devices[ws.deviceId].lastSeen = new Date().toISOString();
    }
  });
});

// ─── Helper: send one SMS ─────────────────────────────────────────────────────
async function dispatchSms(deviceId, phone, message, userId = null) {
  const device = devices[deviceId];
  if (!device) return { ok: false, reason: "device_not_found" };
  
  let success = false;
  if (device.ws && device.online) {
    device.ws.send(JSON.stringify({ type: "send_sms", phone, message }));
    success = true;
  } else if (device.fcmToken) {
    await sendFcm(device.fcmToken, phone, message);
    success = true;
  }
  
  // Save to history
  if (userId) {
    await MessageHistory.create({
      userId,
      deviceId,
      deviceName: device.deviceName,
      phone,
      message,
      status: success ? "sent" : "failed",
    });
  }
  
  if (success) return { ok: true, via: device.ws ? "websocket" : "fcm" };
  return { ok: false, reason: "offline_no_fcm" };
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post("/auth/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
  if (await User.findOne({ email })) return res.status(409).json({ error: "Email already exists" });
  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email, password: hashed });
  const token = jwt.sign({ id: user._id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user._id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
});

app.get("/auth/me", auth, (req, res) => res.json(req.user));

// ─── Devices (show all for admin) ────────────────────────────────────────────
app.get("/devices", auth, (req, res) => {
  // Show all devices for admin user
  const list = Object.entries(devices)
    .map(([id, info]) => ({
      id, name: info.deviceName, phoneNumber: info.phoneNumber,
      battery: info.battery, charging: info.charging, network: info.network,
      online: info.online ?? false, hasFcm: !!info.fcmToken, lastSeen: info.lastSeen,
    }));
  res.json(list);
});

// ─── Number Lists ─────────────────────────────────────────────────────────────
app.get("/lists", auth, async (req, res) => {
  res.json(await NumberList.find({ userId: req.user.id }).sort("-createdAt"));
});

app.post("/lists", auth, async (req, res) => {
  const { name, numbers, deviceId } = req.body;
  if (!name || !Array.isArray(numbers)) return res.status(400).json({ error: "name and numbers[] required" });
  const list = await NumberList.create({ userId: req.user.id, name, numbers, deviceId });
  res.json(list);
});

app.put("/lists/:id", auth, async (req, res) => {
  const list = await NumberList.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { name: req.body.name, numbers: req.body.numbers, deviceId: req.body.deviceId },
    { new: true }
  );
  if (!list) return res.status(404).json({ error: "Not found" });
  res.json(list);
});

app.delete("/lists/:id", auth, async (req, res) => {
  await NumberList.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  res.json({ success: true });
});

// ─── Send SMS ─────────────────────────────────────────────────────────────────
app.post("/send", auth, async (req, res) => {
  const { deviceId, phone, message } = req.body;
  if (!deviceId || !phone || !message) return res.status(400).json({ error: "deviceId, phone, message required" });
  const result = await dispatchSms(deviceId, phone, message, req.user.id);
  if (!result.ok) return res.status(503).json({ error: result.reason });
  res.json({ success: true, via: result.via });
});

// ─── Send Bulk with delay ─────────────────────────────────────────────────────
app.post("/send-bulk", auth, async (req, res) => {
  const { deviceId, phones, message, delaySeconds = 0 } = req.body;
  if (!deviceId || !Array.isArray(phones) || !message)
    return res.status(400).json({ error: "deviceId, phones[], message required" });

  res.json({ success: true, queued: phones.length });

  // Send with delay in background
  (async () => {
    for (const phone of phones) {
      await dispatchSms(deviceId, phone, message, req.user.id);
      if (delaySeconds > 0) await new Promise(r => setTimeout(r, delaySeconds * 1000));
    }
  })();
});

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────
app.get("/jobs", auth, async (req, res) => {
  res.json(await ScheduledJob.find({ userId: req.user.id }).sort("-createdAt").limit(50));
});

app.post("/jobs", auth, async (req, res) => {
  const { deviceId, message, numbers, delaySeconds = 0, scheduledAt, recurring = "none" } = req.body;
  if (!deviceId || !message || !Array.isArray(numbers) || !scheduledAt)
    return res.status(400).json({ error: "deviceId, message, numbers[], scheduledAt required" });

  const job = await ScheduledJob.create({
    userId: req.user.id, deviceId, message, numbers,
    delaySeconds, scheduledAt: new Date(scheduledAt), recurring, status: "pending",
  });
  res.json(job);
});

app.delete("/jobs/:id", auth, async (req, res) => {
  await ScheduledJob.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  res.json({ success: true });
});

// ─── Saved Messages ───────────────────────────────────────────────────────────
app.get("/saved-messages", auth, async (req, res) => {
  res.json(await SavedMessage.find({ userId: req.user.id }).sort("-createdAt"));
});

app.post("/saved-messages", auth, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: "title and content required" });
  const msg = await SavedMessage.create({ userId: req.user.id, title, content });
  res.json(msg);
});

app.put("/saved-messages/:id", auth, async (req, res) => {
  const msg = await SavedMessage.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { title: req.body.title, content: req.body.content },
    { new: true }
  );
  if (!msg) return res.status(404).json({ error: "Not found" });
  res.json(msg);
});

app.delete("/saved-messages/:id", auth, async (req, res) => {
  await SavedMessage.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  res.json({ success: true });
});

// ─── Message History ──────────────────────────────────────────────────────────
app.get("/history", auth, async (req, res) => {
  const { deviceId, limit = 100 } = req.query;
  const query = { userId: req.user.id };
  if (deviceId) query.deviceId = deviceId;
  
  const history = await MessageHistory.find(query)
    .sort("-sentAt")
    .limit(parseInt(limit));
  
  const stats = await MessageHistory.aggregate([
    { $match: query },
    { $group: {
      _id: "$status",
      count: { $sum: 1 }
    }}
  ]);
  
  const sent = stats.find(s => s._id === "sent")?.count || 0;
  const failed = stats.find(s => s._id === "failed")?.count || 0;
  
  res.json({ history, stats: { sent, failed, total: sent + failed } });
});

app.delete("/history", auth, async (req, res) => {
  await MessageHistory.deleteMany({ userId: req.user.id });
  res.json({ success: true });
});

// ─── Scheduler: check every 30s ──────────────────────────────────────────────
setInterval(async () => {
  const now = new Date();
  const jobs = await ScheduledJob.find({ status: "pending", scheduledAt: { $lte: now } });
  for (const job of jobs) {
    await ScheduledJob.findByIdAndUpdate(job._id, { status: "running", lastRun: now });
    console.log(`🕐 Running job ${job._id} — ${job.numbers.length} numbers`);
    (async () => {
      try {
        const device = devices[job.deviceId];
        for (const phone of job.numbers) {
          await dispatchSms(job.deviceId, phone, job.message, job.userId);
          if (job.delaySeconds > 0) await new Promise(r => setTimeout(r, job.delaySeconds * 1000));
        }
        
        // Handle recurring jobs
        if (job.recurring === "daily") {
          // Schedule for next day at same time
          const nextRun = new Date(job.scheduledAt);
          nextRun.setDate(nextRun.getDate() + 1);
          await ScheduledJob.findByIdAndUpdate(job._id, { 
            status: "pending", 
            scheduledAt: nextRun 
          });
          console.log(`✅ Job ${job._id} done — Next run: ${nextRun.toLocaleString()}`);
        } else if (job.recurring === "weekly") {
          // Schedule for next week at same time
          const nextRun = new Date(job.scheduledAt);
          nextRun.setDate(nextRun.getDate() + 7);
          await ScheduledJob.findByIdAndUpdate(job._id, { 
            status: "pending", 
            scheduledAt: nextRun 
          });
          console.log(`✅ Job ${job._id} done — Next run: ${nextRun.toLocaleString()}`);
        } else {
          // One-time job
          await ScheduledJob.findByIdAndUpdate(job._id, { status: "done" });
          console.log(`✅ Job ${job._id} done`);
        }
      } catch (e) {
        await ScheduledJob.findByIdAndUpdate(job._id, { status: "failed" });
        console.error(`❌ Job ${job._id} failed:`, e.message);
      }
    })();
  }
}, 30000);

// Root endpoint - Browser pe dikhega
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bulk SMS Backend</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
        }
        .container {
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          border-radius: 20px;
          padding: 40px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
          max-width: 600px;
          text-align: center;
        }
        h1 { font-size: 2.5em; margin-bottom: 20px; }
        .status {
          background: #10b981;
          padding: 15px 30px;
          border-radius: 50px;
          display: inline-block;
          margin: 20px 0;
          font-weight: bold;
          font-size: 1.2em;
        }
        .info {
          background: rgba(255, 255, 255, 0.1);
          padding: 20px;
          border-radius: 10px;
          margin: 20px 0;
          text-align: left;
        }
        .info-item {
          padding: 10px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.2);
        }
        .info-item:last-child { border-bottom: none; }
        .label { font-weight: bold; color: #fbbf24; }
        .endpoints {
          background: rgba(0, 0, 0, 0.2);
          padding: 20px;
          border-radius: 10px;
          margin-top: 20px;
          text-align: left;
        }
        .endpoint { padding: 8px 0; font-family: monospace; }
        .method { 
          background: #3b82f6; 
          padding: 4px 8px; 
          border-radius: 4px; 
          font-size: 0.8em;
          margin-right: 10px;
        }
        .footer { margin-top: 30px; opacity: 0.8; font-size: 0.9em; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 Bulk SMS Backend</h1>
        <div class="status">✅ SERVER IS LIVE!</div>
        
        <div class="info">
          <div class="info-item">
            <span class="label">🌐 Server URL:</span> ${req.protocol}://${req.get('host')}
          </div>
          <div class="info-item">
            <span class="label">⏰ Started:</span> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
          </div>
          <div class="info-item">
            <span class="label">💾 Database:</span> ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}
          </div>
          <div class="info-item">
            <span class="label">🔥 Firebase:</span> ${firebaseReady ? '✅ Ready' : '⚠️ Not configured'}
          </div>
          <div class="info-item">
            <span class="label">📱 Connected Devices:</span> ${Object.keys(devices).length}
          </div>
        </div>

        <div class="endpoints">
          <h3 style="margin-bottom: 15px;">📋 API Endpoints:</h3>
          <div class="endpoint"><span class="method">POST</span> /auth/login</div>
          <div class="endpoint"><span class="method">POST</span> /auth/signup</div>
          <div class="endpoint"><span class="method">GET</span> /devices</div>
          <div class="endpoint"><span class="method">POST</span> /send</div>
          <div class="endpoint"><span class="method">POST</span> /send-bulk</div>
          <div class="endpoint"><span class="method">GET</span> /history</div>
          <div class="endpoint"><span class="method">GET</span> /ping</div>
        </div>

        <div class="footer">
          <p>🔒 Backend is running and ready to accept requests</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get("/ping", (req, res) => res.json({ ok: true }));

server.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
