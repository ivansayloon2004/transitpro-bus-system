const SESSION_KEY = "transitpro-session-v1";
const DB_NAME = "transitpro-browser-db-clean";
const DB_VERSION = 3;
const STORE_NAMES = [
  "meta",
  "passengers",
  "admins",
  "buses",
  "routes",
  "schedules",
  "seats",
  "seatStates",
  "bookings",
  "tickets",
  "auditLogs",
  "staff",
  "scheduleTemplates",
];

const state = {
  db: {
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
    staff: [],
    scheduleTemplates: [],
  },
  session: loadSession(),
  bookingSearch: null,
  selectedScheduleId: null,
  selectedAdminScheduleId: null,
  selectedManifestScheduleId: null,
  selectedSeats: [],
  activeView: "routesView",
  activeAdminPanel: "adminOverview",
  printBookingId: null,
  lastReceipt: null,
  serverSnapshotUpdatedAt: null,
  reportFilters: {
    start: "",
    end: "",
    routeId: "all",
    busId: "all",
    status: "all",
    paymentMethod: "all",
  },
};

let dbPromise;
const syncChannel = "BroadcastChannel" in window ? new BroadcastChannel("transitpro-sync") : null;

const pageMode = document.body.dataset.page || "main";

function $(id) {
  return document.getElementById(id);
}

function announceDataChange(reason) {
  if (syncChannel) {
    syncChannel.postMessage({ type: "refresh", reason, pageMode, timestamp: Date.now() });
  }
}

function getRequiredFormValue(formData, fieldName, label) {
  const value = formData.get(fieldName);
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return String(value).trim();
}

function loadSession() {
  const session = localStorage.getItem(SESSION_KEY);
  return session ? JSON.parse(session) : null;
}

function saveSession() {
  if (state.session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
  if (syncChannel) {
    syncChannel.postMessage({ type: "session", pageMode, timestamp: Date.now() });
  }
}

function uid() {
  return crypto.randomUUID();
}

function todayPlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("Transaction failed."));
  });
}

function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        STORE_NAMES.forEach((storeName) => {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: "id" });
          }
        });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function getAllFromStore(storeName) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).getAll());
}

async function loadAppData() {
  await ensureSeedData();
  const [passengers, admins, buses, routes, schedules, seats, seatStates, bookings, tickets, auditLogs, staff, scheduleTemplates] = await Promise.all([
    getAllFromStore("passengers"),
    getAllFromStore("admins"),
    getAllFromStore("buses"),
    getAllFromStore("routes"),
    getAllFromStore("schedules"),
    getAllFromStore("seats"),
    getAllFromStore("seatStates"),
    getAllFromStore("bookings"),
    getAllFromStore("tickets"),
    getAllFromStore("auditLogs"),
    getAllFromStore("staff"),
    getAllFromStore("scheduleTemplates"),
  ]);

  state.db = {
    passengers: passengers.sort((a, b) => a.name.localeCompare(b.name)),
    admins: admins.sort((a, b) => a.username.localeCompare(b.username)),
    buses: buses.sort((a, b) => a.plateNumber.localeCompare(b.plateNumber)),
    routes: routes.sort((a, b) => `${a.origin}-${a.destination}`.localeCompare(`${b.origin}-${b.destination}`)),
    schedules: schedules.sort((a, b) => `${a.date}${a.departureTime}`.localeCompare(`${b.date}${b.departureTime}`)),
    seats: seats.sort((a, b) => `${a.busId}${a.seatNumber}`.localeCompare(`${b.busId}${b.seatNumber}`)),
    seatStates: seatStates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    bookings: bookings.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    tickets: tickets.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)),
    auditLogs: auditLogs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    staff: staff.sort((a, b) => `${a.role}${a.name}`.localeCompare(`${b.role}${b.name}`)),
    scheduleTemplates: scheduleTemplates.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function ensureSeedData() {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAMES, "readwrite");
  const metaStore = transaction.objectStore("meta");
  const seeded = await requestToPromise(metaStore.get("seeded"));

  if (seeded) {
    transaction.abort();
    try {
      await transactionDone(transaction);
    } catch (error) {
      return;
    }
    return;
  }
  metaStore.add({ id: "seeded", value: "true", createdAt: new Date().toISOString() });

  await transactionDone(transaction);
}

async function replaceLocalData(nextState) {
  const db = await openDatabase();
  const writableStores = STORE_NAMES.filter((storeName) => storeName !== "meta");
  const transaction = db.transaction(writableStores, "readwrite");

  writableStores.forEach((storeName) => {
    transaction.objectStore(storeName).clear();
  });

  writableStores.forEach((storeName) => {
    const records = Array.isArray(nextState?.[storeName]) ? nextState[storeName] : [];
    const store = transaction.objectStore(storeName);
    records.forEach((record) => store.add(record));
  });

  await transactionDone(transaction);
}

function getRecordCount(snapshotState) {
  return Object.values(snapshotState || {}).reduce((sum, records) => sum + (Array.isArray(records) ? records.length : 0), 0);
}

function shouldPreferLocalData(localRecordCount, remoteRecordCount, force = false) {
  if (localRecordCount === 0) return false;
  if (remoteRecordCount === 0) return true;
  if (force) return remoteRecordCount < localRecordCount;
  return remoteRecordCount < localRecordCount;
}

async function pullSnapshotFromServer(force = false) {
  try {
    const response = await fetch("/api/snapshot");
    if (!response.ok) return { remoteRecordCount: 0, replaced: false };
    const payload = await response.json();
    if (!payload?.state) return { remoteRecordCount: 0, replaced: false };

    const localRecordCount = getRecordCount(state.db);
    const remoteRecordCount = getRecordCount(payload.state);
    if (shouldPreferLocalData(localRecordCount, remoteRecordCount, force)) {
      state.serverSnapshotUpdatedAt = payload.updatedAt || state.serverSnapshotUpdatedAt;
      return { remoteRecordCount, replaced: false, protectedLocal: true };
    }
    const shouldReplace = (force && (remoteRecordCount > 0 || localRecordCount === 0))
      || !state.serverSnapshotUpdatedAt
      || (payload.updatedAt && payload.updatedAt > state.serverSnapshotUpdatedAt)
      || (localRecordCount === 0 && remoteRecordCount > 0);

    if (!shouldReplace) {
      state.serverSnapshotUpdatedAt = payload.updatedAt || state.serverSnapshotUpdatedAt;
      return { remoteRecordCount, replaced: false };
    }

    await replaceLocalData(payload.state);
    state.serverSnapshotUpdatedAt = payload.updatedAt || null;
    await loadAppData();
    return { remoteRecordCount, replaced: true };
  } catch (error) {
    console.error("Server sync pull failed:", error);
    return { remoteRecordCount: 0, replaced: false };
  }
}

async function pushSnapshotToServer() {
  try {
    const response = await fetch("/api/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: state.db }),
    });
    if (!response.ok) return;
    const payload = await response.json();
    state.serverSnapshotUpdatedAt = payload.updatedAt || state.serverSnapshotUpdatedAt;
  } catch (error) {
    console.error("Server sync push failed:", error);
  }
}

async function syncLocalDataToServer() {
  await loadAppData();
  const localRecordCount = getRecordCount(state.db);
  if (localRecordCount === 0) {
    showToast("No local browser data found to sync yet.");
    return;
  }
  await pushSnapshotToServer();
  announceDataChange("manual-sync");
  showToast("This device data was synced to the shared server.");
}

function buildBackupSnapshot() {
  return {
    exportedAt: new Date().toISOString(),
    app: "TransitPro",
    version: 1,
    state: state.db,
  };
}

