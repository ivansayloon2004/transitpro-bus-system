const path = require("path");
const fs = require("fs");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = path.join(__dirname, "transitpro-shared.db");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const BACKUP_DIR = path.join(__dirname, "backups");
const BACKUP_RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS backend_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  return crypto.randomUUID();
}

function dateTag(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function defaultState() {
  return {
    passengers: [],
    admins: [],
    buses: [],
    routes: [],
    schedules: [],
    seats: [],
    seatStates: [],
    bookings: [],
    tickets: [],
    auditLogs: [],
  };
}

function readSnapshot() {
  const row = db.prepare("SELECT value, updated_at FROM backend_meta WHERE key = ?").get("app_snapshot");
  if (!row) {
    const state = defaultState();
    const updatedAt = nowIso();
    db.prepare("INSERT INTO backend_meta (key, value, updated_at) VALUES (?, ?, ?)")
      .run("app_snapshot", JSON.stringify(state), updatedAt);
    return { state, updatedAt };
  }

  try {
    return {
      state: { ...defaultState(), ...JSON.parse(row.value) },
      updatedAt: row.updated_at,
    };
  } catch {
    const state = defaultState();
    const updatedAt = nowIso();
    db.prepare("UPDATE backend_meta SET value = ?, updated_at = ? WHERE key = ?")
      .run(JSON.stringify(state), updatedAt, "app_snapshot");
    return { state, updatedAt };
  }
}

function writeSnapshot(state) {
  const updatedAt = nowIso();
  db.prepare(`
    INSERT INTO backend_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run("app_snapshot", JSON.stringify({ ...defaultState(), ...state }), updatedAt);
  return updatedAt;
}

function normalizeContact(value) {
  return String(value || "").replace(/\s+/g, "");
}

function toSafePassenger(passenger) {
  return {
    id: passenger.id,
    name: passenger.name,
    contact: passenger.contact,
    role: passenger.role || "user",
    createdAt: passenger.createdAt,
  };
}

function toSafeAdmin(admin) {
  return {
    id: admin.id,
    username: admin.username,
    fullName: admin.fullName,
    createdAt: admin.createdAt,
  };
}

function getFilteredBookings(snapshotState, filters = {}) {
  return snapshotState.bookings.filter((booking) => {
    if (filters.start && booking.travelDate < filters.start) return false;
    if (filters.end && booking.travelDate > filters.end) return false;
    if (filters.status && filters.status !== "all" && booking.status !== filters.status) return false;
    if (filters.paymentMethod && filters.paymentMethod !== "all" && booking.paymentMethod !== filters.paymentMethod) return false;

    if (filters.routeId && filters.routeId !== "all") {
      const schedule = snapshotState.schedules.find((item) => item.id === booking.scheduleId);
      if (!schedule || schedule.routeId !== filters.routeId) return false;
    }

    if (filters.busId && filters.busId !== "all") {
      const schedule = snapshotState.schedules.find((item) => item.id === booking.scheduleId);
      if (!schedule || schedule.busId !== filters.busId) return false;
    }

    return true;
  });
}

function ensureBackupDirectory() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function pruneOldBackups() {
  ensureBackupDirectory();
  const files = fs.readdirSync(BACKUP_DIR)
    .map((fileName) => ({
      fileName,
      filePath: path.join(BACKUP_DIR, fileName),
      stats: fs.statSync(path.join(BACKUP_DIR, fileName)),
    }))
    .filter((entry) => entry.stats.isFile())
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

  const cutoff = Date.now() - (BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  files.forEach((entry, index) => {
    if (entry.stats.mtimeMs < cutoff || index >= BACKUP_RETENTION_DAYS * 2) {
      fs.unlinkSync(entry.filePath);
    }
  });
}

function createDailyBackup(reason = "scheduled") {
  ensureBackupDirectory();
  const tag = dateTag();
  const jsonBackupPath = path.join(BACKUP_DIR, `transitpro-backup-${tag}.json`);
  const dbBackupPath = path.join(BACKUP_DIR, `transitpro-backup-${tag}.db`);

  if (fs.existsSync(jsonBackupPath) && fs.existsSync(dbBackupPath)) {
    return false;
  }

  const snapshot = readSnapshot();
  fs.writeFileSync(jsonBackupPath, JSON.stringify({
    backupDate: nowIso(),
    reason,
    snapshot,
  }, null, 2));
  fs.copyFileSync(DB_PATH, dbBackupPath);
  pruneOldBackups();
  return true;
}

function startAutomaticBackups() {
  const createdOnStartup = createDailyBackup("startup");
  console.log(createdOnStartup
    ? `TransitPro daily backup created in ${BACKUP_DIR}`
    : `TransitPro daily backup already exists for ${dateTag()}`);

  setInterval(() => {
    try {
      const created = createDailyBackup("daily-check");
      if (created) {
        console.log(`TransitPro daily backup created in ${BACKUP_DIR}`);
      }
    } catch (error) {
      console.error("TransitPro automatic backup failed:", error);
    }
  }, 60 * 60 * 1000);
}

app.use(express.json({ limit: "10mb" }));

app.get("/api/snapshot", (req, res) => {
  res.json(readSnapshot());
});

app.post("/api/snapshot", (req, res) => {
  const { state } = req.body || {};
  if (!state || typeof state !== "object") {
    res.status(400).json({ error: "A valid state object is required." });
    return;
  }

  const updatedAt = writeSnapshot(state);
  res.json({ ok: true, updatedAt });
});

app.post("/api/auth/register", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const contact = normalizeContact(req.body?.contact);
  const password = String(req.body?.password || "");

  if (!name || !contact || !password) {
    res.status(400).json({ error: "Name, contact number, and password are required." });
    return;
  }

  const snapshot = readSnapshot();
  if (snapshot.state.passengers.some((passenger) => normalizeContact(passenger.contact) === contact)) {
    res.status(409).json({ error: "That contact number is already registered." });
    return;
  }

  const passenger = {
    id: uid(),
    name,
    contact,
    password,
    role: "user",
    createdAt: nowIso(),
  };

  snapshot.state.passengers.push(passenger);
  const updatedAt = writeSnapshot(snapshot.state);
  res.json({
    ok: true,
    updatedAt,
    passenger: toSafePassenger(passenger),
  });
});

app.post("/api/auth/login", (req, res) => {
  const contact = normalizeContact(req.body?.contact);
  const password = String(req.body?.password || "");
  const snapshot = readSnapshot();
  const passenger = snapshot.state.passengers.find(
    (item) => normalizeContact(item.contact) === contact && String(item.password || "") === password
  );

  if (!passenger) {
    res.status(401).json({ error: "Passenger account not found." });
    return;
  }

  res.json({
    ok: true,
    user: toSafePassenger(passenger),
    updatedAt: snapshot.updatedAt,
  });
});

app.post("/api/auth/admin-login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required." });
    return;
  }

  const snapshot = readSnapshot();

  if (!snapshot.state.admins.length) {
    const admin = {
      id: uid(),
      username,
      password,
      fullName: username,
      createdAt: nowIso(),
    };
    snapshot.state.admins.push(admin);
    const updatedAt = writeSnapshot(snapshot.state);
    res.json({
      ok: true,
      created: true,
      admin: toSafeAdmin(admin),
      updatedAt,
    });
    return;
  }

  const admin = snapshot.state.admins.find(
    (item) => String(item.username || "").trim() === username && String(item.password || "") === password
  );

  if (!admin) {
    res.status(401).json({ error: "Admin credentials are invalid." });
    return;
  }

  res.json({
    ok: true,
    admin: toSafeAdmin(admin),
    updatedAt: snapshot.updatedAt,
  });
});

app.get("/api/verify/:ticketCode", (req, res) => {
  const ticketCode = String(req.params.ticketCode || "").trim().toUpperCase();
  const snapshot = readSnapshot();
  const ticket = snapshot.state.tickets.find((item) => String(item.ticketCode || "").toUpperCase() === ticketCode);

  if (!ticket) {
    res.status(404).json({ error: "Ticket not found." });
    return;
  }

  const booking = snapshot.state.bookings.find((item) => item.id === ticket.bookingId);
  const schedule = booking ? snapshot.state.schedules.find((item) => item.id === booking.scheduleId) : null;
  const route = schedule ? snapshot.state.routes.find((item) => item.id === schedule.routeId) : null;
  const bus = schedule ? snapshot.state.buses.find((item) => item.id === schedule.busId) : null;

  res.json({
    ticket,
    booking,
    schedule,
    route,
    bus,
  });
});

app.get("/api/reports", (req, res) => {
  const snapshot = readSnapshot();
  const filters = {
    start: req.query.start || "",
    end: req.query.end || "",
    routeId: req.query.routeId || "all",
    busId: req.query.busId || "all",
    status: req.query.status || "all",
    paymentMethod: req.query.paymentMethod || "all",
  };

  const bookings = getFilteredBookings(snapshot.state, filters);
  const totalRevenue = bookings.reduce((sum, booking) => sum + Number(booking.totalFare || 0), 0);
  const seatsSold = bookings.reduce((sum, booking) => sum + Number((booking.seatNumbers || []).length || 0), 0);

  res.json({
    filters,
    summary: {
      bookings: bookings.length,
      revenue: totalRevenue,
      seatsSold,
      confirmed: bookings.filter((booking) => booking.status === "Confirmed").length,
      pending: bookings.filter((booking) => booking.status === "Pending").length,
      cancelled: bookings.filter((booking) => booking.status === "Cancelled").length,
    },
    bookings,
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "register.html"));
});

app.get("/admin-login", (req, res) => {
  res.sendFile(path.join(__dirname, "admin-login.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/verify", (req, res) => {
  res.sendFile(path.join(__dirname, "verify.html"));
});

app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.listen(PORT, HOST, () => {
  startAutomaticBackups();
  console.log(`TransitPro shared server running on http://localhost:${PORT}`);
  if (PUBLIC_BASE_URL) {
    console.log(`TransitPro public access enabled on ${PUBLIC_BASE_URL}`);
  } else {
    console.log("TransitPro public access is not configured yet. Set PUBLIC_BASE_URL after deployment.");
  }
});
