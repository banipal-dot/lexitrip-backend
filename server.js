require("dotenv").config();
const express = require("express");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");
const Amadeus = require("amadeus");

const app = express();
app.use(express.json());

// Redis connection
let redis;
let redisConnected = false;
try {
  redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  redis.on("connect", () => {
    console.log("[ioredis] connected");
    redisConnected = true;
  });
  redis.on("error", (err) => {
    console.warn("[ioredis] error", err?.message || err);
    redisConnected = false;
  });
} catch (e) {
  console.warn("[ioredis] init failed", e.message || e);
  redisConnected = false;
}

const localHolds = new Map();
const HOLD_TTL = 600;

// Local+Redis storage functions
async function setHold(key, value) {
  if (redisConnected) {
    await redis.set(key, JSON.stringify(value), "EX", HOLD_TTL);
  } else {
    localHolds.set(key, { value, expiresAt: Date.now() + HOLD_TTL * 1000 });
  }
}
async function getHold(key) {
  if (redisConnected) {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } else {
    const rec = localHolds.get(key);
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) {
      localHolds.delete(key);
      return null;
    }
    return rec.value;
  }
}
async function delHold(key) {
  if (redisConnected) {
    await redis.del(key);
  } else {
    localHolds.delete(key);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of localHolds.entries()) {
    if (v.expiresAt <= now) localHolds.delete(k);
  }
}, 30000);

// Amadeus client setup
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
});

// Flight search route
app.get("/api/flights", async (req, res) => {
  try {
    const { origin, destination, date } = req.query;
    if (!origin || !destination || !date)
      return res.status(400).json({ error: "origin, destination, and date are required" });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });

    const response = await amadeus.shopping.flightOffersSearch.get({
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate: date,
      adults: 1,
      max: 5,
    });

    res.json(response.data);
  } catch (error) {
    console.error("Amadeus API error:", error?.response ? error.response.data : error);
    res.status(500).json({ error: error.message || "amadeus error" });
  }
});

// Create hold
app.post("/api/hold", async (req, res) => {
  try {
    const { userId, offerId, supplierPrice } = req.body;
    if (!offerId || typeof supplierPrice !== "number")
      return res.status(400).json({ error: "offerId & supplierPrice required (number)" });

    const holdId = uuidv4();
    const markup = +(supplierPrice * 0.15).toFixed(2);
    const total = Math.ceil(supplierPrice + markup);
    const hold = {
      holdId,
      userId,
      offerId,
      supplierPrice,
      markup,
      total,
      status: "HELD",
      createdAt: Date.now(),
    };

    await setHold(`hold:${holdId}`, hold);
    res.json({ holdId, total, expiresIn: HOLD_TTL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// Payment webhook
app.post("/api/payment/webhook", async (req, res) => {
  try {
    const { holdId, paymentId } = req.body;
    if (!holdId || !paymentId)
      return res.status(400).json({ error: "holdId & paymentId required" });

    const raw = await getHold(`hold:${holdId}`);
    if (!raw) return res.status(410).json({ error: "hold expired" });

    const hold = raw;
    if (hold.status !== "HELD")
      return res.status(409).json({ error: "invalid hold state" });

    const bookingRef = `LXT-${Math.floor(Math.random() * 900000) + 100000}`;
    hold.status = "BOOKED";
    hold.bookingRef = bookingRef;

    await delHold(`hold:${holdId}`);
    res.json({ success: true, bookingRef });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// Root route
app.get("/", (req, res) => res.send("LexiTrip backend running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));