function exportJsonBackup() {
  const snapshot = buildBackupSnapshot();
  downloadTextFile(
    `transitpro-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(snapshot, null, 2),
    "application/json;charset=utf-8"
  );
  showToast("Backup downloaded.");
}

function normalizeImportedState(payload) {
  if (payload?.state && typeof payload.state === "object") {
    return payload.state;
  }
  if (payload && typeof payload === "object") {
    return payload;
  }
  throw new Error("Backup file is invalid.");
}

async function importJsonBackup(file) {
  if (!file) return;
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Backup file is not valid JSON.");
  }

  const importedState = normalizeImportedState(payload);
  const sanitizedState = STORE_NAMES
    .filter((storeName) => storeName !== "meta")
    .reduce((accumulator, storeName) => {
      accumulator[storeName] = Array.isArray(importedState[storeName]) ? importedState[storeName] : [];
      return accumulator;
    }, {});

  await replaceLocalData(sanitizedState);
  await loadAppData();
  await pushSnapshotToServer();
  announceDataChange("import-backup");
  showToast("Backup restored and synced to the server.");
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function showToast(message) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDuration(route) {
  const hours = Number(route?.travelHours || 0);
  const minutes = Number(route?.travelMinutes || 0);
  if (!hours && !minutes) return "0 min";
  if (!minutes) return `${hours} hr${hours === 1 ? "" : "s"}`;
  if (!hours) return `${minutes} min`;
  return `${hours} hr ${minutes} min`;
}

function getScheduleFare(schedule) {
  return Number(schedule?.fare || 0);
}

function parseStopFares(value) {
  if (!String(value || "").trim()) return {};
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const [stopName, fareValue] = entry.split(":").map((part) => String(part || "").trim());
      if (!stopName || fareValue === "") {
        throw new Error("Stop fares must use the format Stop:Amount.");
      }
      const fare = Number(fareValue);
      if (!Number.isFinite(fare) || fare < 0) {
        throw new Error(`Invalid fare for stop "${stopName}".`);
      }
      accumulator[stopName] = fare;
      return accumulator;
    }, {});
}

function getRouteStopFares(route) {
  return route?.stopFares && typeof route.stopFares === "object" ? route.stopFares : {};
}

function getScheduleStopFares(schedule) {
  return schedule?.stopFares && typeof schedule.stopFares === "object" ? schedule.stopFares : {};
}

function formatScheduleStopFareSummary(schedule, route = null) {
  const scheduleEntries = Object.entries(getScheduleStopFares(schedule));
  if (scheduleEntries.length) {
    return scheduleEntries.map(([stop, fare]) => `${stop}: ${formatCurrency(fare)}`).join(" | ");
  }
  return "Uses final schedule fare";
}

function getDestinationFare(route, schedule, destination) {
  const scheduleStopFares = getScheduleStopFares(schedule);
  if (destination && scheduleStopFares[destination] !== undefined) {
    return Number(scheduleStopFares[destination]);
  }
  return getScheduleFare(schedule);
}

function toMinutes(timeValue) {
  const [hours, minutes] = String(timeValue || "00:00").split(":").map(Number);
  return (hours * 60) + minutes;
}

function normalizeStops(value) {
  return String(value || "")
    .split(",")
    .map((stop) => stop.trim())
    .filter(Boolean);
}

function buildMonthDates(primaryDate, mode) {
  const [year, month, day] = String(primaryDate || "").split("-").map(Number);
  if (!year || !month || !day) return [];
  const lastDay = new Date(year, month, 0).getDate();
  const startDay = mode === "fullMonth" ? 1 : day;
  const dates = [];
  for (let currentDay = startDay; currentDay <= lastDay; currentDay += 1) {
    dates.push(`${year}-${String(month).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}`);
  }
  return dates;
}

function parseScheduleDates(primaryDate, additionalDatesValue, batchMode = "single", isEditing = false) {
  const dates = [String(primaryDate || "").trim()];
  if (!isEditing && batchMode && batchMode !== "single") {
    dates.push(...buildMonthDates(primaryDate, batchMode));
  }
  if (!isEditing && String(additionalDatesValue || "").trim()) {
    dates.push(
      ...String(additionalDatesValue)
        .split(/[\n,]/)
        .map((dateValue) => dateValue.trim())
        .filter(Boolean)
    );
  }

  const uniqueDates = [...new Set(dates)];
  uniqueDates.forEach((dateValue) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      throw new Error(`Invalid travel date "${dateValue}". Use YYYY-MM-DD.`);
    }
  });
  return uniqueDates;
}

function getRouteStops(route) {
  if (!route) return [];
  return Array.isArray(route.stops) ? route.stops : normalizeStops(route.stops);
}

function routeServesDestination(route, destination) {
  if (!route || !destination) return false;
  return route.destination === destination || getRouteStops(route).includes(destination);
}

function formatRouteLabel(route) {
  if (!route) return "Unknown route";
  const stops = getRouteStops(route);
  return stops.length
    ? `${route.origin} -> ${stops.join(" -> ")} -> ${route.destination}`
    : `${route.origin} -> ${route.destination}`;
}

function getBookingStatusClass(status) {
  if (status === "Confirmed") return "status-confirmed";
  if (status === "Cancelled") return "status-cancelled";
  if (status === "Pending") return "status-pending";
  return "";
}

function getBoardingStatusClass(status) {
  if (status === "Checked In") return "status-checked-in";
  if (status === "Boarded") return "status-boarded";
  if (status === "No Show") return "status-no-show";
  return "status-pending";
}

function getPaymentStatusClass(status) {
  if (status === "Paid") return "payment-paid";
  if (status === "Unpaid") return "payment-unpaid";
  return "payment-processing";
}

async function logAuditAction(action, details) {
  if (!state.session || state.session.role !== "admin") return;
  const db = await openDatabase();
  const transaction = db.transaction("auditLogs", "readwrite");
  transaction.objectStore("auditLogs").add({
    id: uid(),
    action,
    details,
    adminId: state.session.id,
    adminName: state.session.name,
    createdAt: new Date().toISOString(),
  });
  await transactionDone(transaction);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDisplayDate(dateValue) {
  if (!dateValue) return "Not scheduled";
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateValue;
  return parsed.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDisplayDateTime(dateValue) {
  if (!dateValue) return "Not available";
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return dateValue;
  return parsed.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getPaymentDetails() {
  return {
    paymentMethod: $("paymentMethodSelect")?.value || "",
    paymentReference: $("paymentReferenceInput")?.value.trim() || "",
  };
}

function getPaymentReferenceLabel(method) {
  if (method === "GCash" || method === "Maya") return "Wallet Number / Account Name";
  if (method === "Bank Transfer") return "Bank Reference / Account Name";
  return "Payment Reference";
}

function renderPaymentHelper() {
  const helper = $("paymentHelper");
  if (!helper) return;
  const { paymentMethod, paymentReference } = getPaymentDetails();
  const seats = state.selectedSeats.length;
  if (!state.selectedScheduleId || !state.bookingSearch) {
    helper.textContent = "Select seats and a payment method to simulate payment.";
    return;
  }

  const schedule = getSchedule(state.selectedScheduleId);
  const total = getDestinationFare(getRoute(schedule.routeId), schedule, state.bookingSearch?.destination) * seats;
  if (!paymentMethod) {
    helper.textContent = `Amount due: ${formatCurrency(total)}. Choose a payment method to continue.`;
    return;
  }

  helper.innerHTML = `<strong>${paymentMethod}</strong><br />Simulated payment amount: ${formatCurrency(total)}${paymentReference ? `<br />Reference: ${paymentReference}` : ""}`;
  const referenceInput = $("paymentReferenceInput");
  if (referenceInput) {
    referenceInput.placeholder = paymentMethod
      ? `Enter ${getPaymentReferenceLabel(paymentMethod).toLowerCase()}`
      : "Example: Juan Dela Cruz / 1234";
  }
}

function closePaymentModal() {
  const backdrop = $("paymentModalBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("show");
}

function setPaymentModalState({
  eyebrow = "Checkout",
  title = "Confirm Mock Payment",
  secondaryLabel = "Back",
  secondaryAction = "back",
  primaryLabel = "Complete Payment",
  primaryAction = "complete",
}) {
  if ($("paymentModalEyebrow")) $("paymentModalEyebrow").textContent = eyebrow;
  if ($("paymentModalTitle")) $("paymentModalTitle").textContent = title;
  if ($("cancelPaymentModalBtn")) {
    $("cancelPaymentModalBtn").textContent = secondaryLabel;
    $("cancelPaymentModalBtn").dataset.action = secondaryAction;
  }
  if ($("completePaymentBtn")) {
    $("completePaymentBtn").textContent = primaryLabel;
    $("completePaymentBtn").dataset.action = primaryAction;
  }
}

function getLatestRelevantBooking() {
  const relevantBookings = state.session && state.session.role === "user"
    ? state.db.bookings.filter((booking) => booking.userId === state.session.id)
    : state.db.bookings;
  return [...relevantBookings].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

function getBookingTicketBundle(bookingId = null) {
  const booking = bookingId
    ? state.db.bookings.find((item) => item.id === bookingId)
    : getLatestRelevantBooking();
  if (!booking) return null;
  const schedule = getSchedule(booking.scheduleId);
  const route = schedule ? getRoute(schedule.routeId) : null;
  const bus = schedule ? getBus(schedule.busId) : null;
  const ticket = getTicketByBooking(booking.id);
  return { booking, schedule, route, bus, ticket };
}

function buildPrintableTicketMarkup(bundle, options = {}) {
  if (!bundle) {
    return `
      <div class="print-ticket-shell">
        <div class="print-ticket-header">
          <div>
            <p class="eyebrow">TransitPro Terminal Suite</p>
            <h2>No ticket available</h2>
          </div>
        </div>
      </div>
    `;
  }

  const { booking, schedule, route, bus, ticket } = bundle;
  const stops = route ? getRouteStops(route) : [];
  const barcodeDigits = (ticket?.ticketCode || booking.id || "TRANSITPRO")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(-12)
    .padStart(12, "0");
  const label = options.label || "Printable E-Ticket";

  return `
    <div class="print-ticket-shell ${options.receipt ? "receipt-mode" : ""}">
      <div class="print-ticket-header">
        <div>
          <p class="eyebrow">${escapeHtml(label)}</p>
          <h2>${escapeHtml(booking.origin)} to ${escapeHtml(booking.destination)}</h2>
          <p class="muted">TransitPro passenger document generated from browser storage.</p>
        </div>
        <div class="print-ticket-statuses">
          <span class="inline-pill ${getBookingStatusClass(booking.status)}">${escapeHtml(booking.status)}</span>
          <span class="inline-pill ${getPaymentStatusClass(booking.paymentStatus || "Unpaid")}">${escapeHtml(booking.paymentStatus || "Unpaid")}</span>
        </div>
      </div>

      <div class="print-ticket-grid">
        <div class="print-ticket-card">
          <span>Passenger</span>
          <strong>${escapeHtml(booking.passengerName)}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Contact</span>
          <strong>${escapeHtml(booking.contactNumber)}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Ticket Code</span>
          <strong>${escapeHtml(ticket ? ticket.ticketCode : "Pending")}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Travel Date</span>
          <strong>${escapeHtml(formatDisplayDate(booking.travelDate))}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Departure</span>
          <strong>${escapeHtml(schedule ? schedule.departureTime : "--:--")}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Arrival</span>
          <strong>${escapeHtml(schedule ? schedule.arrivalTime : "--:--")}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Bus</span>
          <strong>${escapeHtml(bus ? `${bus.plateNumber} | ${bus.busType}` : "Not assigned")}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Seats</span>
          <strong>${escapeHtml(booking.seatNumbers.join(", "))}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Passengers</span>
          <strong>${escapeHtml(booking.passengerCount)}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Total Fare</span>
          <strong>${escapeHtml(formatCurrency(booking.totalFare))}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Payment Method</span>
          <strong>${escapeHtml(booking.paymentMethod || "Not set")}</strong>
        </div>
        <div class="print-ticket-card">
          <span>Payment Reference</span>
          <strong>${escapeHtml(booking.paymentReference || "Auto-generated")}</strong>
        </div>
      </div>

      <div class="print-ticket-route">
        <div>
          <span>Route</span>
          <strong>${escapeHtml(route ? formatRouteLabel(route) : `${booking.origin} -> ${booking.destination}`)}</strong>
        </div>
        <div>
          <span>Stops</span>
          <strong>${escapeHtml(stops.length ? stops.join(", ") : "Direct service")}</strong>
        </div>
        <div>
          <span>Processed At</span>
          <strong>${escapeHtml(formatDisplayDateTime(booking.paidAt || booking.createdAt))}</strong>
        </div>
      </div>

      <div class="print-barcode-panel">
        <div class="print-barcode" aria-hidden="true"></div>
        <div class="print-barcode-code">${escapeHtml(barcodeDigits)}</div>
      </div>
    </div>
  `;
}

function renderPrintableTicket(bookingId = null, options = {}) {
  const sheet = $("printTicketSheet");
  if (!sheet) return;
  const targetBookingId = bookingId || state.printBookingId;
  const bundle = getBookingTicketBundle(targetBookingId);
  sheet.innerHTML = buildPrintableTicketMarkup(bundle, options);
}

function showPaymentReceipt(receipt) {
  const modalBody = $("paymentModalBody");
  const backdrop = $("paymentModalBackdrop");
  if (!modalBody || !backdrop) return;

  state.lastReceipt = receipt;
  state.printBookingId = receipt.booking.id;
  renderPrintableTicket(receipt.booking.id, { label: "Official Payment Receipt", receipt: true });
  setPaymentModalState({
    eyebrow: "Payment Successful",
    title: "Receipt Confirmation",
    secondaryLabel: "Print Receipt",
    secondaryAction: "print",
    primaryLabel: "Done",
    primaryAction: "done",
  });

  modalBody.innerHTML = `
    <div class="receipt-hero">
      <div>
        <p class="eyebrow">Transaction Complete</p>
        <h4>${escapeHtml(receipt.booking.passengerName)}</h4>
        <p class="muted">Your booking is now marked as paid and is waiting for admin confirmation.</p>
      </div>
      <div class="receipt-total">${escapeHtml(formatCurrency(receipt.booking.totalFare))}</div>
    </div>
    <div class="receipt-strip">
      <span>Ticket Code</span>
      <strong>${escapeHtml(receipt.ticket.ticketCode)}</strong>
      <span>Reference</span>
      <strong>${escapeHtml(receipt.booking.paymentReference || "Auto-generated")}</strong>
    </div>
    ${buildPrintableTicketMarkup(getBookingTicketBundle(receipt.booking.id), { label: "Payment Receipt", receipt: true })}
  `;

  backdrop.classList.add("show");
}

function openPaymentModal() {
  if (!requireUserAction()) return;
  if (!state.bookingSearch || !state.selectedScheduleId) {
    showToast("Select a schedule before proceeding to payment.");
    return;
  }
  if (state.selectedSeats.length !== state.bookingSearch.passengerCount) {
    showToast("Select the exact number of seats required for the booking.");
    return;
  }

  const payment = getPaymentDetails();
  if (!payment.paymentMethod) {
    showToast("Choose a payment method first.");
    return;
  }

  const schedule = getSchedule(state.selectedScheduleId);
  const route = getRoute(schedule.routeId);
  const bus = getBus(schedule.busId);
  const total = getDestinationFare(route, schedule, state.bookingSearch.destination) * state.selectedSeats.length;
  const modalBody = $("paymentModalBody");
  const backdrop = $("paymentModalBackdrop");
  if (!modalBody || !backdrop) return;

  setPaymentModalState({
    eyebrow: "Checkout",
    title: "Confirm Mock Payment",
    secondaryLabel: "Back",
    secondaryAction: "back",
    primaryLabel: "Complete Payment",
    primaryAction: "complete",
  });

  modalBody.innerHTML = `
    <div class="payment-review-grid">
      <div><span>Passenger</span><strong>${state.bookingSearch.passengerName}</strong></div>
      <div><span>Route</span><strong>${route.origin} -> ${state.bookingSearch.destination}</strong></div>
      <div><span>Bus</span><strong>${bus.plateNumber}</strong></div>
      <div><span>Travel Date</span><strong>${state.bookingSearch.travelDate}</strong></div>
      <div><span>Departure</span><strong>${schedule.departureTime}</strong></div>
      <div><span>Seats</span><strong>${state.selectedSeats.join(", ")}</strong></div>
      <div><span>Payment Method</span><strong>${payment.paymentMethod}</strong></div>
      <div><span>${getPaymentReferenceLabel(payment.paymentMethod)}</span><strong>${payment.paymentReference || "Auto-generated at payment"}</strong></div>
      <div><span>Total Amount</span><strong>${formatCurrency(total)}</strong></div>
      <div><span>Status After Payment</span><strong>Paid / Pending Admin Confirmation</strong></div>
    </div>
  `;

  backdrop.classList.add("show");
}

function getRoute(routeId) {
  return state.db.routes.find((route) => route.id === routeId);
}

function getBus(busId) {
  return state.db.buses.find((bus) => bus.id === busId);
}

function getTemplate(templateId) {
  return state.db.scheduleTemplates.find((template) => template.id === templateId);
}

function getRouteBusTypes(routeId) {
  return [...new Set(
    state.db.schedules
      .filter((schedule) => schedule.routeId === routeId)
      .map((schedule) => getBus(schedule.busId)?.busType)
      .filter(Boolean)
  )];
}

function getSchedule(scheduleId) {
  return state.db.schedules.find((schedule) => schedule.id === scheduleId);
}

function getTicketByBooking(bookingId) {
  return state.db.tickets.find((ticket) => ticket.bookingId === bookingId);
}

function getTicketLookupRows(query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return [];
  return state.db.bookings
    .map((booking) => {
      const ticket = getTicketByBooking(booking.id);
      const schedule = getSchedule(booking.scheduleId);
      const bus = schedule ? getBus(schedule.busId) : null;
      return {
        booking,
        ticket,
        schedule,
        bus,
      };
    })
    .filter(({ booking, ticket, bus }) => {
      const searchable = [
        ticket?.ticketCode,
        booking.passengerName,
        booking.contactNumber,
        booking.paymentReference,
        bus?.plateNumber,
      ].filter(Boolean).join(" ").toLowerCase();
      return searchable.includes(normalizedQuery);
    })
    .sort((a, b) => b.booking.createdAt.localeCompare(a.booking.createdAt));
}

function getFilteredReportBookings() {
  return state.db.bookings.filter((booking) => {
    const filters = state.reportFilters;
    if (filters.start && booking.travelDate < filters.start) return false;
    if (filters.end && booking.travelDate > filters.end) return false;
    if (filters.status !== "all" && booking.status !== filters.status) return false;
    if (filters.paymentMethod !== "all" && booking.paymentMethod !== filters.paymentMethod) return false;

    if (filters.routeId !== "all") {
      const schedule = getSchedule(booking.scheduleId);
      if (!schedule || schedule.routeId !== filters.routeId) return false;
    }

    if (filters.busId !== "all") {
      const schedule = getSchedule(booking.scheduleId);
      if (!schedule || schedule.busId !== filters.busId) return false;
    }

    return true;
  });
}

function syncReportFiltersFromUi() {
  const mapping = {
    start: "reportStartDate",
    end: "reportEndDate",
    routeId: "reportRouteFilter",
    busId: "reportBusFilter",
    status: "reportStatusFilter",
    paymentMethod: "reportPaymentFilter",
  };
  Object.entries(mapping).forEach(([key, id]) => {
    const element = $(id);
    if (element) {
      state.reportFilters[key] = element.value || (key === "start" || key === "end" ? "" : "all");
    }
  });
}

function populateReportFilterOptions() {
  if (!$("reportRouteFilter")) return;
  $("reportRouteFilter").innerHTML = `<option value="all">All Routes</option>${state.db.routes.map((route) => `<option value="${route.id}">${route.origin} -> ${route.destination}</option>`).join("")}`;
  $("reportBusFilter").innerHTML = `<option value="all">All Buses</option>${state.db.buses.map((bus) => `<option value="${bus.id}">${bus.plateNumber} | ${bus.busType}</option>`).join("")}`;

  const filterMappings = {
    reportStartDate: state.reportFilters.start,
    reportEndDate: state.reportFilters.end,
    reportRouteFilter: state.reportFilters.routeId,
    reportBusFilter: state.reportFilters.busId,
    reportStatusFilter: state.reportFilters.status,
    reportPaymentFilter: state.reportFilters.paymentMethod,
  };

  Object.entries(filterMappings).forEach(([id, value]) => {
    const element = $(id);
    if (element) element.value = value;
  });
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildCsvReport() {
  const reportBookings = getFilteredReportBookings();
  const rows = [
    ["Ticket Code", "Passenger", "Contact", "Origin", "Destination", "Travel Date", "Departure", "Bus", "Seats", "Status", "Boarding Status", "Payment Method", "Payment Status", "Total Fare"],
    ...reportBookings.map((booking) => {
      const schedule = getSchedule(booking.scheduleId);
      const bus = schedule ? getBus(schedule.busId) : null;
      const ticket = getTicketByBooking(booking.id);
      return [
        ticket?.ticketCode || "Pending",
        booking.passengerName,
        booking.contactNumber,
        booking.origin,
        booking.destination,
        booking.travelDate,
        schedule?.departureTime || "",
        bus ? `${bus.plateNumber} ${bus.busType}` : "",
        booking.seatNumbers.join(" / "),
        booking.status,
        booking.boardingStatus || "Awaiting Boarding",
        booking.paymentMethod || "",
        booking.paymentStatus || "",
        booking.totalFare,
      ];
    }),
  ];

  return rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function exportCsvReport() {
  downloadTextFile(`transitpro-report-${new Date().toISOString().slice(0, 10)}.csv`, buildCsvReport(), "text/csv;charset=utf-8");
  showToast("CSV report downloaded.");
}

function renderPdfReportSheet() {
  const sheet = $("printTicketSheet");
  if (!sheet) return;
  const today = new Date().toISOString().slice(0, 10);
  const reportBookings = getFilteredReportBookings();
  const totalRevenue = reportBookings.reduce((sum, booking) => sum + booking.totalFare, 0);
  const lines = reportBookings
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((booking) => {
      const ticket = getTicketByBooking(booking.id);
      const schedule = getSchedule(booking.scheduleId);
      return `
        <tr>
          <td>${escapeHtml(ticket?.ticketCode || "Pending")}</td>
          <td>${escapeHtml(booking.passengerName)}</td>
          <td>${escapeHtml(`${booking.origin} -> ${booking.destination}`)}</td>
          <td>${escapeHtml(booking.travelDate)}</td>
          <td>${escapeHtml(schedule ? `${schedule.departureTime} - ${schedule.arrivalTime}` : "--")}</td>
          <td>${escapeHtml(booking.seatNumbers.join(", "))}</td>
          <td>${escapeHtml(`${booking.status} / ${booking.boardingStatus || "Awaiting Boarding"}`)}</td>
          <td>${escapeHtml(formatCurrency(booking.totalFare))}</td>
        </tr>
      `;
    })
    .join("");

  sheet.innerHTML = `
    <div class="print-ticket-shell report-print-shell">
      <div class="print-ticket-header">
        <div>
          <p class="eyebrow">TransitPro Report Export</p>
          <h2>Operations Report</h2>
          <p class="muted">Generated ${escapeHtml(formatDisplayDate(today))}</p>
        </div>
        <div class="print-ticket-statuses">
          <span class="inline-pill">Bookings ${reportBookings.length}</span>
          <span class="inline-pill">Revenue ${escapeHtml(formatCurrency(totalRevenue))}</span>
        </div>
      </div>
      <div class="report-print-grid">
        <div class="print-ticket-card"><span>Daily Reservations</span><strong>${reportBookings.filter((booking) => booking.travelDate === today).length}</strong></div>
        <div class="print-ticket-card"><span>Fleet Size</span><strong>${state.db.buses.length}</strong></div>
        <div class="print-ticket-card"><span>Schedules</span><strong>${state.db.schedules.length}</strong></div>
        <div class="print-ticket-card"><span>Tickets Issued</span><strong>${state.db.tickets.length}</strong></div>
      </div>
      <table class="report-print-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Passenger</th>
            <th>Route</th>
            <th>Date</th>
            <th>Time</th>
            <th>Seats</th>
            <th>Status</th>
            <th>Fare</th>
          </tr>
        </thead>
        <tbody>
          ${lines || `<tr><td colspan="8">No bookings yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function exportPdfReport() {
  renderPdfReportSheet();
  window.print();
  showToast("Use Save as PDF in the print dialog to export the report.");
}

function renderTicketLookup() {
  const container = $("ticketLookupResults");
  const input = $("ticketLookupInput");
  if (!container || !input) return;
  const query = input.value.trim();
  if (!query) {
    container.className = "admin-list empty-state";
    container.textContent = "Search by ticket code, passenger name, or contact number.";
    return;
  }

  const results = getTicketLookupRows(query);
  if (!results.length) {
    container.className = "admin-list empty-state";
    container.textContent = "No ticket or booking matched that search.";
    return;
  }

  container.className = "admin-list";
  container.innerHTML = results.map(({ booking, ticket, schedule, bus }) => `
    <article class="admin-card lookup-card">
      <div class="admin-card-head">
        <div>
          <h4>${escapeHtml(booking.passengerName)}</h4>
          <p class="muted">${escapeHtml(ticket?.ticketCode || "Pending")} | ${escapeHtml(booking.contactNumber)}</p>
        </div>
        <span class="pill ${getBookingStatusClass(booking.status)}">${escapeHtml(booking.status)}</span>
      </div>
      <div class="route-meta">
        <div><span class="muted">Route</span><strong>${escapeHtml(`${booking.origin} -> ${booking.destination}`)}</strong></div>
        <div><span class="muted">Travel</span><strong>${escapeHtml(`${booking.travelDate} ${schedule?.departureTime || ""}`.trim())}</strong></div>
        <div><span class="muted">Bus</span><strong>${escapeHtml(bus ? bus.plateNumber : "Not assigned")}</strong></div>
          <div><span class="muted">Seats</span><strong>${escapeHtml(booking.seatNumbers.join(", "))}</strong></div>
          <div><span class="muted">Payment</span><strong>${escapeHtml(booking.paymentMethod || "Not set")}</strong></div>
          <div><span class="muted">Fare</span><strong>${escapeHtml(formatCurrency(booking.totalFare))}</strong></div>
          <div><span class="muted">Boarding</span><strong class="inline-pill ${getBoardingStatusClass(booking.boardingStatus || "Awaiting Boarding")}">${escapeHtml(booking.boardingStatus || "Awaiting Boarding")}</strong></div>
        </div>
      <div class="card-actions">
        <button type="button" data-print-booking="${booking.id}" class="secondary-button">Print Ticket</button>
      </div>
    </article>
  `).join("");
}

function renderManifest() {
  const select = $("manifestScheduleSelect");
  const summary = $("manifestSummary");
  const table = $("manifestTable");
  if (!select || !summary || !table) return;

  select.innerHTML = state.db.schedules.length
    ? state.db.schedules.map((schedule) => {
      const route = getRoute(schedule.routeId);
      const bus = getBus(schedule.busId);
      return `<option value="${schedule.id}">${route ? `${route.origin} -> ${route.destination}` : "Unassigned"} | ${schedule.date} ${schedule.departureTime} | ${bus ? bus.plateNumber : "No bus"}</option>`;
    }).join("")
    : `<option value="">Add a schedule first</option>`;

  if (!state.selectedManifestScheduleId && state.db.schedules.length) {
    state.selectedManifestScheduleId = state.db.schedules[0].id;
  }
  if (state.selectedManifestScheduleId && state.db.schedules.some((schedule) => schedule.id === state.selectedManifestScheduleId)) {
    select.value = state.selectedManifestScheduleId;
  }

  const schedule = getSchedule(select.value || state.selectedManifestScheduleId);
  if (!schedule) {
    summary.textContent = "Select a schedule to view the boarding manifest.";
    table.className = "admin-list empty-state";
    table.textContent = "No schedules available for manifest viewing.";
    return;
  }

  state.selectedManifestScheduleId = schedule.id;
  const route = getRoute(schedule.routeId);
  const bus = getBus(schedule.busId);
  const manifestRows = state.db.bookings
    .filter((booking) => booking.scheduleId === schedule.id)
    .sort((a, b) => a.passengerName.localeCompare(b.passengerName));

  summary.innerHTML = `
    <strong>${route ? formatRouteLabel(route) : "Unassigned route"}</strong><br />
    ${schedule.date} | ${schedule.departureTime} - ${schedule.arrivalTime} | ${bus ? `${bus.plateNumber} | ${bus.busType}` : "No bus assigned"}<br />
    Total passengers: ${manifestRows.reduce((sum, booking) => sum + Number(booking.passengerCount || 0), 0)} | Bookings: ${manifestRows.length}
  `;

  if (!manifestRows.length) {
    table.className = "admin-list empty-state";
    table.textContent = "No passengers booked for this schedule yet.";
    return;
  }

  table.className = "admin-list";
  table.innerHTML = manifestRows.map((booking, index) => {
    const ticket = getTicketByBooking(booking.id);
    return `
      <article class="admin-card manifest-card">
        <div class="manifest-index">${index + 1}</div>
        <div class="manifest-main">
          <div class="admin-card-head">
            <div>
              <h4>${escapeHtml(booking.passengerName)}</h4>
              <p class="muted">${escapeHtml(ticket?.ticketCode || "Pending")} | ${escapeHtml(booking.contactNumber)}</p>
            </div>
            <span class="inline-pill ${getBookingStatusClass(booking.status)}">${escapeHtml(booking.status)}</span>
          </div>
          <div class="route-meta">
            <div><span class="muted">Seat</span><strong>${escapeHtml(booking.seatNumbers.join(", "))}</strong></div>
          <div><span class="muted">Passengers</span><strong>${escapeHtml(booking.passengerCount)}</strong></div>
          <div><span class="muted">Destination</span><strong>${escapeHtml(booking.destination)}</strong></div>
          <div><span class="muted">Payment</span><strong>${escapeHtml(booking.paymentStatus || "Unpaid")}</strong></div>
          <div><span class="muted">Method</span><strong>${escapeHtml(booking.paymentMethod || "Not set")}</strong></div>
          <div><span class="muted">Fare</span><strong>${escapeHtml(formatCurrency(booking.totalFare))}</strong></div>
          <div><span class="muted">Boarding</span><strong class="inline-pill ${getBoardingStatusClass(booking.boardingStatus || "Awaiting Boarding")}">${escapeHtml(booking.boardingStatus || "Awaiting Boarding")}</strong></div>
        </div>
        <div class="card-actions">
          <button type="button" data-boarding-status="${booking.id}:Checked In">Checked In</button>
          <button type="button" data-boarding-status="${booking.id}:Boarded">Boarded</button>
          <button type="button" data-boarding-status="${booking.id}:No Show" class="secondary-button">No Show</button>
        </div>
      </div>
      </article>
    `;
  }).join("");
}

async function verifyTicketCode() {
  const input = $("verifyTicketCodeInput");
  const result = $("verifyTicketResult");
  if (!input || !result) return;

  const ticketCode = input.value.trim();
  if (!ticketCode) {
    result.className = "empty-state";
    result.textContent = "Enter a ticket code to check whether it is valid.";
    return;
  }

  try {
    const response = await fetch(`/api/verify/${encodeURIComponent(ticketCode)}`);
    if (!response.ok) {
      result.className = "empty-state";
      result.textContent = "Ticket not found.";
      return;
    }

    const payload = await response.json();
    const booking = payload.booking;
    const route = payload.route;
    const schedule = payload.schedule;
    const bus = payload.bus;

    result.className = "";
    result.innerHTML = `
      <article class="admin-card verify-result-card">
        <div class="admin-card-head">
          <div>
            <h4>${escapeHtml(payload.ticket.ticketCode)}</h4>
            <p class="muted">${escapeHtml(booking.passengerName)} | ${escapeHtml(booking.contactNumber)}</p>
          </div>
          <span class="pill ${getBookingStatusClass(booking.status)}">${escapeHtml(booking.status)}</span>
        </div>
        <div class="route-meta">
          <div><span class="muted">Route</span><strong>${escapeHtml(route ? formatRouteLabel(route) : `${booking.origin} -> ${booking.destination}`)}</strong></div>
          <div><span class="muted">Travel Date</span><strong>${escapeHtml(booking.travelDate)}</strong></div>
          <div><span class="muted">Departure</span><strong>${escapeHtml(schedule ? schedule.departureTime : "--:--")}</strong></div>
          <div><span class="muted">Bus</span><strong>${escapeHtml(bus ? `${bus.plateNumber} | ${bus.busType}` : "Not assigned")}</strong></div>
          <div><span class="muted">Seats</span><strong>${escapeHtml(booking.seatNumbers.join(", "))}</strong></div>
          <div><span class="muted">Payment</span><strong class="inline-pill ${getPaymentStatusClass(booking.paymentStatus || "Unpaid")}">${escapeHtml(booking.paymentStatus || "Unpaid")}</strong></div>
          <div><span class="muted">Boarding</span><strong class="inline-pill ${getBoardingStatusClass(booking.boardingStatus || "Awaiting Boarding")}">${escapeHtml(booking.boardingStatus || "Awaiting Boarding")}</strong></div>
          <div><span class="muted">Total Fare</span><strong>${escapeHtml(formatCurrency(booking.totalFare))}</strong></div>
        </div>
      </article>
    `;
  } catch (error) {
    result.className = "empty-state";
    result.textContent = "Unable to verify the ticket right now.";
  }
}

function printManifest() {
  const schedule = getSchedule(state.selectedManifestScheduleId);
  if (!schedule) {
    showToast("Choose a schedule first.");
    return;
  }
  const route = getRoute(schedule.routeId);
  const bus = getBus(schedule.busId);
  const rows = state.db.bookings
    .filter((booking) => booking.scheduleId === schedule.id)
    .sort((a, b) => a.passengerName.localeCompare(b.passengerName))
    .map((booking, index) => {
      const ticket = getTicketByBooking(booking.id);
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(booking.passengerName)}</td>
          <td>${escapeHtml(booking.contactNumber)}</td>
          <td>${escapeHtml(ticket?.ticketCode || "Pending")}</td>
          <td>${escapeHtml(booking.seatNumbers.join(", "))}</td>
          <td>${escapeHtml(booking.destination)}</td>
          <td>${escapeHtml(booking.status)}</td>
          <td>${escapeHtml(booking.boardingStatus || "Awaiting Boarding")}</td>
        </tr>
      `;
    })
    .join("");

  const sheet = $("printTicketSheet");
  if (!sheet) return;
  sheet.innerHTML = `
    <div class="print-ticket-shell report-print-shell">
      <div class="print-ticket-header">
        <div>
          <p class="eyebrow">TransitPro Boarding Manifest</p>
          <h2>${escapeHtml(route ? formatRouteLabel(route) : "Unassigned route")}</h2>
          <p class="muted">${escapeHtml(`${schedule.date} | ${schedule.departureTime} - ${schedule.arrivalTime}`)}</p>
        </div>
        <div class="print-ticket-statuses">
          <span class="inline-pill">${escapeHtml(bus ? `${bus.plateNumber} | ${bus.busType}` : "No bus assigned")}</span>
          <span class="inline-pill">Passengers ${state.db.bookings.filter((booking) => booking.scheduleId === schedule.id).reduce((sum, booking) => sum + Number(booking.passengerCount || 0), 0)}</span>
        </div>
      </div>
      <table class="report-print-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Passenger</th>
            <th>Contact</th>
            <th>Ticket</th>
            <th>Seat</th>
            <th>Destination</th>
            <th>Status</th>
            <th>Boarding</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="8">No passengers booked yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  window.print();
}

function getScheduleBookings(scheduleId) {
  return state.db.bookings.filter((booking) => booking.scheduleId === scheduleId);
}

function getSeatStatus(scheduleId, seatNumber) {
  const occupied = getScheduleBookings(scheduleId).flatMap((booking) => booking.seatNumbers);
  if (occupied.includes(seatNumber)) return "occupied";
  const reserved = state.db.seatStates.find(
    (seatState) => seatState.scheduleId === scheduleId && seatState.seatNumber === seatNumber && seatState.status === "reserved"
  );
  if (reserved) return "reserved";
  return "available";
}

function setActiveView(viewId) {
  state.activeView = viewId;
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewId);
  });
  document.querySelectorAll(".workspace .view").forEach((view) => {
    view.classList.toggle("active", view.id === viewId);
  });
}

function setActiveAdminPanel(panelId) {
  state.activeAdminPanel = panelId;
  document.querySelectorAll(".admin-panel-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.adminPanel === panelId);
  });
  document.querySelectorAll(".admin-grid > .panel").forEach((panel) => {
    panel.classList.toggle("admin-panel-active", panel.id === panelId);
  });
}

function requireUserAction() {
  if (!state.session || state.session.role !== "user") {
    showToast("Passenger login is required to confirm a booking.");
    return false;
  }
  return true;
}

function findRouteDeparture(routeId) {
  const matches = state.db.schedules.filter((schedule) => schedule.routeId === routeId);
  if (!matches.length) return "No trips";
  return matches.map((schedule) => schedule.departureTime).join(", ");
}

function findMatchingSchedules(search) {
  return state.db.schedules.filter((schedule) => {
    const route = getRoute(schedule.routeId);
    return route
      && route.origin === search.origin
      && routeServesDestination(route, search.destination)
      && schedule.date === search.travelDate
      && (!search.busId || schedule.busId === search.busId);
  });
}

function renderHero() {
  if (!$("heroStats") || !$("ticketPreviewCard")) return;
  const revenue = state.db.bookings.reduce((sum, booking) => sum + booking.totalFare, 0);
  const seatsSold = state.db.bookings.reduce((sum, booking) => sum + booking.seatNumbers.length, 0);
  $("heroStats").innerHTML = `
    <div class="stat-card"><span>Active Routes</span><strong>${state.db.routes.length}</strong></div>
    <div class="stat-card"><span>Live Schedules</span><strong>${state.db.schedules.length}</strong></div>
    <div class="stat-card"><span>Seats Sold</span><strong>${seatsSold}</strong></div>
    <div class="stat-card"><span>Ticket Revenue</span><strong>${formatCurrency(revenue)}</strong></div>
  `;

  const latestBooking = [...state.db.bookings].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latestBooking) {
    $("ticketPreviewCard").innerHTML = `<div class="ticket-card"><h3>No issued tickets yet</h3></div>`;
    renderPrintableTicket();
    return;
  }

  const schedule = getSchedule(latestBooking.scheduleId);
  const route = schedule ? getRoute(schedule.routeId) : null;
  const bus = schedule ? getBus(schedule.busId) : null;
  const ticket = getTicketByBooking(latestBooking.id);
  $("ticketPreviewCard").innerHTML = `
    <div class="ticket-card">
      <p class="eyebrow">Latest E-Ticket</p>
      <h3>${latestBooking.origin} to ${latestBooking.destination}</h3>
      <div class="ticket-grid">
        <div><span>Passenger</span><strong>${latestBooking.passengerName}</strong></div>
        <div><span>Ticket Code</span><strong>${ticket ? ticket.ticketCode : "Pending"}</strong></div>
        <div><span>Departure</span><strong>${schedule ? schedule.departureTime : "--:--"}</strong></div>
        <div><span>Travel Date</span><strong>${latestBooking.travelDate}</strong></div>
        <div><span>Seats</span><strong>${latestBooking.seatNumbers.join(", ")}</strong></div>
        <div><span>Bus Type</span><strong>${bus ? bus.busType : "Standard"}</strong></div>
      </div>
    </div>
  `;
  if (!state.printBookingId) {
    state.printBookingId = latestBooking.id;
  }
  renderPrintableTicket(state.printBookingId);
}

function renderSession() {
  const badge = $("sessionBadge");
  const logoutBtn = $("logoutBtn");
  const adminLink = document.querySelector(".admin-only");
  if (!badge || !logoutBtn) return;
  if (!state.session) {
    badge.textContent = "Guest Access";
    logoutBtn.style.display = "none";
    if (adminLink) adminLink.classList.remove("admin-visible");
  } else if (state.session.role === "admin") {
    badge.textContent = `${state.session.name} | Administrator`;
    logoutBtn.style.display = "inline-flex";
    if (adminLink) adminLink.classList.add("admin-visible");
  } else {
    badge.textContent = `${state.session.name} | Passenger`;
    logoutBtn.style.display = "inline-flex";
    if (adminLink) adminLink.classList.remove("admin-visible");
    if (state.activeView === "adminView") setActiveView("routesView");
  }
}

function updateAdminAccessUi() {
  const adminForm = $("adminLoginForm");
  if (!adminForm) return;

  const heading = adminForm.querySelector("h4");
  const submitButton = adminForm.querySelector('button[type="submit"]');
  const usernameInput = adminForm.querySelector('[name="username"]');
  const passwordInput = adminForm.querySelector('[name="password"]');
  const panelHeading = document.querySelector(".auth-panel .panel-heading h3");
  const noAdminExists = state.db.admins.length === 0;

  if (heading) {
    heading.textContent = noAdminExists ? "Create First Admin" : "Admin Login";
  }
  if (submitButton) {
    submitButton.textContent = noAdminExists ? "Create Admin Account" : "Unlock Dashboard";
  }
  if (usernameInput) {
    usernameInput.placeholder = noAdminExists ? "Choose admin username" : "admin";
  }
  if (passwordInput) {
    passwordInput.placeholder = noAdminExists ? "Create admin password" : "Admin password";
  }
  if (pageMode === "admin" && panelHeading) {
    panelHeading.textContent = noAdminExists ? "Create Your First Admin" : "Access Window";
  }
  if (pageMode === "auth" && panelHeading) {
    panelHeading.textContent = noAdminExists ? "Create Your First Admin" : "Admin Access";
  }
}

function updateScheduleFormStatus() {
  const form = $("scheduleForm");
  const status = $("scheduleFormStatus");
  if (!form || !status) return;

  const scheduleIdInput = form.querySelector('[name="scheduleId"]');
  const isEditing = Boolean(scheduleIdInput && scheduleIdInput.value);
  const editScopeField = $("editScopeField");
  const additionalDatesField = $("additionalDatesField");
  const dateBatchModeField = $("dateBatchModeField");
  status.textContent = isEditing ? "Editing Schedule" : "Creating New Schedule";
  status.classList.toggle("editing", isEditing);
  if (editScopeField) {
    editScopeField.classList.toggle("visible", isEditing);
  }
  if (additionalDatesField) {
    additionalDatesField.classList.toggle("hidden", isEditing);
  }
  if (dateBatchModeField) {
    dateBatchModeField.classList.toggle("hidden", isEditing);
  }
}

function renderScheduleConflictHelper() {
  const form = $("scheduleForm");
  const helper = $("scheduleConflictHelper");
  if (!form || !helper) return;

  const busId = form.querySelector('[name="busId"]')?.value;
  const date = form.querySelector('[name="date"]')?.value;
  const additionalDates = form.querySelector('[name="additionalDates"]')?.value;
  const dateBatchMode = form.querySelector('[name="dateBatchMode"]')?.value || "single";
  const scheduleId = form.querySelector('[name="scheduleId"]')?.value;

  if (!busId || !date) {
    helper.innerHTML = "Select a bus and date to preview that bus's schedules.";
    return;
  }

  const bus = getBus(busId);
  const matchingSchedules = state.db.schedules
    .filter((schedule) => schedule.busId === busId && schedule.date === date && schedule.id !== scheduleId)
    .sort((a, b) => a.departureTime.localeCompare(b.departureTime));

  if (!matchingSchedules.length) {
    helper.innerHTML = `<strong>${bus ? bus.plateNumber : "Selected bus"}</strong><br />No other schedules found for ${date}.${(additionalDates || dateBatchMode !== "single") ? "<br />Additional selected dates will be created too." : ""}`;
    return;
  }

  helper.innerHTML = `
    <strong>${bus ? bus.plateNumber : "Selected bus"}</strong><br />
    Existing schedules on ${date}:<br />
    ${matchingSchedules.map((schedule) => {
      const route = getRoute(schedule.routeId);
      const routeLabel = route ? `${route.origin} -> ${route.destination}` : "Unknown route";
      return `${schedule.departureTime} - ${schedule.arrivalTime} | ${routeLabel}`;
    }).join("<br />")}
  `;
}

function populateSelectOptions() {
  if (!$("routeFilterType") && !$("adminRouteSelect")) return;
  const routeTypes = new Set();
  const origins = new Set();
  const destinations = new Set();
  state.db.buses.forEach((bus) => routeTypes.add(bus.busType));
  state.db.routes.forEach((route) => {
    origins.add(route.origin);
    destinations.add(route.destination);
    getRouteStops(route).forEach((stop) => destinations.add(stop));
  });

  if ($("routeFilterType")) {
    $("routeFilterType").innerHTML = `<option value="all">All Bus Types</option>${[...routeTypes].map((type) => `<option value="${type}">${type}</option>`).join("")}`;
  }
  if ($("scheduleTypeFilter")) {
    const currentValue = $("scheduleTypeFilter").value || "all";
    const sortedTypes = [...routeTypes].sort();
    $("scheduleTypeFilter").innerHTML = `<option value="all">All Bus Types</option>${sortedTypes.map((type) => `<option value="${type}">${type}</option>`).join("")}`;
    $("scheduleTypeFilter").value = currentValue === "all" || [...routeTypes].includes(currentValue) ? currentValue : "all";
    if ($("scheduleTypeQuickbar")) {
      const activeType = $("scheduleTypeFilter").value || "all";
      $("scheduleTypeQuickbar").innerHTML = [
        `<button type="button" class="schedule-type-pill ${activeType === "all" ? "active" : ""}" data-schedule-type="all">All</button>`,
        ...sortedTypes.map((type) => `<button type="button" class="schedule-type-pill ${activeType === type ? "active" : ""}" data-schedule-type="${type}">${type}</button>`),
      ].join("");
    }
  }
  if ($("scheduleBusFilter")) {
    const currentValue = $("scheduleBusFilter").value || "all";
    $("scheduleBusFilter").innerHTML = `<option value="all">All Buses</option>${state.db.buses.map((bus) => `<option value="${bus.id}">${bus.plateNumber} | ${bus.busType}</option>`).join("")}`;
    $("scheduleBusFilter").value = state.db.buses.some((bus) => bus.id === currentValue) ? currentValue : "all";
  }
  if ($("driverSelect")) {
    const currentValue = $("driverSelect").value || "";
    const drivers = state.db.staff.filter((staff) => staff.role === "Driver");
    $("driverSelect").innerHTML = `<option value="">Select driver</option>${drivers.map((staff) => `<option value="${staff.name}">${staff.name}</option>`).join("")}`;
    $("driverSelect").value = drivers.some((staff) => staff.name === currentValue) ? currentValue : "";
  }
  if ($("conductorSelect")) {
    const currentValue = $("conductorSelect").value || "";
    const conductors = state.db.staff.filter((staff) => staff.role === "Conductor");
    $("conductorSelect").innerHTML = `<option value="">Select conductor</option>${conductors.map((staff) => `<option value="${staff.name}">${staff.name}</option>`).join("")}`;
    $("conductorSelect").value = conductors.some((staff) => staff.name === currentValue) ? currentValue : "";
  }
  if ($("scheduleTemplateSelect")) {
    const currentValue = $("scheduleTemplateSelect").value || "";
    $("scheduleTemplateSelect").innerHTML = `<option value="">No template</option>${state.db.scheduleTemplates.map((template) => `<option value="${template.id}">${template.name}</option>`).join("")}`;
    $("scheduleTemplateSelect").value = state.db.scheduleTemplates.some((template) => template.id === currentValue) ? currentValue : "";
  }
    if ($("originSelect")) {
      $("originSelect").innerHTML = `<option value="">Choose origin</option>${[...origins].map((origin) => `<option value="${origin}">${origin}</option>`).join("")}`;
    }
    if ($("destinationSelect")) {
      $("destinationSelect").innerHTML = `<option value="">Choose destination</option>${[...destinations].map((destination) => `<option value="${destination}">${destination}</option>`).join("")}`;
    }
    if ($("bookingBusSelect")) {
      $("bookingBusSelect").innerHTML = `<option value="">Any available bus</option>${state.db.buses.map((bus) => `<option value="${bus.id}">${bus.plateNumber} | ${bus.busType}</option>`).join("")}`;
    }
    if ($("adminRouteSelect")) {
      $("adminRouteSelect").innerHTML = state.db.routes.length
        ? state.db.routes.map((route) => `<option value="${route.id}">${route.origin} -> ${route.destination}</option>`).join("")
      : `<option value="">Add a route first</option>`;
  }
  if ($("adminBusSelect")) {
    $("adminBusSelect").innerHTML = state.db.buses.length
      ? state.db.buses.map((bus) => `<option value="${bus.id}">${bus.plateNumber} | ${bus.busType}</option>`).join("")
      : `<option value="">Add a bus first</option>`;
  }

  const seatScheduleSelect = $("seatScheduleSelect");
  if (seatScheduleSelect) {
    seatScheduleSelect.innerHTML = state.db.schedules.length
      ? state.db.schedules.map((schedule) => {
        const route = getRoute(schedule.routeId);
        const routeLabel = route ? `${route.origin} -> ${route.destination}` : "Unassigned route";
        return `<option value="${schedule.id}">${routeLabel} | ${schedule.date} ${schedule.departureTime}</option>`;
      }).join("")
      : `<option value="">Add a schedule first</option>`;
  }

  if (!state.selectedAdminScheduleId && state.db.schedules.length) {
    state.selectedAdminScheduleId = state.db.schedules[0].id;
  }
  if (seatScheduleSelect && state.selectedAdminScheduleId && state.db.schedules.some((schedule) => schedule.id === state.selectedAdminScheduleId)) {
    seatScheduleSelect.value = state.selectedAdminScheduleId;
  }
}

function renderRoutes() {
  if (!$("routeSearch") || !$("routeFilterType") || !$("routeTable")) return;
  const query = $("routeSearch").value.trim().toLowerCase();
  const type = $("routeFilterType").value;
  const results = state.db.routes.filter((route) => {
    const routeBusTypes = getRouteBusTypes(route.id);
    const searchable = `${route.origin} ${route.destination} ${routeBusTypes.join(" ")}`.toLowerCase();
    return (!query || searchable.includes(query)) && (type === "all" || routeBusTypes.includes(type));
  });

  const routeTable = $("routeTable");
  if (!results.length) {
    routeTable.innerHTML = `<div class="empty-state">No routes match your search.</div>`;
    return;
  }

  routeTable.innerHTML = results.map((route) => `
    <article class="route-card">
      <div class="route-card-head">
        <div>
          <h4>${route.origin} to ${route.destination}</h4>
          <p class="muted">${route.distanceKm} km | ${formatDuration(route)} estimated travel time</p>
          ${getRouteStops(route).length ? `<p class="muted">Via: ${getRouteStops(route).join(", ")}</p>` : ""}
        </div>
        <span class="pill">${getRouteBusTypes(route.id).join(", ") || "No bus assigned yet"}</span>
      </div>
      <div class="route-meta">
        <div><span class="muted">Departure Window</span><strong>${findRouteDeparture(route.id)}</strong></div>
        <div><span class="muted">Fare</span><strong>Set per schedule</strong></div>
        <div><span class="muted">Available Bus Types</span><strong>${getRouteBusTypes(route.id).join(", ") || "None yet"}</strong></div>
      </div>
      <p class="muted">Stop fares: set per schedule for each bus trip.</p>
    </article>
  `).join("");
}

function renderScheduleResults() {
  const container = $("scheduleResults");
  if (!container) return;
  if (!state.bookingSearch) {
    container.className = "schedule-results empty-state";
    container.textContent = "Choose a route and travel date to see available schedules.";
    return;
  }

  const matches = findMatchingSchedules(state.bookingSearch);
  if (!matches.length) {
    container.className = "schedule-results empty-state";
    container.textContent = "No schedules available for the selected route and date.";
    return;
  }

  container.className = "schedule-results";
  container.innerHTML = matches.map((schedule) => {
    const route = getRoute(schedule.routeId);
    const bus = getBus(schedule.busId);
    const fare = getDestinationFare(route, schedule, state.bookingSearch.destination);
    const occupiedSeats = getScheduleBookings(schedule.id).flatMap((booking) => booking.seatNumbers).length;
    const reservedSeats = state.db.seatStates.filter((seatState) => seatState.scheduleId === schedule.id && seatState.status === "reserved").length;
    const availableSeats = bus.capacity - occupiedSeats - reservedSeats;

    return `
      <article class="schedule-card ${state.selectedScheduleId === schedule.id ? "selected-card" : ""}">
        <div class="schedule-head">
          <div>
            <h4>${route.origin} to ${state.bookingSearch.destination}</h4>
            <p class="muted">${schedule.date} | ${schedule.departureTime} - ${schedule.arrivalTime}</p>
          </div>
          <span class="pill ${availableSeats < 6 ? "warn" : ""}">${schedule.status}</span>
        </div>
        <div class="schedule-meta">
          <div><span class="muted">Fare</span><strong>${formatCurrency(fare)}</strong></div>
          <div><span class="muted">Bus</span><strong>${bus.plateNumber}</strong></div>
          <div><span class="muted">Available Seats</span><strong>${availableSeats}</strong></div>
        </div>
        <div class="card-actions">
          <button type="button" data-schedule="${schedule.id}" class="select-schedule-btn">Select Schedule</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderSeatMap() {
  const seatMap = $("seatMap");
  const summary = $("seatSummary");
  if (!seatMap || !summary) return;
  if (!state.selectedScheduleId) {
    seatMap.className = "seat-map empty-state";
    seatMap.textContent = "Select a schedule to load seats.";
    summary.innerHTML = "";
    return;
  }

  const schedule = getSchedule(state.selectedScheduleId);
  const bus = getBus(schedule.busId);
  const seats = state.db.seats.filter((seat) => seat.busId === bus.id);

  seatMap.className = "seat-map bus-layout";
  seatMap.innerHTML = seats.map((seat, index) => {
    const status = getSeatStatus(schedule.id, seat.seatNumber);
    const selected = state.selectedSeats.includes(seat.seatNumber);
    const finalClass = selected ? "selected" : status;
    const disabled = status !== "available" && !selected;
    const cell = `<button class="seat ${finalClass}" type="button" data-seat="${seat.seatNumber}" ${disabled ? "disabled" : ""}>${seat.label}</button>`;
    return index % 4 === 1 ? `${cell}<div class="aisle">A</div>` : cell;
  }).join("");

  const route = getRoute(schedule.routeId);
  const fare = getDestinationFare(route, schedule, state.bookingSearch?.destination);
  const total = fare * state.selectedSeats.length;
  summary.innerHTML = `
    <strong>${route.origin} -> ${state.bookingSearch?.destination || route.destination}</strong><br />
    Selected seats: ${state.selectedSeats.length ? state.selectedSeats.join(", ") : "None"}<br />
    Fare calculation: ${formatCurrency(fare)} x ${state.selectedSeats.length || 0} = ${formatCurrency(total)}
  `;
}

function renderBookingSummary() {
  const container = $("bookingSummary");
  if (!container) return;
  if (!state.bookingSearch || !state.selectedScheduleId) {
    container.className = "booking-summary empty-state";
    container.textContent = "Ticket details will appear here after seat selection.";
    return;
  }

  const schedule = getSchedule(state.selectedScheduleId);
  const route = getRoute(schedule.routeId);
  const bus = getBus(schedule.busId);
  const payment = getPaymentDetails();
  const fare = getDestinationFare(route, schedule, state.bookingSearch.destination) * state.selectedSeats.length;
  container.className = "booking-summary";
  container.innerHTML = `
    <div class="ticket-card">
      <p class="eyebrow">Booking Confirmation Preview</p>
      <h3>${state.bookingSearch.passengerName}</h3>
      <div class="booking-meta ticket-grid">
        <div><span>Contact</span><strong>${state.bookingSearch.contactNumber}</strong></div>
        <div><span>Travel Date</span><strong>${state.bookingSearch.travelDate}</strong></div>
        <div><span>Route</span><strong>${route.origin} -> ${state.bookingSearch.destination}</strong></div>
        <div><span>Departure</span><strong>${schedule.departureTime}</strong></div>
        <div><span>Bus</span><strong>${bus.plateNumber}</strong></div>
        <div><span>Seats</span><strong>${state.selectedSeats.join(", ") || "Select seats"}</strong></div>
        <div><span>Passengers</span><strong>${state.bookingSearch.passengerCount}</strong></div>
        <div><span>Total Fare</span><strong>${formatCurrency(fare)}</strong></div>
        <div><span>Payment Method</span><strong>${payment.paymentMethod || "Select payment method"}</strong></div>
        <div><span>Payment Status</span><strong>${payment.paymentMethod ? "Ready for simulated payment" : "Waiting for payment setup"}</strong></div>
      </div>
    </div>
  `;
}

function renderHistory() {
  const container = $("historyTable");
  if (!container) return;
  if (!state.session || state.session.role !== "user") {
    container.className = "history-table empty-state";
    container.textContent = "Log in as a passenger to view booking history.";
    return;
  }

  const bookings = state.db.bookings
    .filter((booking) => booking.userId === state.session.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (!bookings.length) {
    container.className = "history-table empty-state";
    container.textContent = "No bookings found for this passenger yet.";
    return;
  }

  container.className = "history-table";
  container.innerHTML = bookings.map((booking) => {
    const ticket = getTicketByBooking(booking.id);
    const schedule = getSchedule(booking.scheduleId);
    return `
      <article class="history-card">
        <div class="history-head">
          <div>
            <h4>${booking.origin} to ${booking.destination}</h4>
            <p class="muted">Booked on ${new Date(booking.createdAt).toLocaleString()}</p>
          </div>
          <span class="pill ${getBookingStatusClass(booking.status)}">${booking.status}</span>
        </div>
        <div class="route-meta">
          <div><span class="muted">Ticket Code</span><strong>${ticket ? ticket.ticketCode : "Pending"}</strong></div>
          <div><span class="muted">Departure</span><strong>${schedule ? schedule.departureTime : "--:--"}</strong></div>
          <div><span class="muted">Seats</span><strong>${booking.seatNumbers.join(", ")}</strong></div>
          <div><span class="muted">Passengers</span><strong>${booking.passengerCount}</strong></div>
          <div><span class="muted">Total Fare</span><strong>${formatCurrency(booking.totalFare)}</strong></div>
          <div><span class="muted">Travel Date</span><strong>${booking.travelDate}</strong></div>
          <div><span class="muted">Payment</span><strong class="inline-pill ${getPaymentStatusClass(booking.paymentStatus || "Unpaid")}">${booking.paymentStatus || "Unpaid"}</strong></div>
          <div><span class="muted">Method</span><strong>${booking.paymentMethod || "Not set"}</strong></div>
          <div><span class="muted">Boarding</span><strong class="inline-pill ${getBoardingStatusClass(booking.boardingStatus || "Awaiting Boarding")}">${booking.boardingStatus || "Awaiting Boarding"}</strong></div>
        </div>
        <div class="card-actions">
          <button type="button" data-print-booking="${booking.id}" class="secondary-button">Print Ticket</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderAdmin() {
  const metrics = $("adminMetrics");
  if (!metrics) return;
  populateReportFilterOptions();
  syncReportFiltersFromUi();
  const today = new Date().toISOString().slice(0, 10);
  const reportBookings = getFilteredReportBookings();
  const todayBookings = reportBookings.filter((booking) => booking.travelDate === today);
  const totalRevenue = reportBookings.reduce((sum, booking) => sum + booking.totalFare, 0);
  const bookingStatusCounts = ["Pending", "Confirmed", "Cancelled"].map((status) => ({
    label: status,
    count: reportBookings.filter((booking) => booking.status === status).length,
  }));
  const paymentMethodCounts = ["GCash", "Maya", "Bank Transfer"].map((method) => ({
    label: method,
    count: reportBookings.filter((booking) => booking.paymentMethod === method).length,
  }));
  const routePerformance = state.db.routes
    .map((route) => ({
      label: `${route.origin} -> ${route.destination}`,
      bookings: reportBookings.filter(
        (booking) => booking.origin === route.origin && booking.destination === route.destination
      ).length,
    }))
    .sort((a, b) => b.bookings - a.bookings)
    .slice(0, 5);
  const topMetricValue = Math.max(1, ...routePerformance.map((item) => item.bookings), ...bookingStatusCounts.map((item) => item.count), ...paymentMethodCounts.map((item) => item.count));
  metrics.innerHTML = `
    <div class="metric-card"><span>Daily Reservations</span><strong>${todayBookings.length}</strong></div>
    <div class="metric-card"><span>Total Revenue</span><strong>${formatCurrency(totalRevenue)}</strong></div>
    <div class="metric-card"><span>Fleet Size</span><strong>${state.db.buses.length}</strong></div>
    <div class="metric-card"><span>Schedules</span><strong>${state.db.schedules.length}</strong></div>
  `;

  const topRoute = state.db.routes
    .map((route) => ({
      label: `${route.origin} -> ${route.destination}`,
      bookings: reportBookings.filter(
        (booking) => booking.origin === route.origin && booking.destination === route.destination
      ).length,
    }))
    .sort((a, b) => b.bookings - a.bookings)[0];

  $("reportPanel").innerHTML = `
    <div class="report-header">
      <div>
        <strong>Operations Snapshot</strong>
        <p class="muted">A quick visual look at route demand, booking status, and payment mix.</p>
      </div>
      <span class="pill">IndexedDB Live</span>
    </div>
    <div class="report-grid">
      <article class="chart-card">
        <div class="chart-card-head">
          <h4>Top Routes</h4>
          <span>${topRoute ? `${topRoute.bookings} bookings` : "0 bookings"}</span>
        </div>
        <div class="chart-rows">
          ${(routePerformance.length ? routePerformance : [{ label: "No routes yet", bookings: 0 }]).map((item) => `
            <div class="chart-row">
              <div class="chart-labels">
                <span>${item.label}</span>
                <strong>${item.bookings}</strong>
              </div>
              <div class="chart-track"><div class="chart-fill accent" style="width:${(item.bookings / topMetricValue) * 100}%"></div></div>
            </div>
          `).join("")}
        </div>
      </article>
      <article class="chart-card">
        <div class="chart-card-head">
          <h4>Booking Status</h4>
          <span>${reportBookings.length} total</span>
        </div>
        <div class="chart-rows">
          ${bookingStatusCounts.map((item) => `
            <div class="chart-row">
              <div class="chart-labels">
                <span>${item.label}</span>
                <strong>${item.count}</strong>
              </div>
              <div class="chart-track"><div class="chart-fill ${item.label.toLowerCase()}" style="width:${(item.count / topMetricValue) * 100}%"></div></div>
            </div>
          `).join("")}
        </div>
      </article>
      <article class="chart-card">
        <div class="chart-card-head">
          <h4>Payment Channels</h4>
          <span>${state.db.tickets.length} tickets issued</span>
        </div>
        <div class="chart-rows">
          ${paymentMethodCounts.map((item) => `
            <div class="chart-row">
              <div class="chart-labels">
                <span>${item.label}</span>
                <strong>${item.count}</strong>
              </div>
              <div class="chart-track"><div class="chart-fill brand" style="width:${(item.count / topMetricValue) * 100}%"></div></div>
            </div>
          `).join("")}
        </div>
      </article>
    </div>
    <div class="report-footer">
      <span>Most booked route: ${topRoute ? `${topRoute.label} (${topRoute.bookings})` : "No bookings yet"}</span>
      <span>Today's departures: ${state.db.schedules.filter((schedule) => schedule.date === today).length}</span>
      <span>Storage: Browser IndexedDB</span>
    </div>
  `;

  if (!state.db.schedules.length) {
    $("adminSchedules").innerHTML = `<div class="empty-state">No schedules yet. Add a bus and route first, then create a schedule.</div>`;
  } else {
    const selectedTypeFilter = $("scheduleTypeFilter")?.value || "all";
    const selectedBusFilter = $("scheduleBusFilter")?.value || "all";
    const selectedMonthFilter = $("scheduleMonthFilter")?.value || "";
    const selectedDayFilter = $("scheduleDayFilter")?.value || "";
    const scheduleSearchQuery = String($("scheduleSearchFilter")?.value || "").trim().toLowerCase();
    const filteredByType = selectedTypeFilter === "all"
      ? state.db.schedules
      : state.db.schedules.filter((schedule) => {
        const bus = getBus(schedule.busId);
        return (bus?.busType || "") === selectedTypeFilter;
      });
    const filteredByBus = selectedBusFilter === "all"
      ? filteredByType
      : filteredByType.filter((schedule) => schedule.busId === selectedBusFilter);
    const filteredByDate = filteredByBus.filter((schedule) => {
      if (selectedDayFilter && schedule.date !== selectedDayFilter) return false;
      if (selectedMonthFilter && !String(schedule.date || "").startsWith(selectedMonthFilter)) return false;
      return true;
    });
    const visibleSchedules = scheduleSearchQuery
      ? filteredByDate.filter((schedule) => {
        const bus = getBus(schedule.busId);
        const route = getRoute(schedule.routeId);
        const searchText = [
          bus?.plateNumber || "",
          bus?.busType || "",
          bus?.status || "",
          route?.origin || "",
          route?.destination || "",
          getRouteStops(route).join(" "),
          schedule.date || "",
          schedule.departureTime || "",
          schedule.arrivalTime || "",
          schedule.driverName || "",
          schedule.conductorName || "",
        ].join(" ").toLowerCase();
        return searchText.includes(scheduleSearchQuery);
      })
      : filteredByDate;

    if (!visibleSchedules.length) {
      $("adminSchedules").innerHTML = `<div class="empty-state">No schedules found for the selected filter.</div>`;
      renderAdminSeatMap();
      return;
    }

    const schedulesByType = visibleSchedules.reduce((groups, schedule) => {
      const bus = getBus(schedule.busId);
      const typeKey = bus?.busType || "Unassigned";
      if (!groups.has(typeKey)) groups.set(typeKey, []);
      groups.get(typeKey).push(schedule);
      return groups;
    }, new Map());

    const groupedMarkup = [...schedulesByType.entries()].sort(([typeA], [typeB]) => typeA.localeCompare(typeB)).map(([busType, typeSchedules]) => {
      const schedulesByBus = typeSchedules.reduce((groups, schedule) => {
        const key = schedule.busId || "unassigned";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(schedule);
        return groups;
      }, new Map());

      const busMarkup = [...schedulesByBus.entries()].map(([busId, schedules]) => {
        const bus = getBus(busId);
        const sortedSchedules = schedules.slice().sort((a, b) => {
          const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
          if (dateCompare !== 0) return dateCompare;
          return String(a.departureTime || "").localeCompare(String(b.departureTime || ""));
        });
        const firstSchedule = sortedSchedules[0];
        const lastSchedule = sortedSchedules[sortedSchedules.length - 1];
        const datePreview = firstSchedule && lastSchedule
          ? `${formatDisplayDate(firstSchedule.date)}${firstSchedule.date !== lastSchedule.date ? ` to ${formatDisplayDate(lastSchedule.date)}` : ""}`
          : "No dates";
        const tripPreview = firstSchedule ? `${firstSchedule.departureTime} first trip` : "No trip time";
        const lastTripPreview = lastSchedule ? `${lastSchedule.arrivalTime} last trip` : "No last trip";
        const routeCount = new Set(sortedSchedules.map((schedule) => schedule.routeId).filter(Boolean)).size;
        const busRevenue = state.db.bookings.reduce((sum, booking) => {
          const bookingSchedule = getSchedule(booking.scheduleId);
          if (!bookingSchedule || bookingSchedule.busId !== busId) return sum;
          return sum + Number(booking.totalFare || 0);
        }, 0);

        return `
          <details class="admin-card schedule-bus-group" ${selectedBusFilter !== "all" ? "open" : ""}>
            <summary class="schedule-group-summary">
              <div>
                <h4>${bus ? bus.plateNumber : "Unassigned bus"}</h4>
                <p class="muted">${bus ? `${bus.busType} | ${bus.capacity} seats | ${bus.status || "Active"}` : "Schedules without an assigned bus"}</p>
                <div class="schedule-preview-badges">
                  <span class="schedule-preview-chip count">${sortedSchedules.length} schedule${sortedSchedules.length === 1 ? "" : "s"}</span>
                  <span class="schedule-preview-chip date">${datePreview}</span>
                  <span class="schedule-preview-chip trip">${tripPreview}</span>
                  <span class="schedule-preview-chip trip">${lastTripPreview}</span>
                  <span class="schedule-preview-chip route">${routeCount} route${routeCount === 1 ? "" : "s"}</span>
                  <span class="schedule-preview-chip accent">${formatCurrency(busRevenue)} revenue</span>
                </div>
              </div>
              <span class="pill">${sortedSchedules.length} schedule${sortedSchedules.length === 1 ? "" : "s"}</span>
            </summary>
            <div class="schedule-group-actions">
              <button type="button" class="secondary-button" data-delete-bus-schedules="${busId}">
                Delete All Schedules For This Bus
              </button>
            </div>
            <div class="schedule-group-list">
              ${sortedSchedules.map((schedule) => {
                const route = getRoute(schedule.routeId);
                return `
                  <div class="schedule-group-item">
                    <div class="schedule-group-main">
                      <strong>${route ? `${route.origin} -> ${route.destination}` : "Unassigned route"}</strong>
                      <p class="muted">${schedule.date}</p>
                      <div class="schedule-inline-meta">
                        <span>${schedule.departureTime} - ${schedule.arrivalTime}</span>
                        <span>${formatCurrency(schedule.fare || 0)}</span>
                      </div>
                      <p class="muted">Driver: ${schedule.driverName || "Not assigned"} | Conductor: ${schedule.conductorName || "Not assigned"}</p>
                      <p class="muted">Stop fares: ${formatScheduleStopFareSummary(schedule, route)}</p>
                    </div>
                    <div class="schedule-group-side">
                      <span class="pill">${schedule.status}</span>
                      <div class="card-actions">
                        <button type="button" data-edit-schedule="${schedule.id}" class="edit-schedule-btn">Edit</button>
                        <button type="button" data-delete-schedule="${schedule.id}" class="secondary-button delete-schedule-btn">Delete</button>
                      </div>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          </details>
        `;
      }).join("");

      return `
        <section class="schedule-type-group">
          <div class="schedule-type-header">
            <h4>${busType}</h4>
            <span class="pill">${typeSchedules.length} schedule${typeSchedules.length === 1 ? "" : "s"}</span>
          </div>
          <div class="schedule-type-list">
            ${busMarkup}
          </div>
        </section>
      `;
    }).join("");

    $("adminSchedules").innerHTML = groupedMarkup;
  }

  renderAdminSeatMap();

  const busCards = state.db.buses.map((bus) => `
      <article class="admin-card">
        <div class="admin-card-head">
          <div><h4>${bus.plateNumber}</h4><p class="muted">${bus.busType}</p></div>
          <span class="pill">${bus.capacity} seats</span>
        </div>
        <div class="card-actions">
          <button type="button" data-edit-bus="${bus.id}">Edit Bus</button>
          <button type="button" data-delete-bus="${bus.id}" class="secondary-button">Delete</button>
        </div>
      </article>
    `);
  const routeCards = state.db.routes.map((route) => `
      <article class="admin-card">
        <div class="admin-card-head">
          <div><h4>${route.origin} -> ${route.destination}</h4><p class="muted">${route.distanceKm} km | ${formatDuration(route)}</p>${getRouteStops(route).length ? `<p class="muted">Via: ${getRouteStops(route).join(", ")}</p>` : ""}</div>
          <span class="pill">Per-schedule fare</span>
        </div>
        <p class="muted">Stop fares: set in each schedule for each assigned bus trip.</p>
        <div class="card-actions">
          <button type="button" data-edit-route="${route.id}">Edit Route</button>
          <button type="button" data-delete-route="${route.id}" class="secondary-button">Delete</button>
        </div>
      </article>
    `);
  const staffCards = state.db.staff.map((staff) => `
      <article class="admin-card">
        <div class="admin-card-head">
          <div><h4>${staff.name}</h4><p class="muted">${staff.role}</p></div>
          <span class="pill">${staff.role}</span>
        </div>
        <div class="card-actions">
          <button type="button" data-edit-staff="${staff.id}">Edit Staff</button>
          <button type="button" data-delete-staff="${staff.id}" class="secondary-button">Delete</button>
        </div>
      </article>
    `);
  const templateCards = state.db.scheduleTemplates.map((template) => {
      const route = getRoute(template.routeId);
      const bus = getBus(template.busId);
      return `
        <article class="admin-card">
          <div class="admin-card-head">
            <div><h4>${template.name}</h4><p class="muted">${route ? `${route.origin} -> ${route.destination}` : "No route"} | ${bus ? bus.plateNumber : "No bus"}</p></div>
            <span class="pill">Template</span>
          </div>
          <p class="muted">${template.departureTime || "--:--"} - ${template.arrivalTime || "--:--"} | ${formatCurrency(template.fare || 0)}</p>
          <div class="card-actions">
            <button type="button" data-apply-template="${template.id}">Apply Template</button>
            <button type="button" data-delete-template="${template.id}" class="secondary-button">Delete</button>
          </div>
        </article>
      `;
    });

  const buildResourceSection = (title, items, emptyText) => `
    <section class="resource-section">
      <div class="resource-section-head">
        <h4>${title}</h4>
        <span class="pill">${items.length}</span>
      </div>
      <div class="resource-section-grid">
        ${items.length ? items.join("") : `<div class="empty-state">${emptyText}</div>`}
      </div>
    </section>
  `;

  const resourceMarkup = [
    buildResourceSection("Buses", busCards, "No buses yet."),
    buildResourceSection("Routes", routeCards, "No routes yet."),
    buildResourceSection("Staff", staffCards, "No staff records yet."),
    buildResourceSection("Templates", templateCards, "No schedule templates yet."),
  ];

  $("adminResources").innerHTML = resourceMarkup.length
    ? resourceMarkup.join("")
    : `<div class="empty-state">No buses or routes yet. Add your first records here.</div>`;

  $("adminBookings").innerHTML = state.db.bookings.length ? [...state.db.bookings]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((booking) => {
      const ticket = getTicketByBooking(booking.id);
      return `
        <article class="admin-card">
          <div class="admin-card-head">
            <div><h4>${booking.passengerName}</h4><p class="muted">${booking.origin} -> ${booking.destination}</p></div>
            <span class="pill">${formatCurrency(booking.totalFare)}</span>
          </div>
          <p class="muted">Seats: ${booking.seatNumbers.join(", ")} | Ticket: ${ticket ? ticket.ticketCode : "Pending"} | Status: <span class="inline-pill ${getBookingStatusClass(booking.status)}">${booking.status}</span></p>
          <p class="muted">Payment: <span class="inline-pill ${getPaymentStatusClass(booking.paymentStatus || "Unpaid")}">${booking.paymentStatus || "Unpaid"}</span> | Method: ${booking.paymentMethod || "Not set"}${booking.paymentReference ? ` | Ref: ${booking.paymentReference}` : ""}</p>
          <p class="muted">Boarding: <span class="inline-pill ${getBoardingStatusClass(booking.boardingStatus || "Awaiting Boarding")}">${booking.boardingStatus || "Awaiting Boarding"}</span></p>
          <div class="card-actions">
            <button type="button" data-confirm-booking="${booking.id}" ${booking.status === "Confirmed" ? "disabled" : ""}>${booking.status === "Confirmed" ? "Confirmed" : "Confirm Booking"}</button>
            <button type="button" data-toggle-booking-status="${booking.id}">${booking.status === "Cancelled" ? "Restore Booking" : "Cancel Booking"}</button>
            <button type="button" data-delete-booking="${booking.id}" class="secondary-button">Delete Booking</button>
          </div>
        </article>
      `;
    }).join("") : `<div class="empty-state">No bookings yet.</div>`;

  if ($("adminAuditLog")) {
    $("adminAuditLog").className = state.db.auditLogs.length ? "admin-list" : "admin-list empty-state";
    $("adminAuditLog").innerHTML = state.db.auditLogs.length
      ? state.db.auditLogs.map((log) => `
        <article class="admin-card">
          <div class="admin-card-head">
            <div>
              <h4>${escapeHtml(log.action)}</h4>
              <p class="muted">${escapeHtml(log.adminName)} | ${escapeHtml(formatDisplayDateTime(log.createdAt))}</p>
            </div>
            <span class="pill">${escapeHtml(log.adminName)}</span>
          </div>
          <p class="muted">${escapeHtml(log.details)}</p>
        </article>
      `).join("")
      : "Admin actions will appear here after updates are made.";
  }
}

function renderAdminSeatMap() {
  const seatMap = $("adminSeatMap");
  const summary = $("adminSeatSummary");
  if (!seatMap || !summary) return;
  if (!state.selectedAdminScheduleId) {
    seatMap.className = "seat-map empty-state";
    seatMap.textContent = "Select a schedule to manage seat availability.";
    summary.textContent = "";
    return;
  }

  const schedule = getSchedule(state.selectedAdminScheduleId);
  if (!schedule) {
    seatMap.className = "seat-map empty-state";
    seatMap.textContent = "Select a schedule to manage seat availability.";
    summary.textContent = "";
    return;
  }

  const bus = getBus(schedule.busId);
  const route = getRoute(schedule.routeId);
  if (!bus || !route) {
    seatMap.className = "seat-map empty-state";
    seatMap.textContent = "This schedule is missing its route or bus assignment.";
    summary.textContent = "";
    return;
  }
  const seats = state.db.seats.filter((seat) => seat.busId === bus.id);
  const counts = seats.reduce((accumulator, seat) => {
    const status = getSeatStatus(schedule.id, seat.seatNumber);
    accumulator[status] += 1;
    return accumulator;
  }, { available: 0, reserved: 0, occupied: 0 });

  seatMap.className = "seat-map bus-layout";
  seatMap.innerHTML = seats.map((seat, index) => {
    const status = getSeatStatus(schedule.id, seat.seatNumber);
    const cell = `<button class="seat ${status}" type="button" data-admin-seat="${seat.seatNumber}" ${status === "occupied" ? "disabled" : ""}>${seat.label}</button>`;
    return index % 4 === 1 ? `${cell}<div class="aisle">A</div>` : cell;
  }).join("");

  summary.innerHTML = `
    <strong>${route.origin} -> ${route.destination}</strong><br />
    ${schedule.date} | ${schedule.departureTime} - ${schedule.arrivalTime}<br />
    Available: ${counts.available} | Reserved: ${counts.reserved} | Occupied: ${counts.occupied}
  `;
}

function hydratePassengerForm() {
  const bookingForm = $("bookingForm");
  if (!bookingForm) return;
  const passengerNameInput = bookingForm.querySelector('[name="passengerName"]');
  const contactInput = bookingForm.querySelector('[name="contactNumber"]');
  if (state.session && state.session.role === "user") {
    const passenger = state.db.passengers.find((item) => item.id === state.session.id);
    if (passenger) {
      passengerNameInput.value = passenger.name;
      contactInput.value = passenger.contact;
    }
  }
}

function refreshUi() {
  renderSession();
  updateAdminAccessUi();
  updateScheduleFormStatus();
  renderScheduleConflictHelper();
  renderHero();
  populateSelectOptions();
  renderRoutes();
  renderScheduleResults();
  renderSeatMap();
  renderBookingSummary();
  renderHistory();
  renderAdmin();
  renderManifest();
  renderTicketLookup();
  hydratePassengerForm();
  renderPaymentHelper();
  renderPrintableTicket(state.printBookingId);
  if (pageMode === "admin") {
    setActiveAdminPanel(state.activeAdminPanel || "adminOverview");
  }
  if (pageMode === "admin" && (!state.session || state.session.role !== "admin")) {
    showToast("Log in as admin to manage this window.");
  }
}

function resetBookingSelection() {
  state.selectedScheduleId = null;
  state.selectedSeats = [];
}

function handleBookingSearch(formData) {
  state.bookingSearch = {
    passengerName: formData.get("passengerName").trim(),
    contactNumber: formData.get("contactNumber").trim(),
    travelDate: formData.get("travelDate"),
    origin: formData.get("origin"),
    destination: formData.get("destination"),
    busId: formData.get("busId"),
    passengerCount: Number(formData.get("passengerCount")),
  };

  if (state.bookingSearch.origin === state.bookingSearch.destination) {
    showToast("Origin and destination must be different.");
    return;
  }

  resetBookingSelection();
  renderScheduleResults();
  renderSeatMap();
  renderBookingSummary();
  renderPaymentHelper();
}

function selectSchedule(scheduleId) {
  state.selectedScheduleId = scheduleId;
  state.selectedSeats = [];
  renderScheduleResults();
  renderSeatMap();
  renderBookingSummary();
  renderPaymentHelper();
}

function toggleSeatSelection(seatNumber) {
  if (!state.selectedScheduleId || !state.bookingSearch) return;
  const maxSeats = state.bookingSearch.passengerCount;
  if (state.selectedSeats.includes(seatNumber)) {
    state.selectedSeats = state.selectedSeats.filter((seat) => seat !== seatNumber);
  } else {
    if (state.selectedSeats.length >= maxSeats) {
      showToast(`You can select up to ${maxSeats} seat(s) for this booking.`);
      return;
    }
    if (getSeatStatus(state.selectedScheduleId, seatNumber) !== "available") {
      showToast("That seat is no longer available.");
      return;
    }
    state.selectedSeats.push(seatNumber);
  }
  renderSeatMap();
  renderBookingSummary();
  renderPaymentHelper();
}

async function reloadAndRender() {
  await loadAppData();
  refreshUi();
}

async function finalizeMutation(reason) {
  announceDataChange(reason);
  await reloadAndRender();
  await pushSnapshotToServer();
}

async function createBooking(payload) {
  const db = await openDatabase();
  const transaction = db.transaction(["bookings", "tickets", "seatStates"], "readwrite");
  const bookingsStore = transaction.objectStore("bookings");
  const ticketsStore = transaction.objectStore("tickets");
  const seatStatesStore = transaction.objectStore("seatStates");

  const bookings = await requestToPromise(bookingsStore.getAll());
  const seatStates = await requestToPromise(seatStatesStore.getAll());
  const occupied = bookings.filter((booking) => booking.scheduleId === payload.scheduleId).flatMap((booking) => booking.seatNumbers);
  const reserved = seatStates
    .filter((seatState) => seatState.scheduleId === payload.scheduleId && seatState.status === "reserved")
    .map((seatState) => seatState.seatNumber);

  if (payload.seatNumbers.some((seat) => occupied.includes(seat) || reserved.includes(seat))) {
    transaction.abort();
    throw new Error("One or more seats are no longer available.");
  }

  const bookingId = uid();
  const createdAt = new Date().toISOString();
  const booking = {
    id: bookingId,
    ...payload,
    status: "Pending",
    createdAt,
  };
  const ticket = {
    id: uid(),
    bookingId,
    ticketCode: `TP-${Math.floor(100000 + Math.random() * 899999)}`,
    issuedAt: new Date().toISOString(),
    printableUrl: "#print-ticket",
  };

  bookingsStore.add(booking);
  ticketsStore.add(ticket);

  await transactionDone(transaction);
  return { booking, ticket };
}

async function confirmBooking() {
  if (!requireUserAction()) return;
  if (!state.bookingSearch || !state.selectedScheduleId) {
    showToast("Select a schedule before confirming a booking.");
    return;
  }
  if (state.selectedSeats.length !== state.bookingSearch.passengerCount) {
    showToast("Select the exact number of seats required for the booking.");
    return;
  }
  const payment = getPaymentDetails();
  if (!payment.paymentMethod) {
    showToast("Choose a payment method first.");
    return;
  }

  const schedule = getSchedule(state.selectedScheduleId);
  const route = getRoute(schedule.routeId);
  const fare = getDestinationFare(route, schedule, state.bookingSearch.destination);
  const paymentCode = `PAY-${Math.floor(100000 + Math.random() * 899999)}`;
  const receipt = await createBooking({
    userId: state.session.id,
    passengerName: state.bookingSearch.passengerName,
    contactNumber: state.bookingSearch.contactNumber,
    travelDate: state.bookingSearch.travelDate,
    origin: state.bookingSearch.origin,
    destination: state.bookingSearch.destination,
    passengerCount: state.bookingSearch.passengerCount,
    scheduleId: state.selectedScheduleId,
    seatNumbers: [...state.selectedSeats],
    totalFare: fare * state.selectedSeats.length,
    boardingStatus: "Awaiting Boarding",
    paymentMethod: payment.paymentMethod,
    paymentReference: payment.paymentReference || paymentCode,
    paymentStatus: "Paid",
    paidAt: new Date().toISOString(),
  });

  await finalizeMutation("confirm-booking");
  state.lastReceipt = receipt;
  state.printBookingId = receipt.booking.id;
  if ($("paymentMethodSelect")) $("paymentMethodSelect").value = "";
  if ($("paymentReferenceInput")) $("paymentReferenceInput").value = "";
  renderPaymentHelper();
  showToast(`Payment received. Booking submitted for admin confirmation. Ticket code: ${receipt.ticket.ticketCode}`);
  setActiveView("historyView");
  return receipt;
}

function printLatestTicket(bookingId = null, options = {}) {
  const bundle = getBookingTicketBundle(bookingId);
  if (!bundle) {
    showToast("No ticket available for printing.");
    return;
  }
  state.printBookingId = bundle.booking.id;
  renderPrintableTicket(bundle.booking.id, options);
  window.print();
}

async function loginUser(formData) {
  const contact = String(formData.get("contact") || "").replace(/\s+/g, "");
  const password = formData.get("password");
  const payload = await postJson("/api/auth/login", { contact, password });
  await pullSnapshotFromServer(true);
  const user = payload.user;
  state.session = { id: user.id, name: user.name, role: "user" };
  saveSession();
  refreshUi();
  showToast(`Welcome back, ${user.name}.`);
  if (pageMode === "auth") {
    const passengerWindow = window.open("app", "_blank", "noopener");
    if (passengerWindow) {
      showToast("Passenger login successful. Passenger system opened.");
    } else {
      showToast("Passenger login successful. Open /app manually if the popup was blocked.");
    }
  }
}

async function registerUser(formData, form) {
  const normalizedContact = String(formData.get("contact") || "").replace(/\s+/g, "");
  await postJson("/api/auth/register", {
    name: formData.get("name").trim(),
    contact: normalizedContact,
    password: formData.get("password"),
  });
  await pullSnapshotFromServer(true);
  refreshUi();
  form.reset();
  showToast("Passenger account created. You can now log in.");
}

async function loginAdmin(formData) {
  const username = String(formData.get("username") || "").trim();
  const password = formData.get("password");
  const payload = await postJson("/api/auth/admin-login", { username, password });
  await pullSnapshotFromServer(true);
  const admin = payload.admin;
  state.session = { id: admin.id, name: admin.fullName, role: "admin" };
  saveSession();
  refreshUi();
  if (pageMode === "admin") {
    showToast(payload.created ? "First admin account created." : "Admin dashboard unlocked.");
    return;
  }

  const adminWindow = window.open("admin.html", "_blank", "noopener");
  if (adminWindow) {
    showToast(payload.created ? "First admin account created. Admin window opened." : "Admin dashboard unlocked in a new window.");
  } else {
    showToast(payload.created ? "First admin created. Open admin.html manually." : "Admin login succeeded. Popup blocked, so open admin.html manually.");
  }
}

function logout() {
  state.session = null;
  saveSession();
  if (pageMode === "admin" || pageMode === "main") {
    window.location.href = "login";
    return;
  }
  if (pageMode === "auth") {
    window.location.href = "login";
    return;
  }
  refreshUi();
  showToast("Session closed.");
}

async function saveSchedule(formData, form) {
  if (!state.session || state.session.role !== "admin") {
    showToast("Admin access is required.");
    return;
  }
  if (!state.db.routes.length) {
    throw new Error("Add a route before creating a schedule.");
  }
  if (!state.db.buses.length) {
    throw new Error("Add a bus before creating a schedule.");
  }

  const db = await openDatabase();
  const transaction = db.transaction("schedules", "readwrite");
  const store = transaction.objectStore("schedules");
  const scheduleId = formData.get("scheduleId") || uid();
  const routeId = formData.get("routeId");
  const busId = formData.get("busId");
  const date = formData.get("date");
  const additionalDatesValue = formData.get("additionalDates");
  const dateBatchMode = formData.get("dateBatchMode") || "single";
  const editScope = formData.get("editScope") || "single";
  const departureTime = formData.get("departureTime");
  const arrivalTime = formData.get("arrivalTime");
  const fare = Number(formData.get("fare") || 0);
  const route = getRoute(routeId);
  const bus = getBus(busId);
  const stopFares = parseStopFares(formData.get("stopFares"));
  const driverName = String(formData.get("driverName") || "").trim();
  const conductorName = String(formData.get("conductorName") || "").trim();
  const isEditing = Boolean(formData.get("scheduleId"));
  const scheduleDates = parseScheduleDates(date, additionalDatesValue, dateBatchMode, isEditing);

  if (!date || !departureTime || !arrivalTime) {
    throw new Error("Date, departure time, and arrival time are required.");
  }
  if (!Number.isFinite(fare) || fare < 0) {
    throw new Error("Fare must be a valid number.");
  }
  if (!route) {
    throw new Error("Choose a valid route for this schedule.");
  }
  if (!bus) {
    throw new Error("Choose a valid bus for this schedule.");
  }
  if (bus.status === "Under Maintenance" || bus.status === "Unavailable") {
    throw new Error(`This bus is ${bus.status.toLowerCase()} and cannot be scheduled.`);
  }
  Object.keys(stopFares).forEach((stop) => {
    if (!getRouteStops(route).includes(stop)) {
      throw new Error(`Stop fare "${stop}" must also appear in the selected route's Via / Stops.`);
    }
  });

  const targetSchedules = isEditing && editScope === "busMonth"
    ? state.db.schedules
      .filter((schedule) => schedule.busId === busId && String(schedule.date || "").slice(0, 7) === String(date || "").slice(0, 7))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    : null;

  const scheduleTargets = targetSchedules?.length
    ? targetSchedules.map((schedule) => ({ id: schedule.id, date: schedule.date }))
    : scheduleDates.map((scheduleDate, index) => ({
      id: isEditing && index === 0 ? scheduleId : uid(),
      date: scheduleDate,
    }));

  scheduleTargets.forEach((target) => {
    const recordId = target.id;
    const scheduleDate = target.date;
    const existingSchedules = state.db.schedules.filter(
      (schedule) => schedule.busId === busId && schedule.date === scheduleDate && schedule.id !== recordId
    );
    const hasExactDuplicate = existingSchedules.some((schedule) =>
      schedule.departureTime === departureTime && schedule.arrivalTime === arrivalTime
    );

    if (hasExactDuplicate) {
      throw new Error(`This bus already has a schedule with the same departure and arrival time on ${scheduleDate}.`);
    }

    store.put({
      id: recordId,
      routeId,
      busId,
      date: scheduleDate,
      departureTime,
      arrivalTime,
      fare,
      stopFares,
      driverName,
      conductorName,
      status: "On Time",
    });
  });

  await transactionDone(transaction);
  await logAuditAction(
    isEditing ? "Schedule Updated" : "Schedule Created",
    `${scheduleTargets.map((item) => item.date).join(", ")} ${departureTime}-${arrivalTime} | Fare ${formatCurrency(fare)}${Object.keys(stopFares).length ? ` | Stop fares: ${Object.keys(stopFares).length}` : ""}${isEditing && editScope === "busMonth" ? " | Applied to selected bus for the month" : ""}`
  );
  await finalizeMutation("save-schedule");
  if (form) {
    form.reset();
    const scheduleIdInput = form.querySelector('[name="scheduleId"]');
    if (scheduleIdInput) scheduleIdInput.value = "";
  }
  if ($("scheduleBusFilter")) $("scheduleBusFilter").value = busId || "all";
  updateScheduleFormStatus();
  renderScheduleConflictHelper();
  renderAdmin();
  showToast(
    isEditing
      ? (editScope === "busMonth"
        ? `Updated ${scheduleTargets.length} schedules for this bus in the selected month.`
        : "Schedule updated.")
      : `Schedule added for ${scheduleDates.length} date${scheduleDates.length === 1 ? "" : "s"}.`
  );
}

function resetScheduleForm() {
  const form = $("scheduleForm");
  if (!form) return;
  form.reset();
  const scheduleIdInput = form.querySelector('[name="scheduleId"]');
  if (scheduleIdInput) scheduleIdInput.value = "";
  if ($("scheduleBusFilter")) $("scheduleBusFilter").value = "all";
  updateScheduleFormStatus();
  renderScheduleConflictHelper();
  renderAdmin();
  showToast("Schedule form cleared. The next save will create a new schedule.");
}

function editSchedule(scheduleId) {
  const schedule = getSchedule(scheduleId);
  if (!schedule) return;
  const form = $("scheduleForm");
  form.querySelector('[name="scheduleId"]').value = schedule.id;
  form.querySelector('[name="routeId"]').value = schedule.routeId;
  form.querySelector('[name="busId"]').value = schedule.busId;
  form.querySelector('[name="date"]').value = schedule.date;
  if ($("scheduleBusFilter")) $("scheduleBusFilter").value = schedule.busId || "all";
  const additionalDatesInput = form.querySelector('[name="additionalDates"]');
  if (additionalDatesInput) additionalDatesInput.value = "";
  const dateBatchModeInput = form.querySelector('[name="dateBatchMode"]');
  if (dateBatchModeInput) dateBatchModeInput.value = "single";
  const editScopeInput = form.querySelector('[name="editScope"]');
  if (editScopeInput) editScopeInput.value = "single";
  form.querySelector('[name="departureTime"]').value = schedule.departureTime;
  form.querySelector('[name="arrivalTime"]').value = schedule.arrivalTime;
  const fareInput = form.querySelector('[name="fare"]');
  if (fareInput) fareInput.value = schedule.fare !== undefined ? schedule.fare : 0;
  const stopFaresInput = form.querySelector('[name="stopFares"]');
  if (stopFaresInput) {
    stopFaresInput.value = Object.entries(getScheduleStopFares(schedule)).map(([stop, fare]) => `${stop}:${fare}`).join(", ");
  }
  const driverInput = form.querySelector('[name="driverName"]');
  if (driverInput) driverInput.value = schedule.driverName || "";
  const conductorInput = form.querySelector('[name="conductorName"]');
  if (conductorInput) conductorInput.value = schedule.conductorName || "";
  const templateInput = form.querySelector('[name="templateId"]');
  if (templateInput) templateInput.value = "";
  updateScheduleFormStatus();
  renderScheduleConflictHelper();
  renderAdmin();
  showToast("Schedule loaded for editing.");
}

async function deleteSchedule(scheduleId) {
  if (state.db.bookings.some((booking) => booking.scheduleId === scheduleId)) {
    throw new Error("Cannot delete a schedule with existing bookings.");
  }

  const db = await openDatabase();
  const transaction = db.transaction(["schedules", "seatStates"], "readwrite");
  transaction.objectStore("schedules").delete(scheduleId);

  const seatStatesStore = transaction.objectStore("seatStates");
  const seatStates = await requestToPromise(seatStatesStore.getAll());
  seatStates
    .filter((seatState) => seatState.scheduleId === scheduleId)
    .forEach((seatState) => seatStatesStore.delete(seatState.id));

  await transactionDone(transaction);
  await logAuditAction("Schedule Deleted", `Removed schedule ${scheduleId}`);
  await finalizeMutation("delete-schedule");
  if (state.selectedAdminScheduleId === scheduleId) {
    state.selectedAdminScheduleId = null;
  }
  showToast("Schedule deleted.");
}

async function deleteAllSchedules() {
  if (!state.session || state.session.role !== "admin") {
    throw new Error("Admin access is required.");
  }
  if (!state.db.schedules.length) {
    showToast("There are no schedules to delete.");
    return;
  }

  const db = await openDatabase();
  const transaction = db.transaction(["schedules", "seatStates"], "readwrite");
  const schedulesStore = transaction.objectStore("schedules");
  const seatStatesStore = transaction.objectStore("seatStates");
  const schedules = await requestToPromise(schedulesStore.getAll());
  const seatStates = await requestToPromise(seatStatesStore.getAll());

  schedules.forEach((schedule) => schedulesStore.delete(schedule.id));
  seatStates.forEach((seatState) => seatStatesStore.delete(seatState.id));

  await transactionDone(transaction);
  await logAuditAction("Schedules Cleared", `Deleted ${schedules.length} schedules and ${seatStates.length} seat holds. Existing bookings were kept.`);
  state.selectedAdminScheduleId = null;
  state.selectedManifestScheduleId = null;
  await finalizeMutation("delete-all-schedules");
  resetScheduleForm();
  showToast(`Deleted ${schedules.length} schedules.`);
}

async function deleteSchedulesByBus(busId) {
  if (!state.session || state.session.role !== "admin") {
    throw new Error("Admin access is required.");
  }

  const targetSchedules = state.db.schedules.filter((schedule) => schedule.busId === busId);
  if (!targetSchedules.length) {
    showToast("There are no schedules for this bus.");
    return;
  }

  const targetScheduleIds = new Set(targetSchedules.map((schedule) => schedule.id));
  const bus = getBus(busId);
  const db = await openDatabase();
  const transaction = db.transaction(["schedules", "seatStates"], "readwrite");
  const schedulesStore = transaction.objectStore("schedules");
  const seatStatesStore = transaction.objectStore("seatStates");
  const seatStates = await requestToPromise(seatStatesStore.getAll());

  targetSchedules.forEach((schedule) => schedulesStore.delete(schedule.id));
  seatStates
    .filter((seatState) => targetScheduleIds.has(seatState.scheduleId))
    .forEach((seatState) => seatStatesStore.delete(seatState.id));

  await transactionDone(transaction);
  await logAuditAction(
    "Bus Schedules Cleared",
    `${bus ? bus.plateNumber : busId} | Deleted ${targetSchedules.length} schedules and related seat holds.`
  );

  if (targetScheduleIds.has(state.selectedAdminScheduleId)) {
    state.selectedAdminScheduleId = null;
  }
  if (targetScheduleIds.has(state.selectedManifestScheduleId)) {
    state.selectedManifestScheduleId = null;
  }

  await finalizeMutation("delete-bus-schedules");
  if ($("scheduleBusFilter")) $("scheduleBusFilter").value = busId || "all";
  showToast(`Deleted ${targetSchedules.length} schedules for ${bus ? bus.plateNumber : "the selected bus"}.`);
}

async function saveBus(formData, form) {
  const busId = formData.get("busId");
  const plateNumber = getRequiredFormValue(formData, "plateNumber", "Plate number");
  const busType = getRequiredFormValue(formData, "busType", "Bus type");
  const capacityValue = getRequiredFormValue(formData, "capacity", "Capacity");
  const capacity = Number(capacityValue);
  if (!Number.isFinite(capacity) || capacity < 1) {
    throw new Error("Capacity must be a valid number.");
  }

  const payload = {
    id: busId || uid(),
    plateNumber: plateNumber.toUpperCase(),
    busType,
    capacity,
    status: String(formData.get("status") || "Active"),
  };

  const existingBus = busId ? getBus(busId) : null;
  if (existingBus && existingBus.capacity !== payload.capacity) {
    const hasBookings = state.db.bookings.some((booking) => {
      const schedule = getSchedule(booking.scheduleId);
      return schedule && schedule.busId === busId;
    });
    if (hasBookings) {
      throw new Error("Cannot change capacity for a bus that already has bookings.");
    }
  }

  const db = await openDatabase();
  const transaction = db.transaction(["buses", "seats"], "readwrite");
  transaction.objectStore("buses").put(payload);

  if (!existingBus || existingBus.capacity !== payload.capacity) {
    const seatsStore = transaction.objectStore("seats");
    const seats = await requestToPromise(seatsStore.getAll());
    seats.filter((seat) => seat.busId === payload.id).forEach((seat) => seatsStore.delete(seat.id));

    for (let seat = 1; seat <= payload.capacity; seat += 1) {
      const seatNumber = `S${String(seat).padStart(2, "0")}`;
      seatsStore.add({
        id: uid(),
        busId: payload.id,
        seatNumber,
        rowNumber: Math.ceil(seat / 4),
        label: String(seat).padStart(2, "0"),
      });
    }
  }

  await transactionDone(transaction);
  await logAuditAction(busId ? "Bus Updated" : "Bus Created", `${payload.plateNumber} | ${payload.busType} | ${payload.capacity} seats`);
  await finalizeMutation("save-bus");
  if (form) form.reset();
  showToast(busId ? "Bus updated." : "Bus added to fleet.");
}

async function saveStaff(formData, form) {
  const staffId = formData.get("staffId");
  const name = getRequiredFormValue(formData, "name", "Staff name");
  const role = getRequiredFormValue(formData, "role", "Staff role");
  const db = await openDatabase();
  const transaction = db.transaction("staff", "readwrite");
  transaction.objectStore("staff").put({
    id: staffId || uid(),
    name,
    role,
    createdAt: new Date().toISOString(),
  });
  await transactionDone(transaction);
  await finalizeMutation("save-staff");
  if (form) form.reset();
  showToast(`${role} saved.`);
}

function editStaff(staffId) {
  const staff = state.db.staff.find((item) => item.id === staffId);
  const form = $("staffForm");
  if (!staff || !form) return;
  form.querySelector('[name="staffId"]').value = staff.id;
  form.querySelector('[name="name"]').value = staff.name;
  form.querySelector('[name="role"]').value = staff.role;
  showToast("Staff loaded for editing.");
}

async function deleteStaff(staffId) {
  const staff = state.db.staff.find((item) => item.id === staffId);
  if (!staff) return;
  const db = await openDatabase();
  const transaction = db.transaction("staff", "readwrite");
  transaction.objectStore("staff").delete(staffId);
  await transactionDone(transaction);
  await finalizeMutation("delete-staff");
  showToast("Staff deleted.");
}

async function saveScheduleTemplate() {
  const form = $("scheduleForm");
  if (!form) return;
  const formData = new FormData(form);
  const routeId = formData.get("routeId");
  const busId = formData.get("busId");
  if (!routeId || !busId) {
    throw new Error("Choose a route and bus before saving a template.");
  }
  const bus = getBus(busId);
  const route = getRoute(routeId);
  const db = await openDatabase();
  const transaction = db.transaction("scheduleTemplates", "readwrite");
  transaction.objectStore("scheduleTemplates").put({
    id: uid(),
    name: `${bus ? bus.plateNumber : "Bus"} | ${route ? `${route.origin} -> ${route.destination}` : "Route"}`,
    routeId,
    busId,
    departureTime: formData.get("departureTime"),
    arrivalTime: formData.get("arrivalTime"),
    fare: Number(formData.get("fare") || 0),
    stopFares: parseStopFares(formData.get("stopFares")),
    driverName: String(formData.get("driverName") || "").trim(),
    conductorName: String(formData.get("conductorName") || "").trim(),
    createdAt: new Date().toISOString(),
  });
  await transactionDone(transaction);
  await finalizeMutation("save-template");
  showToast("Schedule template saved.");
}

async function deleteScheduleTemplate(templateId) {
  const db = await openDatabase();
  const transaction = db.transaction("scheduleTemplates", "readwrite");
  transaction.objectStore("scheduleTemplates").delete(templateId);
  await transactionDone(transaction);
  await finalizeMutation("delete-template");
  showToast("Template deleted.");
}

function applyScheduleTemplate(templateId) {
  const template = getTemplate(templateId);
  const form = $("scheduleForm");
  if (!template || !form) return;
  form.querySelector('[name="routeId"]').value = template.routeId || "";
  form.querySelector('[name="busId"]').value = template.busId || "";
  form.querySelector('[name="departureTime"]').value = template.departureTime || "";
  form.querySelector('[name="arrivalTime"]').value = template.arrivalTime || "";
  form.querySelector('[name="fare"]').value = template.fare ?? 0;
  const stopFaresInput = form.querySelector('[name="stopFares"]');
  if (stopFaresInput) {
    stopFaresInput.value = Object.entries(template.stopFares || {}).map(([stop, fare]) => `${stop}:${fare}`).join(", ");
  }
  const driverInput = form.querySelector('[name="driverName"]');
  if (driverInput) driverInput.value = template.driverName || "";
  const conductorInput = form.querySelector('[name="conductorName"]');
  if (conductorInput) conductorInput.value = template.conductorName || "";
  renderScheduleConflictHelper();
  showToast("Schedule template applied.");
}

async function saveRoute(formData, form) {
  const routeId = formData.get("routeId");
  const origin = getRequiredFormValue(formData, "origin", "Origin");
  const destination = getRequiredFormValue(formData, "destination", "Destination");
  const stops = normalizeStops(formData.get("stops"));
  const distanceKmValue = getRequiredFormValue(formData, "distanceKm", "Distance");
  const travelHoursValue = getRequiredFormValue(formData, "travelHours", "Travel hours");
  const travelMinutesValue = getRequiredFormValue(formData, "travelMinutes", "Travel minutes");
  const distanceKm = Number(distanceKmValue);
  const travelHours = Number(travelHoursValue);
  const travelMinutes = Number(travelMinutesValue);

  if (!Number.isFinite(distanceKm) || distanceKm < 1) {
    throw new Error("Distance must be a valid number.");
  }
  if (!Number.isFinite(travelHours) || travelHours < 1) {
    throw new Error("Travel hours must be a valid number.");
  }
  if (!Number.isFinite(travelMinutes) || travelMinutes < 0 || travelMinutes > 59) {
    throw new Error("Travel minutes must be between 0 and 59.");
  }
  if (origin.toLowerCase() === destination.toLowerCase()) {
    throw new Error("Origin and destination must be different.");
  }
  if (stops.some((stop) => stop.toLowerCase() === origin.toLowerCase())) {
    throw new Error("A stop cannot be the same as the origin.");
  }
  if (stops.some((stop) => stop.toLowerCase() === destination.toLowerCase())) {
    throw new Error("A stop cannot be the same as the final destination.");
  }

  const db = await openDatabase();
  const transaction = db.transaction("routes", "readwrite");

  transaction.objectStore("routes").put({
    id: routeId || uid(),
    origin,
    destination,
    stops,
    distanceKm,
    travelHours,
    travelMinutes,
  });

  await transactionDone(transaction);
  await logAuditAction(routeId ? "Route Updated" : "Route Created", `${origin} -> ${destination}${stops.length ? ` via ${stops.join(", ")}` : ""}`);
  await finalizeMutation("save-route");
  if (form) form.reset();
  showToast(routeId ? "Route updated." : "Route added successfully.");
}

function editBus(busId) {
  const bus = getBus(busId);
  if (!bus) return;
  const form = $("busForm");
  form.querySelector('[name="busId"]').value = bus.id;
  form.querySelector('[name="plateNumber"]').value = bus.plateNumber;
  form.querySelector('[name="busType"]').value = bus.busType;
  form.querySelector('[name="capacity"]').value = bus.capacity;
  const statusInput = form.querySelector('[name="status"]');
  if (statusInput) statusInput.value = bus.status || "Active";
  showToast("Bus loaded for editing.");
}

async function deleteBus(busId) {
  const inUse = state.db.schedules.some((schedule) => schedule.busId === busId);
  if (inUse) {
    throw new Error("Cannot delete a bus assigned to an existing schedule.");
  }

  const bus = getBus(busId);
  const db = await openDatabase();
  const transaction = db.transaction(["buses", "seats"], "readwrite");
  transaction.objectStore("buses").delete(busId);

  const seatsStore = transaction.objectStore("seats");
  const seats = await requestToPromise(seatsStore.getAll());
  seats.filter((seat) => seat.busId === busId).forEach((seat) => seatsStore.delete(seat.id));

  await transactionDone(transaction);
  if (bus) {
    await logAuditAction("Bus Deleted", `${bus.plateNumber} | ${bus.busType}`);
  }
  await finalizeMutation("delete-bus");
  showToast("Bus removed from fleet.");
}

function editRoute(routeId) {
  const route = getRoute(routeId);
  if (!route) return;
  const form = $("routeForm");
  form.querySelector('[name="routeId"]').value = route.id;
  form.querySelector('[name="origin"]').value = route.origin;
  form.querySelector('[name="destination"]').value = route.destination;
  const stopsInput = form.querySelector('[name="stops"]');
  if (stopsInput) stopsInput.value = getRouteStops(route).join(", ");
  form.querySelector('[name="distanceKm"]').value = route.distanceKm;
  form.querySelector('[name="travelHours"]').value = route.travelHours;
  form.querySelector('[name="travelMinutes"]').value = route.travelMinutes ?? 0;
  showToast("Route loaded for editing.");
}

async function deleteRoute(routeId) {
  const inUse = state.db.schedules.some((schedule) => schedule.routeId === routeId);
  if (inUse) {
    throw new Error("Cannot delete a route assigned to an existing schedule.");
  }

  const route = getRoute(routeId);
  const db = await openDatabase();
  const transaction = db.transaction("routes", "readwrite");
  transaction.objectStore("routes").delete(routeId);
  await transactionDone(transaction);
  if (route) {
    await logAuditAction("Route Deleted", `${route.origin} -> ${route.destination}`);
  }
  await finalizeMutation("delete-route");
  showToast("Route deleted.");
}

async function toggleAdminSeat(seatNumber) {
  if (!state.selectedAdminScheduleId) return;
  const currentStatus = getSeatStatus(state.selectedAdminScheduleId, seatNumber);
  if (currentStatus === "occupied") {
    showToast("Booked seats cannot be changed.");
    return;
  }

  const db = await openDatabase();
  const transaction = db.transaction("seatStates", "readwrite");
  const store = transaction.objectStore("seatStates");
  const seatStates = await requestToPromise(store.getAll());
  const current = seatStates.find(
    (seatState) => seatState.scheduleId === state.selectedAdminScheduleId && seatState.seatNumber === seatNumber
  );

  if (currentStatus === "reserved" && current) {
    store.delete(current.id);
  } else {
    store.put({
      id: current ? current.id : uid(),
      scheduleId: state.selectedAdminScheduleId,
      seatNumber,
      status: "reserved",
      updatedAt: new Date().toISOString(),
    });
  }

  await transactionDone(transaction);
  await finalizeMutation("toggle-seat");
  showToast(currentStatus === "reserved" ? "Seat released for booking." : "Seat reserved by admin.");
}

async function toggleBookingStatus(bookingId) {
  const booking = state.db.bookings.find((item) => item.id === bookingId);
  if (!booking) {
    throw new Error("Booking not found.");
  }
  const nextStatus = booking.status === "Cancelled" ? "Confirmed" : "Cancelled";

  const db = await openDatabase();
  const transaction = db.transaction("bookings", "readwrite");
  transaction.objectStore("bookings").put({
    ...booking,
    status: nextStatus,
  });
  await transactionDone(transaction);
  await logAuditAction(nextStatus === "Cancelled" ? "Booking Cancelled" : "Booking Restored", `${booking.passengerName} | ${booking.origin} -> ${booking.destination}`);
  await finalizeMutation("toggle-booking-status");
  showToast(nextStatus === "Cancelled" ? "Booking cancelled." : "Booking restored.");
}

async function confirmBookingByAdmin(bookingId) {
  const booking = state.db.bookings.find((item) => item.id === bookingId);
  if (!booking) {
    throw new Error("Booking not found.");
  }
  if (booking.status === "Confirmed") {
    showToast("Booking is already confirmed.");
    return;
  }

  const db = await openDatabase();
  const transaction = db.transaction("bookings", "readwrite");
  transaction.objectStore("bookings").put({
    ...booking,
    status: "Confirmed",
  });
  await transactionDone(transaction);
  await logAuditAction("Booking Confirmed", `${booking.passengerName} | ${booking.origin} -> ${booking.destination}`);
  await finalizeMutation("confirm-booking");
  showToast("Booking confirmed by admin.");
}

async function deleteBooking(bookingId) {
  const booking = state.db.bookings.find((item) => item.id === bookingId);
  const ticket = getTicketByBooking(bookingId);
  const db = await openDatabase();
  const transaction = db.transaction(["bookings", "tickets"], "readwrite");
  transaction.objectStore("bookings").delete(bookingId);
  if (ticket) {
    transaction.objectStore("tickets").delete(ticket.id);
  }
  await transactionDone(transaction);
  if (booking) {
    await logAuditAction("Booking Deleted", `${booking.passengerName} | ${booking.origin} -> ${booking.destination}`);
  }
  await finalizeMutation("delete-booking");
  showToast("Booking deleted.");
}

async function updateBoardingStatus(bookingId, boardingStatus) {
  if (!state.session || state.session.role !== "admin") {
    throw new Error("Admin access is required.");
  }
  const booking = state.db.bookings.find((item) => item.id === bookingId);
  if (!booking) {
    throw new Error("Booking not found.");
  }

  const db = await openDatabase();
  const transaction = db.transaction("bookings", "readwrite");
  transaction.objectStore("bookings").put({
    ...booking,
    boardingStatus,
  });
  await transactionDone(transaction);
  await logAuditAction("Boarding Status Updated", `${booking.passengerName} set to ${boardingStatus}`);
  await finalizeMutation("boarding-status");
  showToast(`Passenger marked as ${boardingStatus}.`);
}

function attachEvents() {
  document.querySelectorAll("button.nav-link[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.view === "adminView" && (!state.session || state.session.role !== "admin")) {
        showToast("Please sign in as admin to access the dashboard.");
        return;
      }
      setActiveView(button.dataset.view);
    });
  });

  document.querySelectorAll(".admin-panel-link").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveAdminPanel(button.dataset.adminPanel);
    });
  });

  if ($("routeSearch")) $("routeSearch").addEventListener("input", renderRoutes);
  if ($("routeFilterType")) $("routeFilterType").addEventListener("change", renderRoutes);

  if ($("bookingForm")) {
    $("bookingForm").addEventListener("submit", (event) => {
      event.preventDefault();
      handleBookingSearch(new FormData(event.currentTarget));
    });
  }

  if ($("scheduleResults")) {
    $("scheduleResults").addEventListener("click", (event) => {
      const trigger = event.target.closest(".select-schedule-btn");
      if (trigger) selectSchedule(trigger.dataset.schedule);
    });
  }

  if ($("seatMap")) {
    $("seatMap").addEventListener("click", (event) => {
      const seat = event.target.closest("[data-seat]");
      if (seat) toggleSeatSelection(seat.dataset.seat);
    });
  }

  if ($("confirmBookingBtn")) {
    $("confirmBookingBtn").addEventListener("click", openPaymentModal);
  }
  if ($("printTicketBtn")) $("printTicketBtn").addEventListener("click", printLatestTicket);
  if ($("completePaymentBtn")) {
    $("completePaymentBtn").addEventListener("click", () => {
      const action = $("completePaymentBtn").dataset.action || "complete";
      if (action === "done") {
        closePaymentModal();
        return;
      }
      confirmBooking()
        .then((receipt) => showPaymentReceipt(receipt))
        .catch((error) => showToast(error.message));
    });
  }
  if ($("closePaymentModalBtn")) $("closePaymentModalBtn").addEventListener("click", closePaymentModal);
  if ($("cancelPaymentModalBtn")) {
    $("cancelPaymentModalBtn").addEventListener("click", () => {
      const action = $("cancelPaymentModalBtn").dataset.action || "back";
      if (action === "print" && state.lastReceipt) {
        printLatestTicket(state.lastReceipt.booking.id, { label: "Official Payment Receipt", receipt: true });
        return;
      }
      closePaymentModal();
    });
  }
  if ($("paymentModalBackdrop")) {
    $("paymentModalBackdrop").addEventListener("click", (event) => {
      if (event.target.id === "paymentModalBackdrop") closePaymentModal();
    });
  }
  if ($("paymentMethodSelect")) {
    $("paymentMethodSelect").addEventListener("change", () => {
      renderBookingSummary();
      renderPaymentHelper();
    });
  }
  if ($("paymentReferenceInput")) {
    $("paymentReferenceInput").addEventListener("input", () => {
      renderPaymentHelper();
    });
  }
  if ($("historyTable")) {
    $("historyTable").addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-print-booking]");
      if (trigger) {
        printLatestTicket(trigger.dataset.printBooking, { label: "Passenger E-Ticket" });
      }
    });
  }
  if ($("manifestScheduleSelect")) {
    $("manifestScheduleSelect").addEventListener("change", (event) => {
      state.selectedManifestScheduleId = event.target.value;
      renderManifest();
    });
  }
  if ($("printManifestBtn")) $("printManifestBtn").addEventListener("click", printManifest);
  if ($("ticketLookupBtn")) $("ticketLookupBtn").addEventListener("click", renderTicketLookup);
  if ($("ticketLookupInput")) {
    $("ticketLookupInput").addEventListener("input", renderTicketLookup);
    $("ticketLookupInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        renderTicketLookup();
      }
    });
  }
  if ($("exportCsvBtn")) $("exportCsvBtn").addEventListener("click", exportCsvReport);
  if ($("exportPdfBtn")) $("exportPdfBtn").addEventListener("click", exportPdfReport);
  if ($("exportBackupBtn")) $("exportBackupBtn").addEventListener("click", exportJsonBackup);
  if ($("syncServerNowBtn")) {
    $("syncServerNowBtn").addEventListener("click", () => {
      syncLocalDataToServer().catch((error) => showToast(error.message || "Unable to sync local data."));
    });
  }
  if ($("importBackupBtn") && $("backupImportInput")) {
    $("importBackupBtn").addEventListener("click", () => $("backupImportInput").click());
    $("backupImportInput").addEventListener("change", (event) => {
      const [file] = event.currentTarget.files || [];
      importJsonBackup(file)
        .catch((error) => showToast(error.message || "Unable to restore backup."))
        .finally(() => {
          event.currentTarget.value = "";
        });
    });
  }
  ["reportStartDate", "reportEndDate", "reportRouteFilter", "reportBusFilter", "reportStatusFilter", "reportPaymentFilter"].forEach((id) => {
    const element = $(id);
    if (element) {
      element.addEventListener("change", () => {
        syncReportFiltersFromUi();
        renderAdmin();
      });
    }
  });
  if ($("verifyTicketBtn")) $("verifyTicketBtn").addEventListener("click", verifyTicketCode);
  if ($("verifyTicketCodeInput")) {
    $("verifyTicketCodeInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        verifyTicketCode();
      }
    });
  }

  if ($("userLoginForm")) {
    $("userLoginForm").addEventListener("submit", (event) => {
      event.preventDefault();
      loginUser(new FormData(event.currentTarget)).catch((error) => showToast(error.message));
    });
  }
  if ($("registerForm")) {
    $("registerForm").addEventListener("submit", (event) => {
      event.preventDefault();
      registerUser(new FormData(event.currentTarget), event.currentTarget).catch((error) => showToast(error.message));
    });
  }
  if ($("adminLoginForm")) {
    $("adminLoginForm").addEventListener("submit", (event) => {
      event.preventDefault();
      loginAdmin(new FormData(event.currentTarget)).catch((error) => showToast(error.message));
    });
  }
  if ($("syncServerBtn")) {
    $("syncServerBtn").addEventListener("click", () => {
      syncLocalDataToServer().catch((error) => showToast(error.message || "Unable to sync local data."));
    });
  }
  if ($("logoutBtn")) $("logoutBtn").addEventListener("click", logout);

  if ($("scheduleForm")) {
    $("scheduleForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveSchedule(new FormData(event.currentTarget), event.currentTarget).catch((error) => showToast(error.message));
    });
    ["routeId", "busId", "date", "departureTime", "arrivalTime"].forEach((fieldName) => {
      const field = $("scheduleForm").querySelector(`[name="${fieldName}"]`);
      if (field) {
        field.addEventListener("input", renderScheduleConflictHelper);
        field.addEventListener("change", renderScheduleConflictHelper);
      }
    });
  }
  if ($("resetScheduleFormBtn")) {
    $("resetScheduleFormBtn").addEventListener("click", resetScheduleForm);
  }
  if ($("saveTemplateBtn")) {
    $("saveTemplateBtn").addEventListener("click", () => {
      saveScheduleTemplate().catch((error) => showToast(error.message));
    });
  }
  if ($("scheduleTemplateSelect")) {
    $("scheduleTemplateSelect").addEventListener("change", (event) => {
      applyScheduleTemplate(event.target.value);
    });
  }
  if ($("scheduleBusFilter")) {
    $("scheduleBusFilter").addEventListener("change", renderAdmin);
  }
  if ($("scheduleTypeFilter")) {
    $("scheduleTypeFilter").addEventListener("change", () => {
      if ($("scheduleBusFilter")) $("scheduleBusFilter").value = "all";
      renderAdmin();
    });
  }
  if ($("scheduleTypeQuickbar")) {
    $("scheduleTypeQuickbar").addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-schedule-type]");
      if (!trigger) return;
      if ($("scheduleTypeFilter")) $("scheduleTypeFilter").value = trigger.dataset.scheduleType || "all";
      if ($("scheduleBusFilter")) $("scheduleBusFilter").value = "all";
      renderAdmin();
    });
  }
  if ($("scheduleSearchFilter")) {
    $("scheduleSearchFilter").addEventListener("input", renderAdmin);
  }
  if ($("scheduleMonthFilter")) {
    $("scheduleMonthFilter").addEventListener("change", renderAdmin);
  }
  if ($("scheduleDayFilter")) {
    $("scheduleDayFilter").addEventListener("change", renderAdmin);
  }
  if ($("clearSchedulesBtn")) {
    $("clearSchedulesBtn").addEventListener("click", () => {
      deleteAllSchedules().catch((error) => showToast(error.message));
    });
  }

  if ($("adminSchedules")) {
    $("adminSchedules").addEventListener("click", (event) => {
      const edit = event.target.closest(".edit-schedule-btn");
      const remove = event.target.closest(".delete-schedule-btn");
      const removeBusSchedules = event.target.closest("[data-delete-bus-schedules]");
      if (edit) editSchedule(edit.dataset.editSchedule);
      if (remove) deleteSchedule(remove.dataset.deleteSchedule).catch((error) => showToast(error.message));
      if (removeBusSchedules) {
        deleteSchedulesByBus(removeBusSchedules.dataset.deleteBusSchedules).catch((error) => showToast(error.message));
      }
    });
  }

  if ($("seatScheduleSelect")) {
    $("seatScheduleSelect").addEventListener("change", (event) => {
      state.selectedAdminScheduleId = event.target.value;
      renderAdminSeatMap();
    });
  }

  if ($("adminSeatMap")) {
    $("adminSeatMap").addEventListener("click", (event) => {
      const seat = event.target.closest("[data-admin-seat]");
      if (seat) toggleAdminSeat(seat.dataset.adminSeat).catch((error) => showToast(error.message));
    });
  }

  if ($("busForm")) {
    $("busForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveBus(new FormData(event.currentTarget), event.currentTarget).catch((error) => showToast(error.message));
    });
  }
  if ($("staffForm")) {
    $("staffForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveStaff(new FormData(event.currentTarget), event.currentTarget).catch((error) => showToast(error.message));
    });
  }
  if ($("routeForm")) {
    $("routeForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveRoute(new FormData(event.currentTarget), event.currentTarget).catch((error) => showToast(error.message));
    });
  }

  if ($("adminResources")) {
    $("adminResources").addEventListener("click", (event) => {
      const editBusTrigger = event.target.closest("[data-edit-bus]");
      const deleteBusTrigger = event.target.closest("[data-delete-bus]");
      const editRouteTrigger = event.target.closest("[data-edit-route]");
      const deleteRouteTrigger = event.target.closest("[data-delete-route]");
      const editStaffTrigger = event.target.closest("[data-edit-staff]");
      const deleteStaffTrigger = event.target.closest("[data-delete-staff]");
      const applyTemplateTrigger = event.target.closest("[data-apply-template]");
      const deleteTemplateTrigger = event.target.closest("[data-delete-template]");

      if (editBusTrigger) editBus(editBusTrigger.dataset.editBus);
      if (deleteBusTrigger) deleteBus(deleteBusTrigger.dataset.deleteBus).catch((error) => showToast(error.message));
      if (editRouteTrigger) editRoute(editRouteTrigger.dataset.editRoute);
      if (deleteRouteTrigger) deleteRoute(deleteRouteTrigger.dataset.deleteRoute).catch((error) => showToast(error.message));
      if (editStaffTrigger) editStaff(editStaffTrigger.dataset.editStaff);
      if (deleteStaffTrigger) deleteStaff(deleteStaffTrigger.dataset.deleteStaff).catch((error) => showToast(error.message));
      if (applyTemplateTrigger) applyScheduleTemplate(applyTemplateTrigger.dataset.applyTemplate);
      if (deleteTemplateTrigger) deleteScheduleTemplate(deleteTemplateTrigger.dataset.deleteTemplate).catch((error) => showToast(error.message));
    });
  }

  if ($("adminBookings")) {
    $("adminBookings").addEventListener("click", (event) => {
      const confirmTrigger = event.target.closest("[data-confirm-booking]");
      const toggleTrigger = event.target.closest("[data-toggle-booking-status]");
      const deleteTrigger = event.target.closest("[data-delete-booking]");
      const boardingTrigger = event.target.closest("[data-boarding-status]");

      if (confirmTrigger) confirmBookingByAdmin(confirmTrigger.dataset.confirmBooking).catch((error) => showToast(error.message));
      if (toggleTrigger) toggleBookingStatus(toggleTrigger.dataset.toggleBookingStatus).catch((error) => showToast(error.message));
      if (deleteTrigger) deleteBooking(deleteTrigger.dataset.deleteBooking).catch((error) => showToast(error.message));
      if (boardingTrigger) {
        const [bookingId, status] = boardingTrigger.dataset.boardingStatus.split(":");
        updateBoardingStatus(bookingId, status).catch((error) => showToast(error.message));
      }
    });
  }
  if ($("manifestTable")) {
    $("manifestTable").addEventListener("click", (event) => {
      const boardingTrigger = event.target.closest("[data-boarding-status]");
      if (boardingTrigger) {
        const [bookingId, status] = boardingTrigger.dataset.boardingStatus.split(":");
        updateBoardingStatus(bookingId, status).catch((error) => showToast(error.message));
      }
    });
  }
  if ($("ticketLookupResults")) {
    $("ticketLookupResults").addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-print-booking]");
      if (trigger) {
        printLatestTicket(trigger.dataset.printBooking, { label: "Ticket Lookup Printout" });
      }
    });
  }

  if (syncChannel) {
    syncChannel.onmessage = (event) => {
      if (event.data?.type === "refresh" && event.data.pageMode !== pageMode) {
        pullSnapshotFromServer(true)
          .then(() => refreshUi())
          .catch((error) => console.error(error));
      }
      if (event.data?.type === "session" && event.data.pageMode !== pageMode) {
        state.session = loadSession();
        refreshUi();
      }
    };
  }

  window.addEventListener("storage", (event) => {
    if (event.key === SESSION_KEY) {
      state.session = loadSession();
      refreshUi();
    }
  });
}

async function init() {
  if (!("indexedDB" in window)) {
    throw new Error("This browser does not support IndexedDB.");
  }

  await loadAppData();
  const syncResult = await pullSnapshotFromServer(true);
  if ((syncResult?.remoteRecordCount || 0) === 0) {
    const localRecordCount = getRecordCount(state.db);
    if (localRecordCount > 0) {
      await pushSnapshotToServer();
    }
  }
  attachEvents();
  refreshUi();
  window.setInterval(() => {
    pullSnapshotFromServer()
      .then(() => refreshUi())
      .catch((error) => console.error(error));
  }, 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      pullSnapshotFromServer()
        .then(() => refreshUi())
        .catch((error) => console.error(error));
    }
  });
  const bookingForm = $("bookingForm");
  if (bookingForm) {
    const earliestSchedule = [...state.db.schedules].sort((a, b) => a.date.localeCompare(b.date))[0];
    bookingForm.querySelector('[name="travelDate"]').value =
      earliestSchedule ? earliestSchedule.date : new Date().toISOString().slice(0, 10);
  }
}

init().catch((error) => {
  console.error(error);
  showToast(error.message || "Unable to initialize the app.");
});
