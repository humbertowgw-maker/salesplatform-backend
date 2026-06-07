// ─── SALES PLATFORM · BACKEND SERVER ─────────────────────────────────────────
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const orgMiddleware = require("./middleware/org");
const { PLATFORM_NAME } = require("./lib/brand");

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's proxy
app.set("trust proxy", 1);

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: function(origin, callback) {
    if (!origin ||
        origin.includes('vercel.app') ||
        origin.includes('localhost')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: "Too many requests. Please slow down." },
});
app.use("/api/", limiter);

const callLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { error: "Call limit reached for this hour." },
});

// Org middleware — extracts org_id for all API routes
app.use("/api/", orgMiddleware);

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.use("/api/organizations", require("./routes/organizations"));
app.use("/api/billing",       require("./routes/billing"));
app.use("/api/businesses",    require("./routes/businesses"));
app.use("/api/fcc",           require("./routes/fcc"));
app.use("/api/leads",         require("./routes/leads"));
app.use("/api/appointments",  require("./routes/appointments"));
app.use("/api/google",        require("./routes/google"));
app.use("/api/reps",          require("./routes/reps"));
app.use("/api/calls",         callLimiter, require("./routes/calls"));
app.use("/api/texts",         require("./routes/texts"));
app.use("/api/webhooks",      require("./routes/webhooks"));
app.use("/api/intel",         require("./routes/intel"));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: `${PLATFORM_NAME} API`,
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(500).json({ error: "Internal server error", detail: err.message });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ ${PLATFORM_NAME} API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Env: ${process.env.NODE_ENV || "development"}\n`);
});
