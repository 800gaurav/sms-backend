require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const http = require("http");
const admin = require("firebase-admin");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

// CORS configuration
app.use(cors({
  origin: true,
  credentials: true
}));

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
  deviceId: String,
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
  recurring: { type: String, default: "none" },
  status: { type: String, default: "pending" },
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
  status: { type: String, default: "sent" },
  sentAt: { type: Date, default: Date.now },
});
const MessageHistory = mongoose.model("MessageHistory", MessageHistorySchema);

const DeviceSchema = new mongoose.Schema({
  deviceId: { type: String, unique: true, index: true, required: true },
  userId: { type: String, default: "admin" },
  deviceName: String,
  phoneNumber: String,
  battery: { type: Number, default: -1 },
  charging: { type: Boolean, default: false },
  network: { type: String, default: "Unknown" },
  fcmToken: String,
  online: { type: Boolean, default: false },
  lastSeen: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
const Device = mongoose.model("Device", DeviceSchema);

// ─── Firebase Admin ───────────────────────────────────────────────────────────
let firebaseReady = false;
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"));
  } else {
    serviceAccount = require("./firebase-service-account.json");
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  firebaseReady = true;
  console.log("✅ Firebase Admin initialized");
} catch (e) {
  console.warn("⚠️  Firebase init failed:", e.message);
}

async function sendFcm(fcmToken, phone, message) {
  if (!fcmToken || !firebaseReady) return false;
  try {
    await admin.messaging().send({
      token: fcmToken,
      data: { type: "send_sms", phone: String(phone), message: String(message) },
      android: { priority: "high" },
    });
    return true;
  } catch (e) {
    console.error("❌ FCM send failed:", e.message);
    return false;
  }
}

// ─── In-memory devices ────────────────────────────────────────────────────────
const devices = {};

async function saveDevice(deviceId, data = {}) {
  if (!deviceId) return null;

  const update = {
    userId: data.userId || "admin",
    deviceName: data.deviceName || deviceId,
    phoneNumber: data.phoneNumber || "",
    battery: data.battery ?? -1,
    charging: data.charging ?? false,
    network: data.network || "Unknown",
    online: data.online ?? false,
    lastSeen: data.lastSeen ? new Date(data.lastSeen) : new Date(),
    updatedAt: new Date(),
  };

  if (data.fcmToken) update.fcmToken = data.fcmToken;

  return Device.findOneAndUpdate(
    { deviceId },
    { $set: update, $setOnInsert: { deviceId, createdAt: new Date() } },
    { upsert: true, new: true }
  ).lean();
}

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

console.log("🔌 WebSocket server initialized");

wss.on("connection", (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`📱 New WebSocket connection from ${clientIp}`);
  
  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw);
      console.log(`📥 Received: ${data.type} from ${data.deviceId || 'unknown'}`);
      
      if (data.type === "register") {
        ws.deviceId = data.deviceId;
        ws.userId = 'admin';
        const stored = await Device.findOne({ deviceId: data.deviceId }).lean();
        const existing = devices[data.deviceId] || {};
        const fcmToken = data.fcmToken || existing.fcmToken || stored?.fcmToken || null;
        devices[data.deviceId] = {
          ws, userId: 'admin',
          deviceName: data.deviceName || stored?.deviceName || data.deviceId,
          phoneNumber: data.phoneNumber || stored?.phoneNumber || "",
          battery: data.battery ?? -1,
          charging: data.charging ?? false,
          network: data.network || "Unknown",
          fcmToken,
          online: true,
          lastSeen: new Date().toISOString(),
        };
        await saveDevice(data.deviceId, devices[data.deviceId]);
        console.log(`✅ Device registered: ${data.deviceId}`);
        console.log(`   Name: ${devices[data.deviceId].deviceName}`);
        console.log(`   Phone: ${devices[data.deviceId].phoneNumber}`);
        console.log(`   FCM: ${devices[data.deviceId].fcmToken ? 'Yes' : 'No'}`);
        ws.send(JSON.stringify({ type: "registered", deviceId: data.deviceId }));
      }
      
      if (data.type === "pong" && devices[data.deviceId]) {
        Object.assign(devices[data.deviceId], {
          battery: data.battery ?? devices[data.deviceId].battery,
          charging: data.charging ?? devices[data.deviceId].charging,
          network: data.network || devices[data.deviceId].network,
          online: true,
          lastSeen: new Date().toISOString(),
        });
        console.log(`🏓 Pong from ${data.deviceId}`);
      }
    } catch (e) { 
      console.error("❌ WS message error:", e.message); 
    }
  });

  ws.on("close", () => {
    console.log(`🔴 WebSocket disconnected: ${ws.deviceId || 'unknown'}`);
    if (ws.deviceId && devices[ws.deviceId]) {
      devices[ws.deviceId].online = false;
      devices[ws.deviceId].ws = null;
      devices[ws.deviceId].lastSeen = new Date().toISOString();
      Device.updateOne(
        { deviceId: ws.deviceId },
        { $set: { online: false, lastSeen: new Date(), updatedAt: new Date() } }
      ).catch(e => console.error("Device offline update failed:", e.message));
    }
  });

  ws.on("error", (error) => {
    console.error(`❌ WebSocket error: ${error.message}`);
  });
});

