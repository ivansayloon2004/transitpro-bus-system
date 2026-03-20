CREATE TABLE meta (
  id TEXT PRIMARY KEY,
  value TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE passengers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE admin_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  full_name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE buses (
  id TEXT PRIMARY KEY,
  plate_number TEXT NOT NULL UNIQUE,
  bus_type TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  fare INTEGER NOT NULL,
  distance_km INTEGER NOT NULL,
  travel_hours INTEGER NOT NULL,
  bus_type TEXT NOT NULL
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  bus_id TEXT NOT NULL,
  travel_date TEXT NOT NULL,
  departure_time TEXT NOT NULL,
  arrival_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'On Time',
  FOREIGN KEY (route_id) REFERENCES routes(id),
  FOREIGN KEY (bus_id) REFERENCES buses(id)
);

CREATE TABLE seats (
  id TEXT PRIMARY KEY,
  bus_id TEXT NOT NULL,
  seat_number TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  seat_label TEXT NOT NULL,
  UNIQUE (bus_id, seat_number),
  FOREIGN KEY (bus_id) REFERENCES buses(id)
);

CREATE TABLE seat_states (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  seat_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available', 'reserved')),
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (schedule_id, seat_number),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  passenger_id TEXT NOT NULL,
  passenger_name TEXT NOT NULL,
  contact_number TEXT NOT NULL,
  travel_date TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  passenger_count INTEGER NOT NULL,
  schedule_id TEXT NOT NULL,
  seat_numbers TEXT NOT NULL,
  total_fare INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Confirmed',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (passenger_id) REFERENCES passengers(id),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id)
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE,
  ticket_code TEXT NOT NULL UNIQUE,
  issued_at TEXT DEFAULT CURRENT_TIMESTAMP,
  printable_url TEXT,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);