// ─── Helper: send one SMS ─────────────────────────────────────────────────────
async function dispatchSms(deviceId, phone, message, userId = null) {
  const stored = await Device.findOne({ deviceId }).lean();
  const live = devices[deviceId] || {};
  const device = (stored || live.deviceName) ? {
    ...stored,
    ...live,
    deviceName: live.deviceName || stored?.deviceName || deviceId,
    phoneNumber: live.phoneNumber || stored?.phoneNumber || "",
    fcmToken: live.fcmToken || stored?.fcmToken || null,
  } : null;
  if (!device) return { ok: false, reason: "device_not_found" };
  
  let success = false;
  let via = null;
  if (device.ws && device.online) {
    try {
      device.ws.send(JSON.stringify({ type: "send_sms", phone, message }));
      success = true;
      via = "websocket";
    } catch (e) {
      console.error("❌ WebSocket SMS dispatch failed:", e.message);
      success = false;
    }
  }

  if (!success && device.fcmToken) {
    success = await sendFcm(device.fcmToken, phone, message);
    if (success) via = "fcm";
  }
  
  if (userId) {
    await MessageHistory.create({
      userId, deviceId, deviceName: device.deviceName,
      phone, message, status: success ? "sent" : "failed",
    });
  }
  
  if (success) return { ok: true, via };
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
  try {
    const { email, password } = req.body;
    console.log('🔐 Login attempt:', email);
    
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    
    const user = await User.findOne({ email });
    if (!user) {
      console.log('❌ User not found:', email);
      return res.status(401).json({ error: "Invalid credentials" });
    }
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      console.log('❌ Invalid password for:', email);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    
    
    const token = jwt.sign(
      { id: user._id, name: user.name, email: user.email }, 
      JWT_SECRET, 
      { expiresIn: "7d" }
    );
    
    console.log('✅ Login successful:', email);
    return res.status(200).json({ 
      token, 
      user: { id: user._id, name: user.name, email: user.email } 
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/auth/me", auth, (req, res) => res.json(req.user));

// ─── Devices ──────────────────────────────────────────────────────────────────
app.get("/devices", auth, async (req, res) => {
  const storedDevices = await Device.find().sort("-lastSeen").lean();
  const merged = new Map();

  for (const info of storedDevices) {
    merged.set(info.deviceId, {
      id: info.deviceId,
      name: info.deviceName,
      phoneNumber: info.phoneNumber,
      battery: info.battery,
      charging: info.charging,
      network: info.network,
      online: info.online ?? false,
      hasFcm: !!info.fcmToken,
      lastSeen: info.lastSeen,
    });
  }

  for (const [id, info] of Object.entries(devices)) {
    merged.set(id, {
      id,
      name: info.deviceName,
      phoneNumber: info.phoneNumber,
      battery: info.battery,
      charging: info.charging,
      network: info.network,
      online: info.online ?? false,
      hasFcm: !!info.fcmToken,
      lastSeen: info.lastSeen,
    });
  }

  const list = Array.from(merged.values());
  res.json(list);
});

app.post("/devices/register", async (req, res) => {
  const { deviceId, deviceName, phoneNumber, battery, charging, network, fcmToken } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  
  const stored = await Device.findOne({ deviceId }).lean();
  const existing = devices[deviceId] || {};
  const savedFcmToken = fcmToken || existing.fcmToken || stored?.fcmToken || null;
  devices[deviceId] = {
    ws: existing.ws || null,
    userId: 'admin',
    deviceName: deviceName || stored?.deviceName || deviceId,
    phoneNumber: phoneNumber || stored?.phoneNumber || "",
    battery: battery ?? -1,
    charging: charging ?? false,
    network: network || "Unknown",
    fcmToken: savedFcmToken,
    online: existing.online || !!savedFcmToken,
    lastSeen: new Date().toISOString(),
  };
  await saveDevice(deviceId, devices[deviceId]);
  
  console.log(`✅ Device registered via HTTP: ${deviceId} | Phone: ${phoneNumber} | FCM: ${!!fcmToken}`);
  res.json({ success: true, deviceId });
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

app.post("/send-bulk", auth, async (req, res) => {
  const { deviceId, phones, message, delaySeconds = 0 } = req.body;
  if (!deviceId || !Array.isArray(phones) || !message)
    return res.status(400).json({ error: "deviceId, phones[], message required" });

  res.json({ success: true, queued: phones.length });

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

// ─── Scheduler ────────────────────────────────────────────────────────────────
setInterval(async () => {
  const now = new Date();
  const jobs = await ScheduledJob.find({ status: "pending", scheduledAt: { $lte: now } });
  for (const job of jobs) {
    await ScheduledJob.findByIdAndUpdate(job._id, { status: "running", lastRun: now });
    console.log(`🕐 Running job ${job._id} — ${job.numbers.length} numbers`);
    (async () => {
      try {
        for (const phone of job.numbers) {
          await dispatchSms(job.deviceId, phone, job.message, job.userId);
          if (job.delaySeconds > 0) await new Promise(r => setTimeout(r, job.delaySeconds * 1000));
        }
        
        if (job.recurring === "daily") {
          const nextRun = new Date(job.scheduledAt);
          nextRun.setDate(nextRun.getDate() + 1);
          await ScheduledJob.findByIdAndUpdate(job._id, { status: "pending", scheduledAt: nextRun });
          console.log(`✅ Job ${job._id} done — Next run: ${nextRun.toLocaleString()}`);
        } else if (job.recurring === "weekly") {
          const nextRun = new Date(job.scheduledAt);
          nextRun.setDate(nextRun.getDate() + 7);
          await ScheduledJob.findByIdAndUpdate(job._id, { status: "pending", scheduledAt: nextRun });
          console.log(`✅ Job ${job._id} done — Next run: ${nextRun.toLocaleString()}`);
        } else {
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

// ─── Root endpoint ────────────────────────────────────────────────────────────
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
      </div>
    </body>
    </html>
  `);
});

app.get("/ping", (req, res) => res.json({ ok: true }));

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.clear();
  console.log('\n' + '═'.repeat(60));
  console.log('🎉  BULK SMS BACKEND - SERVER IS LIVE!');
  console.log('═'.repeat(60));
  console.log(`✅  Status: RUNNING & READY`);
  console.log(`🌐  Local URL: http://localhost:${PORT}`);
  console.log(`📱  WebSocket: ws://localhost:${PORT}`);
  console.log(`🌍  Network URL: http://10.88.143.49:${PORT}`);
  console.log(`📱  WebSocket Network: ws://10.88.143.49:${PORT}`);
  console.log(`⏰  Started: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  console.log(`🔧  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('═'.repeat(60) + '\n');
});
